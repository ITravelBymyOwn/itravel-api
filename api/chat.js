// /api/chat.js — v50 (ESM, Vercel)
// Doble etapa: (1) INFO (decide + horarios + sub-paradas) → (2) PLANNER (estructura/valida).
// Respuestas SIEMPRE como { text: "<JSON|texto>" }.
// ⚠️ Sin lógica del Info Chat EXTERNO (vive en /api/info-public.js).
//
// v50 — Objetivo:
// - Blindar formato "Destino – Sub-parada" y completar from/to sin inventar POIs (derivado del mismo activity).
// - Auroras: solo nocturnas, no consecutivas, nunca último día.
// - Day-trips: 1 solo día, 5–8 sub-paradas, incluye "Regreso a {base}".
// - Comidas: opcionales (NO obligatorias aunque preferences.alwaysIncludeDinner sea true).
// - Performance: menos tokens + menos retries + postprocesos locales baratos.

import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ===================== Config ===================== */
const MODEL = "gpt-4o-mini";

// Reducimos tokens para bajar latencia (el Planner UI sufre si el modelo se alarga)
const MAX_TOKENS_INFO = 2600;
const MAX_TOKENS_PLANNER = 2000;

// Temperaturas más bajas para estabilidad (menos divagación)
const TEMP_INFO = 0.25;
const TEMP_PLANNER = 0.20;

/* ============== Utilidades comunes ============== */
function parseBody(reqBody) {
  if (!reqBody) return {};
  if (typeof reqBody === "string") {
    try {
      return JSON.parse(reqBody);
    } catch {
      return {};
    }
  }
  return reqBody;
}

function extractMessages(body = {}) {
  const { messages, input, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;
  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";
  return [...prev, { role: "user", content: userText }];
}

// Limpia y extrae un único JSON de un texto (tolerante a prólogos/epílogos)
function cleanToJSONPlus(raw = "") {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;

  // 1) Intento directo
  try {
    return JSON.parse(raw);
  } catch {}

  // 2) Primer/último { }
  try {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(raw.slice(first, last + 1));
  } catch {}

  // 3) Recorte de ruido
  try {
    const cleaned = raw.replace(/^[^{]+/, "").replace(/[^}]+$/, "");
    return JSON.parse(cleaned);
  } catch {}

  return null;
}

function fallbackJSON() {
  return {
    destination: "Desconocido",
    rows: [
      {
        day: 1,
        start: "",
        end: "",
        activity: "Fallback – Planificación pendiente (Día 1)",
        from: "",
        to: "",
        transport: "",
        duration: "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat",
        notes: "⚠️ No se pudo generar. Revisa OPENAI_API_KEY / despliegue.",
        kind: "",
        zone: "",
      },
    ],
    followup: "⚠️ Fallback local: revisa OPENAI_API_KEY o despliegue.",
  };
}

// Llamada unificada a Responses API (entrada como string consolidado)
async function callText(messages, temperature = 0.25, max_output_tokens = 2000) {
  const inputStr = messages
    .map((m) => {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${String(m.role || "user").toUpperCase()}: ${c}`;
    })
    .join("\n\n");

  const resp = await client.responses.create({
    model: MODEL,
    temperature,
    max_output_tokens,
    input: inputStr,
  });

  return resp?.output_text?.trim() || resp?.output?.[0]?.content?.[0]?.text?.trim() || "";
}

/* ============== Normalización ligera (barata) ============== */

// Normalizador de duraciones dentro del JSON ya parseado
function normalizeDurationsInParsed(parsed) {
  if (!parsed) return parsed;

  const norm = (txt) => {
    const s = String(txt ?? "").trim();
    if (!s) return s;

    // Si viene en formato "Transporte: ...\nActividad: ...", lo dejamos intacto.
    if (/^Transporte\s*:/i.test(s) || /^Actividad\s*:/i.test(s)) return s;

    // No tocamos si empieza con "~"
    if (/^~\s*\d+(\.\d+)?\s*h$/i.test(s)) return s;

    // 1.5h → 1h30m
    const dh = s.match(/^(\d+(?:\.\d+)?)\s*h$/i);
    if (dh) {
      const hours = parseFloat(dh[1]);
      const total = Math.round(hours * 60);
      const h = Math.floor(total / 60);
      const m = total % 60;
      return h > 0 ? (m > 0 ? `${h}h${m}m` : `${h}h`) : `${m}m`;
    }

    // 1h30 ó 1 h 30 → 1h30m
    const hMix = s.match(/^(\d+)\s*h\s*(\d{1,2})$/i);
    if (hMix) return `${hMix[1]}h${hMix[2]}m`;

    // 90m → 90m
    if (/^\d+\s*m$/i.test(s)) return s;

    // 2h → 2h
    if (/^\d+\s*h$/i.test(s)) return s;

    return s;
  };

  const touchRows = (rows = []) => rows.map((r) => ({ ...r, duration: norm(r.duration) }));

  try {
    if (Array.isArray(parsed.rows)) parsed.rows = touchRows(parsed.rows);
    if (Array.isArray(parsed.rows_draft)) parsed.rows_draft = touchRows(parsed.rows_draft);
    if (Array.isArray(parsed.destinations)) {
      parsed.destinations = parsed.destinations.map((d) => ({
        ...d,
        rows: Array.isArray(d.rows) ? touchRows(d.rows) : d.rows,
      }));
    }
    if (Array.isArray(parsed.itineraries)) {
      parsed.itineraries = parsed.itineraries.map((it) => ({
        ...it,
        rows: Array.isArray(it.rows) ? touchRows(it.rows) : it.rows,
      }));
    }
  } catch {}

  return parsed;
}

/* =========================================================
   🧠 Blindaje local: activity "Destino – Sub-parada" + from/to
   (SIN inventar POIs: se deriva del texto ya generado)
   ========================================================= */

function _normDash_(s) {
  // Normaliza separadores comunes a " – " (en dash con espacios)
  // Aceptamos: " - ", "–", "—"
  return String(s || "")
    .replace(/\s*[-—]\s*/g, " – ")
    .replace(/\s*–\s*/g, " – ")
    .replace(/\s+/g, " ")
    .trim();
}

function _splitActivity_(activity) {
  const a = _normDash_(activity);
  const parts = a.split(" – ").map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const left = parts[0];
    const right = parts.slice(1).join(" – "); // conserva sub-sub si existe
    return { left, right, hasDash: true, normalized: `${left} – ${right}` };
  }
  return { left: "", right: a, hasDash: false, normalized: a };
}

function _looksLikeAurora_(s) {
  return /auroras?|aurora\b|northern\s*lights/i.test(String(s || ""));
}

function _looksLikeMacroTour_(s) {
  return /golden\s*circle|círculo\s*dorado|circulo\s*dorado|day\s*trip|excursion|tour\b|ring\s*road/i.test(
    String(s || "").toLowerCase()
  );
}

// Si no hay day_hours, asumimos días completos (regla del producto)
function _assumeFullDays_(context) {
  const dh = context?.day_hours;
  if (Array.isArray(dh) && dh.length) return false;
  return true;
}

function _postProcessRowsDraft_(parsed, context) {
  try {
    if (!parsed || !Array.isArray(parsed.rows_draft)) return parsed;

    const city = String(context?.city || parsed?.destination || "Destino").trim() || "Destino";

    parsed.rows_draft = parsed.rows_draft.map((r) => {
      const out = { ...r };

      // Normaliza activity dash
      const actRaw = String(out.activity || "").trim();
      const actNorm = _normDash_(actRaw);

      // Si no trae dash, lo convertimos a "{city} – {actividad}" (urbano) o "{Tour} – {sub}" si se detecta macro
      // Nota: NO inventamos POIs: solo re-etiquetamos el mismo texto.
      let finalActivity = actNorm;
      const split = _splitActivity_(actNorm);

      if (!split.hasDash) {
        // Caso auroras
        if (_looksLikeAurora_(actNorm)) {
          finalActivity = `Auroras – ${actNorm}`; // mantiene texto original como sub
        } else if (_looksLikeMacroTour_(actNorm)) {
          // Si ya menciona Golden Circle / tour, lo ponemos como "Tour – Sub-parada"
          // Ej: "Golden Circle - Thingvellir National Park" ya tendría dash; si no, lo envolvemos
          finalActivity = `Tour – ${actNorm}`;
        } else {
          finalActivity = `${city} – ${actNorm}`;
        }
      } else {
        finalActivity = split.normalized;
      }

      out.activity = finalActivity;

      // Completar from/to sin inventar: derivado de activity
      const sp = _splitActivity_(finalActivity);
      if (!String(out.from || "").trim()) out.from = sp.left || city;
      if (!String(out.to || "").trim()) out.to = sp.right || "";

      // Transport vacío en out-of-town => default seguro
      if (!String(out.transport || "").trim()) {
        if (_looksLikeMacroTour_(finalActivity) || /regreso/i.test(finalActivity)) {
          out.transport = "Vehículo alquilado o Tour guiado";
        } else {
          out.transport = "A pie";
        }
      }

      // duration: si no cumple 2 líneas, lo forzamos (sin inventar tiempos: usa "Verificar")
      const dur = String(out.duration || "");
      const has2 = /Transporte\s*:\s*.*\nActividad\s*:\s*/i.test(dur);
      if (!has2) {
        out.duration =
          "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat";
      }

      // Normaliza kind/zone vacíos a "" (consistencia)
      out.kind = String(out.kind || "");
      out.zone = String(out.zone || "");

      return out;
    });

    return parsed;
  } catch {
    return parsed;
  }
}

/* ============== Quality Gate ============== */

function _canonTxt_(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _isGenericPlaceholderActivity_(activity) {
  const t = _canonTxt_(activity);
  if (!t) return true;

  const bad = [
    "museo de arte",
    "parque local",
    "cafe local",
    "restaurante local",
    "exploracion de la costa",
    "exploracion de la ciudad",
    "paseo por la ciudad",
    "recorrido por la ciudad",
    "museos y cultura",
    "museos cultura",
    "exploracion de reykjavik",
  ];

  if (t.length <= 10 && /^(museo|parque|cafe|restaurante|plaza|mercado)$/i.test(t)) return true;
  if (bad.some((b) => t === b || t.includes(b))) return true;
  if (/^(museo|parque|cafe|restaurante)\b/i.test(t) && t.split(" ").length <= 3) return true;

  return false;
}

function _hasTwoLineDuration_(duration) {
  const s = String(duration || "");
  return /Transporte\s*:\s*.*\nActividad\s*:\s*/i.test(s);
}

function _rowsHaveCoverage_(rows, daysTotal) {
  if (!Array.isArray(rows) || !rows.length) return false;
  const need = Math.max(1, Number(daysTotal) || 1);
  const present = new Set(rows.map((r) => Number(r.day) || 1));
  for (let d = 1; d <= need; d++) if (!present.has(d)) return false;
  return true;
}

function _countRowsPerDay_(rows, daysTotal) {
  const need = Math.max(1, Number(daysTotal) || 1);
  const counts = Array.from({ length: need }, () => 0);
  rows.forEach((r) => {
    const d = Math.max(1, Number(r?.day) || 1);
    if (d >= 1 && d <= need) counts[d - 1] += 1;
  });
  return counts;
}

function _timeToMin_(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function _validateInfoResearch_(parsed, contextHint = {}) {
  const issues = [];
  const daysTotal = Math.max(1, Number(parsed?.days_total || contextHint?.days_total || 1));
  const rows = Array.isArray(parsed?.rows_draft) ? parsed.rows_draft : [];

  if (!rows.length) issues.push("rows_draft vacío o ausente (obligatorio).");
  if (rows.length && !_rowsHaveCoverage_(rows, daysTotal)) issues.push("rows_draft no cubre todos los días 1..days_total.");

  // Requiere duration 2 líneas
  if (rows.length && rows.some((r) => !_hasTwoLineDuration_(r.duration))) {
    issues.push('duration no cumple formato 2 líneas ("Transporte" + "Actividad") en una o más filas.');
  }

  // Prohibir genéricos
  if (rows.length && rows.some((r) => _isGenericPlaceholderActivity_(r.activity))) {
    issues.push("hay placeholders genéricos en activity (ej. museos/cultura genérico).");
  }

  // CRÍTICO: activity debe venir en formato "X – Y" (destino/sub-parada)
  const noDash = rows.filter((r) => !_splitActivity_(r.activity).hasDash);
  if (noDash.length) issues.push('activity sin formato "Destino – Sub-parada" en una o más filas.');

  // from/to no vacíos (porque el UI depende de columnas)
  const emptyFT = rows.filter((r) => !String(r.from || "").trim() || !String(r.to || "").trim());
  if (emptyFT.length) issues.push("from/to vacíos en una o más filas.");

  // Asumir días completos si no hay day_hours: pedir mínimo densidad por día
  if (contextHint?.assume_full_days) {
    const counts = _countRowsPerDay_(rows, daysTotal);
    // mínimo 3 filas por día para evitar “días vacíos” (sin inventar: fuerza a INFO a desglosar)
    counts.forEach((c, idx) => {
      if (c < 3) issues.push(`día ${idx + 1} tiene muy pocas filas (${c}); falta desglose por sub-paradas.`);
    });
  }

  /* ===== Guard semántico — AURORAS ===== */
  const auroraRows = rows.filter((r) => _looksLikeAurora_(r.activity));
  const auroraDays = auroraRows.map((r) => Number(r.day)).sort((a, b) => a - b);

  for (let i = 1; i < auroraDays.length; i++) {
    if (auroraDays[i] === auroraDays[i - 1] + 1) {
      issues.push("auroras programadas en días consecutivos (no permitido).");
      break;
    }
  }

  if (auroraDays.includes(daysTotal)) issues.push("auroras programadas en el último día (no permitido).");

  // Auroras deben ser nocturnas (inicio >= 18:00). Permitimos que terminen después de medianoche.
  auroraRows.forEach((r) => {
    const s = _timeToMin_(r.start);
    if (s != null && s < 18 * 60) issues.push(`auroras con horario no nocturno (día ${r.day} start=${r.start}).`);
  });

  /* ===== Guard semántico — MACRO-TOURS en un solo día ===== */
  // Canoniza macro key
  const macroCanon = (s) =>
    String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/–.*$/, "")
      .trim();

  const macroDays = {};
  rows.forEach((r) => {
    const key = macroCanon(r.activity);
    if (_looksLikeMacroTour_(key)) {
      macroDays[key] = macroDays[key] || new Set();
      macroDays[key].add(Number(r.day));
    }
  });

  Object.entries(macroDays).forEach(([k, days]) => {
    if (days.size > 1) issues.push(`macro-tour "${k}" repartido en múltiples días (${[...days].join(", ")}).`);
  });

  // Si hay macro-tour, exigir 5–8 sub-paradas en ese día + "Regreso a {base}" al cierre.
  const base = String(contextHint?.city || parsed?.destination || "la ciudad").trim();
  const tourDayCandidates = new Set();
  rows.forEach((r) => {
    if (_looksLikeMacroTour_(r.activity)) tourDayCandidates.add(Number(r.day));
  });

  tourDayCandidates.forEach((d) => {
    const dayRows = rows.filter((r) => Number(r.day) === d);
    const tourRows = dayRows.filter((r) => _looksLikeMacroTour_(r.activity) || /regreso/i.test(String(r.activity || "")));
    // Heurística: si aparece macro en el día, esperamos desglose real
    if (tourRows.length < 5) issues.push(`day-trip en día ${d} con pocas sub-paradas (${tourRows.length}); debe ser 5–8.`);
    const last = dayRows[dayRows.length - 1]?.activity || "";
    if (!/regreso/i.test(String(last))) issues.push(`day-trip día ${d} no cierra con "Regreso a ${base}".`);
  });

  return { ok: issues.length === 0, issues };
}

/* ============== ✅ QUIRÚRGICO v43.6.1: Sanitizador de day_hours entrante ============== */
function _sanitizeIncomingDayHours_(day_hours, daysTotal) {
  try {
    if (!Array.isArray(day_hours) || !day_hours.length) return null;

    const need = Math.max(1, Number(daysTotal) || day_hours.length || 1);

    const norm = (t) => String(t || "").trim();
    const cleaned = day_hours.map((d, idx) => ({
      day: Number(d?.day) || idx + 1,
      start: norm(d?.start) || "",
      end: norm(d?.end) || "",
    }));

    const hasAny = cleaned.some((d) => d.start || d.end);
    if (!hasAny) return null;

    if (cleaned.length === need) {
      const allHave = cleaned.every((d) => d.start && d.end);
      if (allHave) {
        const s0 = cleaned[0].start;
        const e0 = cleaned[0].end;
        const allSame = cleaned.every((d) => d.start === s0 && d.end === e0);
        if (allSame) return null;
      }
    }

    return cleaned;
  } catch {
    return null;
  }
}

/* ============== ✅ FIX QUIRÚRGICO: evitar crash en planner por función faltante ============== */
function _validatePlannerOutput_(parsed) {
  try {
    const issues = [];
    const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    if (!rows.length) issues.push("rows vacío o ausente (obligatorio).");

    if (rows.length) {
      if (rows.some((r) => !_hasTwoLineDuration_(r?.duration))) {
        issues.push('duration no cumple formato 2 líneas ("Transporte" + "Actividad") en una o más filas.');
      }
      if (rows.some((r) => _isGenericPlaceholderActivity_(r?.activity))) {
        issues.push("hay placeholders genéricos en activity (ej. museos/cultura genérico).");
      }
      if (rows.some((r) => Number(r?.day) < 1 || !Number.isFinite(Number(r?.day)))) {
        issues.push("hay filas con 'day' inválido (<1 o no numérico).");
      }
      if (rows.some((r) => !_splitActivity_(r?.activity).hasDash)) {
        issues.push('activity sin formato "Destino – Sub-parada" en una o más filas.');
      }
      if (rows.some((r) => !String(r?.from || "").trim() || !String(r?.to || "").trim())) {
        issues.push("from/to vacíos en una o más filas.");
      }

      // Auroras: start >= 18:00
      rows
        .filter((r) => _looksLikeAurora_(r.activity))
        .forEach((r) => {
          const s = _timeToMin_(r.start);
          if (s != null && s < 18 * 60) issues.push(`auroras con horario no nocturno (día ${r.day} start=${r.start}).`);
        });
    }

    return { ok: issues.length === 0, issues };
  } catch {
    return { ok: true, issues: [] };
  }
}

/* ============== Prompts del sistema ============== */

/* =======================
   SISTEMA — INFO CHAT (interno)
   ======================= */
const SYSTEM_INFO = `
Eres el **Info Chat interno** de ITravelByMyOwn: un **experto mundial en turismo** con criterio premium.
Tu objetivo es devolver un plan **impactante, optimizado, realista y secuencial**.
Tu salida será consumida por un Planner que **NO inventa**: solo estructura y renderiza lo que tú decidas.

SALIDA: devuelves **UN ÚNICO JSON VÁLIDO** (sin texto fuera) listo para tabla.

ARQUITECTURA:
- Tú (INFO) eres la **fuente de verdad**: debes generar start/end por fila en rows_draft.
- El Planner solo corrige solapes pequeños y formatea; NO crea contenido nuevo.

REGLA CRÍTICA — FORMATO DE ACTIVIDAD (OBLIGATORIO):
- Cada fila en rows_draft debe tener activity en formato EXACTO:
  "**Destino – Sub-parada**" (usa "–" como separador).
  Ejemplos:
  "Reykjavik – Hallgrímskirkja"
  "Círculo Dorado – Thingvellir"
  "Auroras – Observación (zona oscura)"
- Además, cada fila debe traer from y to (NO vacíos).
  - from debe coincidir con el bloque/área (Destino/Tour/Zona) y to con la sub-parada.

DÍAS COMPLETOS SI NO HAY HORAS:
- Si el usuario NO define day_hours, asume días completos y produce un itinerario “llenito” y usable:
  mínimo ~3–6 filas por día (no 1 fila genérica).
- NO inventes una plantilla rígida repetida (prohibido 08:30–19:00 fijo).
  Genera horarios realistas por filas según ritmo + temporada.

COMIDAS (NO PRIORITARIAS):
- NO son obligatorias, aunque el contexto traiga preferences.alwaysIncludeDinner=true.
- Inclúyelas solo si aportan valor real (icónico/logística/pausa) y sin convertir el itinerario en “restaurantes”.
- Si no aportan, déjalas fuera (meals_suggestions puede ser []).

DAY-TRIPS / MACRO-TOURS (CRÍTICO):
- Si incluyes un day-trip fuerte, ese día queda dedicado al tour.
- Debe tener 5–8 sub-paradas con activity "Tour/Zona – Sub-parada".
- Incluye explícitamente al cierre una fila: "**Regreso a {ciudad base}**" (en activity con formato):
  "{Tour/Zona} – Regreso a Reykjavik" o "Reykjavik – Regreso al hotel" según corresponda.
- No colocar day-trips duros el último día.
- NO repartir el mismo macro-tour en múltiples días.

AURORAS (SOLO SI ES PLAUSIBLE):
- Valida plausibilidad por latitud y época del año.
- Si es plausible:
  - máximo 1 por día
  - NO consecutivas
  - NUNCA en el último día
  - HORARIO NOCTURNO: start >= 18:00 (puede cruzar medianoche)
  - transport coherente: si no estás seguro usa "Vehículo alquilado o Tour guiado"

TRANSPORTE (CRÍTICO):
- Si no puedes determinar con confianza, usa EXACTAMENTE: "Vehículo alquilado o Tour guiado".
- Dentro de ciudad usa coherente (A pie/metro/bus/taxi) sin inventar.

DURACIÓN EN 2 LÍNEAS (OBLIGATORIO):
- duration SIEMPRE exactamente:
  "Transporte: <tiempo>"
  "Actividad: <tiempo>"
- Si no puedes estimar con confianza: usa "Verificar duración en el Info Chat" en la línea correspondiente.

CALIDAD PREMIUM (PROHIBIDO GENÉRICO):
- Prohibido usar como actividad principal genérica:
  "Museos y cultura", "Exploración de la ciudad", "Parque local", "Restaurante local".
  Debes nombrar POIs/zonas concretas y desglosar por sub-paradas.

SALIDA (JSON) — estructura:
{
  "destination":"Ciudad",
  "country":"País",
  "days_total":1,
  "hotel_base":"...",
  "rationale":"...",
  "imperdibles":["..."],
  "macro_tours":["..."],
  "in_city_routes":[],
  "meals_suggestions":[],
  "aurora":{
    "plausible":false,
    "suggested_days":[],
    "window_local":{"start":"","end":""},
    "duration":"~3h–4h",
    "transport_default":"Vehículo alquilado o Tour guiado",
    "note":"..."
  },
  "constraints":{
    "max_substops_per_tour":8,
    "avoid_duplicates_across_days":true,
    "optimize_order_by_distance_and_time":true,
    "respect_user_preferences_and_conditions":true,
    "no_consecutive_auroras":true,
    "no_last_day_aurora":true,
    "thermal_lagoons_min_stay_minutes":180
  },
  "day_hours":[],
  "rows_draft":[
    {"day":1,"start":"HH:MM","end":"HH:MM","activity":"Destino – Sub-parada","from":"...","to":"...","transport":"...","duration":"Transporte: ...\\nActividad: ...","notes":"...","kind":"","zone":""}
  ],
  "rows_skeleton":[]
}

NOTA day_hours:
- Si NO viene en el contexto del usuario, déjalo como [] (no lo inventes).
- Si SÍ viene, úsalo como guía suave y ajústalo solo si hace falta.
`.trim();

/* =======================
   SISTEMA — PLANNER (estructurador)
   ======================= */
const SYSTEM_PLANNER = `
Eres **Astra Planner**. Recibes un objeto "research_json" del Info Chat interno.
El Info Chat YA DECIDIÓ: actividades, orden, tiempos, transporte y notas.
Tu trabajo es **estructurar y validar** para renderizar en tabla. **NO aportes creatividad.**

FUENTE DE VERDAD:
- Si research_json incluye rows_draft (o rows_final), esas filas son la verdad.
  → Úsalas tal cual y SOLO:
    (a) normalizar formato HH:MM,
    (b) asegurar buffers >=15m cuando falten,
    (c) corregir solapes pequeños moviendo minutos dentro del día,
    (d) completar campos faltantes SIN inventar actividades nuevas.

FORMATO:
- NO reescribas el texto de "activity": preserva EXACTAMENTE "Destino – Sub-parada".
- from/to NO pueden quedar vacíos.

DAY_HOURS (GUÍA):
- Si viene day_hours, úsalo como guía suave.
- NO inventes day_hours si no viene.
- NO sobreescribas start/end válidos salvo solapes o incoherencia obvia.

Si faltan campos:
- transport: si falta, usa "A pie" en urbano y "Vehículo alquilado o Tour guiado" en out-of-town evidente.
- notes: si falta, usa 1 frase breve y accionable (sin inventar POIs nuevos).

SALIDA ÚNICA (JSON):
{
  "destination":"Ciudad",
  "rows":[
    {"day":1,"start":"HH:MM","end":"HH:MM","activity":"Destino – Sub-parada","from":"...","to":"...","transport":"...","duration":"Transporte: Xm\\nActividad: Ym","notes":"...","kind":"","zone":""}
  ],
  "followup":""
}

REGLAS:
- JSON válido, sin texto fuera.
- NO inventes tours/actividades nuevas.
- Evita solapes.
- No pongas actividades diurnas entre 01:00–05:00.
- Auroras deben empezar >= 18:00 (pueden terminar después de medianoche).
- "Regreso a {ciudad}" debe ser la última fila del day-trip si aplica.
`.trim();

/* ============== Handler principal ============== */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = parseBody(req.body);
    const mode = String(body.mode || "planner").toLowerCase();

    /* --------- MODO INFO (motor interno) --------- */
    if (mode === "info") {
      let context = body.context;

      if (!context && Array.isArray(body.messages) && body.messages.length) {
        context = { messages: body.messages };
      }
      if (!context && !Array.isArray(body.messages)) {
        const { mode: _m, ...rest } = body || {};
        context = rest;
      }

      // ✅ Sanitiza day_hours entrante: si parece plantilla rígida repetida, se elimina
      try {
        if (context && typeof context === "object") {
          const daysTotal = context?.days_total || context?.days || context?.daysTotal || 1;
          const sanitized = _sanitizeIncomingDayHours_(context?.day_hours, daysTotal);
          if (!sanitized) {
            if ("day_hours" in context) delete context.day_hours;
          } else {
            context.day_hours = sanitized;
          }
        }
      } catch {}

      const assumeFull = _assumeFullDays_(context);
      const infoUserMsg = { role: "user", content: JSON.stringify({ context }, null, 0) };

      // 1) Primer intento (único por defecto, para performance)
      let raw = await callText([{ role: "system", content: SYSTEM_INFO }, infoUserMsg], TEMP_INFO, MAX_TOKENS_INFO);
      let parsed = cleanToJSONPlus(raw);

      // 2) Si parsea, postprocesa barato para blindar activity/from/to sin inventar
      if (parsed) {
        parsed = _postProcessRowsDraft_(parsed, context);
        parsed = normalizeDurationsInParsed(parsed);
      }

      // 3) Quality Gate + 1 repair máximo (solo si falló)
      if (parsed) {
        const audit = _validateInfoResearch_(parsed, {
          days_total: context?.days_total || context?.days || context?.daysTotal || 1,
          city: context?.city || parsed?.destination || "",
          assume_full_days: assumeFull,
        });

        if (!audit.ok) {
          const repairPrompt = `
${SYSTEM_INFO}

REPARACIÓN OBLIGATORIA (QUALITY GATE):
Tu JSON anterior falló estas validaciones:
- ${audit.issues.join("\n- ")}

Corrige SIN texto fuera del JSON.

REGLAS DE REPARACIÓN (PRIORIDAD):
1) rows_draft debe cubrir todos los días 1..days_total.
2) Cada fila: activity en formato "Destino – Sub-parada" + from/to NO vacíos.
3) NO placeholders genéricos (no "Museos y cultura", no "Exploración de la ciudad").
4) duration EXACTAMENTE 2 líneas.
5) Auroras: start >= 18:00, NO consecutivas, NUNCA último día.
6) Day-trip: 5–8 sub-paradas en el MISMO día + cierre con "Tour/Zona – Regreso a Reykjavik".

Responde SOLO JSON válido.
`.trim();

          const repairRaw = await callText([{ role: "system", content: repairPrompt }, infoUserMsg], 0.22, MAX_TOKENS_INFO);
          const repaired = cleanToJSONPlus(repairRaw);

          if (repaired) {
            parsed = _postProcessRowsDraft_(repaired, context);
            parsed = normalizeDurationsInParsed(parsed);
          }
        }
      }

      // 4) Fallback mínimo si nada funcionó
      if (!parsed) {
        parsed = {
          destination: context?.city || "Destino",
          country: context?.country || "",
          days_total: context?.days_total || 1,
          hotel_base: context?.hotel_address || context?.hotel_base || "",
          rationale: "Fallback mínimo.",
          imperdibles: [],
          macro_tours: [],
          in_city_routes: [],
          meals_suggestions: [],
          aurora: {
            plausible: false,
            suggested_days: [],
            window_local: { start: "", end: "" },
            transport_default: "",
            note: "",
            duration: "~3h–4h",
          },
          constraints: { max_substops_per_tour: 8, respect_user_preferences_and_conditions: true, thermal_lagoons_min_stay_minutes: 180 },
          day_hours: [],
          rows_draft: [],
          rows_skeleton: [],
        };
      }

      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    /* --------- MODO PLANNER (estructurador) --------- */
    if (mode === "planner") {
      // ✅ VALIDATE no debe llamar al modelo
      try {
        if (body && body.validate === true && Array.isArray(body.rows)) {
          const out = { allowed: body.rows, rejected: [] };
          return res.status(200).json({ text: JSON.stringify(out) });
        }
      } catch {}

      const research = body.research_json || null;

      // Camino legado (mensajes del cliente, sin research_json)
      if (!research) {
        const clientMessages = extractMessages(body);

        let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, ...clientMessages], TEMP_PLANNER, MAX_TOKENS_PLANNER);
        let parsed = cleanToJSONPlus(raw);

        // Si no parsea, un intento estricto (solo 1)
        if (!parsed) {
          const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo un JSON válido.`;
          raw = await callText([{ role: "system", content: strict }, ...clientMessages], 0.15, MAX_TOKENS_PLANNER);
          parsed = cleanToJSONPlus(raw);
        }

        if (!parsed) parsed = fallbackJSON();
        parsed = normalizeDurationsInParsed(parsed);
        return res.status(200).json({ text: JSON.stringify(parsed) });
      }

      // Camino nuevo (research_json directo)
      const plannerUserPayload = {
        research_json: research,
        target_day: body.target_day ?? null,
        day_hours: body.day_hours ?? null,
        existing_rows: body.existing_rows ?? null,
      };

      const plannerUserMsg = {
        role: "user",
        content: JSON.stringify(plannerUserPayload, null, 0),
      };

      // 1) Primer intento
      let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, plannerUserMsg], TEMP_PLANNER, MAX_TOKENS_PLANNER);
      let parsed = cleanToJSONPlus(raw);

      // 2) Si no parsea, 1 intento estricto
      if (!parsed) {
        const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, plannerUserMsg], 0.15, MAX_TOKENS_PLANNER);
        parsed = cleanToJSONPlus(raw);
      }

      // 3) Post-proceso final: asegurar activity/from/to y duration (sin inventar)
      if (parsed && Array.isArray(parsed.rows)) {
        const city = String(research?.destination || research?.city || "Destino").trim() || "Destino";
        parsed.rows = parsed.rows.map((r) => {
          const out = { ...r };

          const actRaw = String(out.activity || "").trim();
          const actNorm = _normDash_(actRaw);
          const sp = _splitActivity_(actNorm);

          // Si por alguna razón el planner devolvió algo sin dash, lo arreglamos localmente
          if (!sp.hasDash) {
            if (_looksLikeAurora_(actNorm)) out.activity = `Auroras – ${actNorm}`;
            else if (_looksLikeMacroTour_(actNorm)) out.activity = `Tour – ${actNorm}`;
            else out.activity = `${city} – ${actNorm}`;
          } else {
            out.activity = sp.normalized;
          }

          const sp2 = _splitActivity_(out.activity);
          if (!String(out.from || "").trim()) out.from = sp2.left || city;
          if (!String(out.to || "").trim()) out.to = sp2.right || "";

          if (!String(out.transport || "").trim()) {
            if (_looksLikeMacroTour_(out.activity) || /regreso/i.test(out.activity)) out.transport = "Vehículo alquilado o Tour guiado";
            else out.transport = "A pie";
          }

          const dur = String(out.duration || "");
          if (!_hasTwoLineDuration_(dur)) {
            out.duration = "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat";
          }

          out.kind = String(out.kind || "");
          out.zone = String(out.zone || "");
          return out;
        });

        parsed = normalizeDurationsInParsed(parsed);
      }

      // 4) Quality Gate + 1 repair máximo (solo si falló)
      if (parsed) {
        const audit = _validatePlannerOutput_(parsed);

        if (!audit.ok) {
          const repairPlanner = `
${SYSTEM_PLANNER}

REPARACIÓN OBLIGATORIA (QUALITY GATE):
Tu JSON anterior falló estas validaciones:
- ${audit.issues.join("\n- ")}

REGLAS:
- NO inventes nuevas actividades.
- Usa research_json.rows_draft como verdad.
- Preserva "Destino – Sub-parada".
- from/to NO vacíos.
- duration 2 líneas obligatorias.
- Auroras start >= 18:00.

Devuelve SOLO JSON válido.
`.trim();

          const repairRaw = await callText([{ role: "system", content: repairPlanner }, plannerUserMsg], 0.18, MAX_TOKENS_PLANNER);
          const repaired = cleanToJSONPlus(repairRaw);
          if (repaired) {
            parsed = repaired;

            // Post-proceso otra vez
            if (Array.isArray(parsed.rows)) {
              const city = String(research?.destination || research?.city || "Destino").trim() || "Destino";
              parsed.rows = parsed.rows.map((r) => {
                const out = { ...r };
                const actNorm = _normDash_(out.activity);
                const sp = _splitActivity_(actNorm);
                out.activity = sp.hasDash ? sp.normalized : `${city} – ${actNorm}`;

                const sp2 = _splitActivity_(out.activity);
                if (!String(out.from || "").trim()) out.from = sp2.left || city;
                if (!String(out.to || "").trim()) out.to = sp2.right || "";

                if (!String(out.transport || "").trim()) out.transport = "A pie";
                if (!_hasTwoLineDuration_(String(out.duration || ""))) {
                  out.duration = "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat";
                }
                out.kind = String(out.kind || "");
                out.zone = String(out.zone || "");
                return out;
              });
            }

            parsed = normalizeDurationsInParsed(parsed);
          }
        }
      }

      if (!parsed) parsed = fallbackJSON();
      parsed = normalizeDurationsInParsed(parsed);
      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    return res.status(400).json({ error: "Invalid mode" });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    // compat: nunca rompas el planner
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
