// /api/chat.js — v50 (ESM, Vercel)
// BASE: v43.6.2 (tu código) + injertos QUIRÚRGICOS para:
// 1) NO romper INFO→PLANNER en errores/timeouts: si mode=info y falla, devolver fallback INFO (rows_draft por día), NO fallback planner.
// 2) Reglas de COMIDAS: NO predefinir cenas; sugerir comidas solo si aporta logística/valor (no prioritario).
// 3) Mejor cumplimiento de reglas sin inflar el prompt: Quality Gate INFO refuerza macro-tour (5–8 sub-paradas + regreso) y evita “reglas light”.
// 4) Post-proceso mínimo en PLANNER: completa from/to desde "Destino – Sub-parada" cuando falten y evita "A pie" fuera de ciudad.
// 5) Performance: reduce tokens por defecto (para bajar timeouts) sin cambiar arquitectura.

import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
        start: "", // ✅ sin horas predefinidas
        end: "", // ✅ sin horas predefinidas
        activity: "Itinerario base (fallback)",
        from: "",
        to: "",
        transport: "",
        duration: "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat",
        notes: "Explora libremente la ciudad.",
        kind: "",
        zone: "",
      },
    ],
    followup: "⚠️ Fallback local: revisa OPENAI_API_KEY o despliegue.",
  };
}

/* ✅ v50 QUIRÚRGICO: fallback específico para INFO (evita que el PLANNER reciba basura) */
function fallbackInfoJSON(context = {}) {
  const city = String(context?.city || context?.destination || "Destino").trim() || "Destino";
  const country = String(context?.country || "").trim();
  const daysTotal = Math.max(1, Number(context?.days_total || context?.days || context?.daysTotal || 1));
  const hotelBase = String(context?.hotel_address || context?.hotel_base || "").trim();

  const rows_draft = [];
  for (let d = 1; d <= daysTotal; d++) {
    rows_draft.push({
      day: d,
      start: "",
      end: "",
      activity: `Fallback – Planificación pendiente (Día ${d})`,
      from: city,
      to: city,
      transport: "",
      duration: "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat",
      notes: "⚠️ No se pudo generar este día. Revisa OPENAI_API_KEY / despliegue.",
      kind: "",
      zone: "",
    });
  }

  return {
    destination: city,
    country,
    days_total: daysTotal,
    hotel_base: hotelBase,
    rationale: "Fallback mínimo (INFO).",
    imperdibles: [],
    macro_tours: [],
    in_city_routes: [],
    meals_suggestions: [],
    aurora: {
      plausible: false,
      suggested_days: [],
      window_local: { start: "", end: "" },
      transport_default: "Vehículo alquilado o Tour guiado",
      note: "Fallback: depende de clima/latitud y del tour.",
      duration: "~3h–4h",
    },
    constraints: {
      max_substops_per_tour: 8,
      avoid_duplicates_across_days: true,
      optimize_order_by_distance_and_time: true,
      respect_user_preferences_and_conditions: true,
      no_consecutive_auroras: true,
      no_last_day_aurora: true,
      thermal_lagoons_min_stay_minutes: 180,
    },
    day_hours: [],
    rows_draft,
    rows_skeleton: rows_draft.map((r) => ({
      day: r.day,
      start: "",
      end: "",
      activity: "",
      from: "",
      to: "",
      transport: "",
      duration: "",
      notes: "",
      kind: "",
      zone: "",
    })),
    followup: "⚠️ Fallback INFO: revisa OPENAI_API_KEY o despliegue.",
  };
}

/* ============== Llamada unificada a Responses API (se mantiene tu arquitectura) ============== */
/* ✅ v50: baja tokens por defecto para reducir timeouts */
async function callText(messages, temperature = 0.35, max_output_tokens = 2800) {
  const inputStr = messages
    .map((m) => {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${String(m.role || "user").toUpperCase()}: ${c}`;
    })
    .join("\n\n");

  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    max_output_tokens,
    input: inputStr,
  });

  return resp?.output_text?.trim() || resp?.output?.[0]?.content?.[0]?.text?.trim() || "";
}

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

/* ============== Helpers from/to + transporte (QUIRÚRGICO) ============== */
function _splitActivityDestSub_(activity) {
  try {
    const s = String(activity || "").trim();
    if (!s) return null;
    const m = s.match(/^(.+?)\s[–-]\s(.+?)$/);
    if (!m) return null;
    const left = String(m[1] || "").trim();
    const right = String(m[2] || "").trim();
    if (!left || !right) return null;
    return { from: left, to: right };
  } catch {
    return null;
  }
}

/* completa from/to SOLO desde "Destino – Sub-parada" (sin inventar) */
function _fillFromToFromActivity_(rows = []) {
  try {
    if (!Array.isArray(rows) || !rows.length) return rows;
    let prevTo = "";
    return rows.map((r) => {
      const row = { ...(r || {}) };
      const from0 = String(row.from || "").trim();
      const to0 = String(row.to || "").trim();

      if (!from0 || !to0) {
        const sp = _splitActivityDestSub_(row.activity);
        if (sp) {
          if (!from0) row.from = sp.from;
          if (!to0) row.to = sp.to;
        }
      }

      const from1 = String(row.from || "").trim();
      const to1 = String(row.to || "").trim();

      if (!from1 && prevTo) row.from = prevTo;
      if (to1) prevTo = to1;

      return row;
    });
  } catch {
    return rows;
  }
}

function _maybeFixTransport_(rows = [], cityBase = "") {
  try {
    if (!Array.isArray(rows) || !rows.length) return rows;
    const base = String(cityBase || "").trim().toLowerCase();

    const looksUrban = (x) => {
      const t = String(x || "").trim().toLowerCase();
      if (!t) return false;
      if (base && (t === base || t.includes(base))) return true;
      // Heurística: "centro", "downtown", "old town", "harpa", etc. siguen siendo urbanos, pero no obligamos.
      return false;
    };

    return rows.map((r) => {
      const row = { ...(r || {}) };
      const tr = String(row.transport || "").trim();
      const from = String(row.from || "").trim();
      const to = String(row.to || "").trim();

      // Si está vacío: no tocamos aquí (lo decide PLANNER/INFO); solo evitamos errores groseros.
      if (!tr) return row;

      // Si puso "A pie" pero claramente no es urbano (from!=to y ninguno parece base): corrige a opción segura.
      if (/^a\s*pie$/i.test(tr) && from && to && from.toLowerCase() !== to.toLowerCase()) {
        const urban = looksUrban(from) || looksUrban(to);
        if (!urban) row.transport = "Vehículo alquilado o Tour guiado";
      }

      return row;
    });
  } catch {
    return rows;
  }
}

/* ============== Quality Gate (existente + refuerzo quirúrgico) ============== */

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
  const present = new Set(rows.map((r) => Number(r.day) || 0));
  for (let d = 1; d <= need; d++) if (!present.has(d)) return false;
  return true;
}

function _validateInfoResearch_(parsed, contextHint = {}) {
  const issues = [];

  const daysTotal = Number(parsed?.days_total || contextHint?.days_total || 1);
  const rows = Array.isArray(parsed?.rows_draft) ? parsed.rows_draft : [];

  if (!rows.length) issues.push("rows_draft vacío o ausente (obligatorio).");
  if (rows.length && !_rowsHaveCoverage_(rows, daysTotal)) issues.push("rows_draft no cubre todos los días 1..days_total.");
  if (rows.length && rows.some((r) => !_hasTwoLineDuration_(r.duration)))
    issues.push('duration no cumple formato 2 líneas ("Transporte" + "Actividad") en una o más filas.');
  if (rows.length && rows.some((r) => _isGenericPlaceholderActivity_(r.activity)))
    issues.push("hay placeholders genéricos en activity (ej. museo/parque/café/restaurante genérico).");

  /* ===== AURORAS ===== */
  const auroraDays = rows
    .filter((r) => /auroras?|northern\s*lights/i.test(String(r.activity || "")) || String(r.kind || "").toLowerCase() === "aurora")
    .map((r) => Number(r.day))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  for (let i = 1; i < auroraDays.length; i++) {
    if (auroraDays[i] === auroraDays[i - 1] + 1) {
      issues.push("auroras programadas en días consecutivos (no permitido).");
      break;
    }
  }

  if (auroraDays.includes(daysTotal)) issues.push("auroras programadas en el último día (no permitido).");

  /* ===== MACRO-TOURS ÚNICOS + SUBPARADAS MÍNIMAS ===== */
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
    if (/golden\s*circle|circulo\s*dorado|snæfellsnes|costa\s*sur|day\s*trip|excursion|tour\b/i.test(key)) {
      macroDays[key] = macroDays[key] || new Set();
      macroDays[key].add(Number(r.day));
    }
  });

  Object.entries(macroDays).forEach(([k, days]) => {
    if (days.size > 1) issues.push(`macro-tour "${k}" repartido en múltiples días (${[...days].join(", ")}).`);
  });

  // ✅ v50: si hay macro-tour en un día, debe haber 5–8 filas del tour ese día
  try {
    const byDay = new Map();
    rows.forEach((r) => {
      const d = Number(r.day) || 0;
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(r);
    });

    for (let d = 1; d <= daysTotal; d++) {
      const dayRows = byDay.get(d) || [];
      const macroRows = dayRows.filter((r) => {
        const act = String(r.activity || "");
        const kind = String(r.kind || "").toLowerCase();
        return (
          kind === "macro_tour" ||
          /golden\s*circle|circulo\s*dorado|snæfellsnes|costa\s*sur|day\s*trip|excursion|tour\b/i.test(act)
        );
      });

      if (macroRows.length > 0 && macroRows.length < 5) issues.push(`macro-tour en día ${d} tiene pocas sub-paradas (${macroRows.length}); requiere 5–8.`);
      if (macroRows.length > 8) issues.push(`macro-tour en día ${d} tiene demasiadas sub-paradas (${macroRows.length}); máximo 8.`);

      // Si hay macroRows, exigir "Regreso a {base}" al final del día (heurístico)
      if (macroRows.length >= 5) {
        const last = String(dayRows[dayRows.length - 1]?.activity || "");
        if (!/regreso\s+a/i.test(last)) {
          issues.push(`macro-tour en día ${d} no cierra con "Regreso a {ciudad base}".`);
        }
      }
    }
  } catch {}

  /* ===== DURACIÓN VS BLOQUE HORARIO (guard suave) ===== */
  const toMin = (hhmm) => {
    const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  };

  const durFromText = (txt) => {
    const s = String(txt || "");
    let total = 0;
    const mh = s.match(/Actividad\s*:\s*(\d+)\s*h/i);
    const mm = s.match(/Actividad\s*:\s*(\d+)\s*m/i);
    if (mh) total += parseInt(mh[1], 10) * 60;
    if (mm) total += parseInt(mm[1], 10);
    return total;
  };

  rows.forEach((r) => {
    const s = toMin(r.start);
    const e = toMin(r.end);
    if (s == null || e == null) return;

    let block = e - s;
    if (block <= 0) block += 24 * 60;

    const dur = durFromText(r.duration);
    if (dur && dur < block * 0.7) issues.push(`duración inconsistente en día ${r.day} (${r.activity}).`);
  });

  return { ok: issues.length === 0, issues };
}

/* ============== ✅ v43.6.1: Sanitizador de day_hours entrante ============== */
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
        issues.push("hay placeholders genéricos en activity (ej. museo/parque/café/restaurante genérico).");
      }
      if (rows.some((r) => Number(r?.day) < 1 || !Number.isFinite(Number(r?.day)))) {
        issues.push("hay filas con 'day' inválido (<1 o no numérico).");
      }
    }

    return { ok: issues.length === 0, issues };
  } catch {
    return { ok: true, issues: [] };
  }
}

/* ============== Prompts del sistema ============== */

/* ===================== SISTEMA — INFO CHAT (interno) ===================== */
const SYSTEM_INFO = `
Eres el **Info Chat interno** de ITravelByMyOwn: un **experto mundial en turismo** con criterio premium.
Debes devolver **UN ÚNICO JSON VÁLIDO** (sin texto fuera) listo para usarse en tabla.

✅ ARQUITECTURA:
- INFO es la **fuente de verdad** de los horarios: start/end por fila en rows_draft.
- El Planner solo valida/ajusta solapes pequeños; NO genera ventanas ni rellena horarios por defecto.

REGLA MAESTRA 1 — IMPERDIBLES + ALCANCE REAL:
- Identifica imperdibles reales según temporada, clima probable, perfil del grupo y días.
- Mezcla ciudad + day-trips desde base sin sacrificar lo esencial de la ciudad.
- Imperdibles deben reflejarse en rows_draft y listarse en imperdibles.
- Day-trips elegidos deben listarse en macro_tours.

REGLA MAESTRA 2 — TRANSPORTE INTELIGENTE:
- Sugiere opciones reales (tren/metro/bus interurbano) cuando aplique.
- Si no puedes determinar con confianza, usa EXACTAMENTE: "Vehículo alquilado o Tour guiado".
- Dentro de ciudad usa transporte coherente (a pie/metro/bus/taxi/uber) según zonas.

REGLA MAESTRA 3 — SUB-PARADAS (CRÍTICO):
- Para recorridos multi-parada (macro-tour o urbano), expresa secuencia como:
  "Ruta/Área – Sub-parada" o "Destino – Sub-parada".
- Cada sub-parada es una fila con start/end, from/to, transport, duration y notes.
- from/to NO deben quedar vacíos.

HORARIOS (CRÍTICO):
- Si el usuario define day_hours en el contexto, respétalas como guía (soft).
- Si el usuario NO define day_hours:
  - PROHIBIDO emitir plantilla rígida repetida (ej. 08:30–19:00 fijo todos los días).
  - Genera horarios realistas por filas según ciudad/estación/ritmo.
- Buffers mínimos 15m entre bloques.
- Actividades diurnas NO entre 01:00–05:00.

DURACIÓN EN 2 LÍNEAS (OBLIGATORIO):
- duration SIEMPRE exactamente 2 líneas:
  "Transporte: <tiempo>"
  "Actividad: <tiempo>"
- Si no puedes estimar, NO inventes: usa
  "Transporte: Verificar duración en el Info Chat" o "Actividad: Verificar duración en el Info Chat"
  manteniendo el formato.

MACRO-TOURS / DAY-TRIPS (CRÍTICO):
- Si incluyes un day-trip fuerte, ese día queda dedicado al tour.
- Debe tener 5–8 sub-paradas + al cierre una fila: "Regreso a {ciudad base}".
- NO repartir el mismo tour en múltiples días.
- No colocar day-trips duros el último día.
- NO duplicados bilingües del mismo tour/actividad.

AURORAS (SOLO SI ES PLAUSIBLE):
- Valida plausibilidad por latitud y época.
- Si plausible: máximo 1 por día, NO consecutivas, NUNCA en el último día,
  ventana local concreta, transporte coherente.

COMIDAS (NO PRIORITARIO):
- NO predefinas cenas.
- Sugiere tiempos de comida SOLO si mejora logística/experiencia (pausa natural, sitio icónico, cercanía).
- Si sugieres, debe ser específico (no “restaurante local”).

CALIDAD PREMIUM:
- Prohibido "Museo de Arte", "Parque local", "Café local", "Restaurante local" como actividad principal sin especificidad.
- Agrupa por zonas; evita “va y ven”.

CRÍTICO — SALIDA:
Incluye SIEMPRE rows_draft completo con:
day, start, end, activity, from, to, transport, duration(2 líneas), notes, kind, zone.

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
  "constraints":{ "max_substops_per_tour":8, "no_consecutive_auroras":true, "no_last_day_aurora":true, "thermal_lagoons_min_stay_minutes":180 },
  "day_hours":[],
  "rows_draft":[
    {"day":1,"start":"HH:MM","end":"HH:MM","activity":"Destino – Sub-parada","from":"","to":"","transport":"","duration":"Transporte: ...\\nActividad: ...","notes":"...","kind":"","zone":""}
  ],
  "rows_skeleton":[]
}

NOTA day_hours:
- Si NO viene en el contexto del usuario, déjalo como [] (no lo inventes).
`.trim();

/* ===================== SISTEMA — PLANNER (estructurador) ===================== */
const SYSTEM_PLANNER = `
Eres **Astra Planner**. Recibes un objeto "research_json" del Info Chat interno.
El Info Chat YA DECIDIÓ: actividades, orden, tiempos, transporte y notas.
Tu trabajo es **estructurar y validar** para renderizar en tabla. **NO aportes creatividad.**

CONTRATO:
- Si research_json incluye rows_draft (o rows_final), esas filas son la verdad.
  → Úsalas como base y SOLO:
    (a) normalizar HH:MM,
    (b) asegurar buffers >=15m cuando falten,
    (c) corregir solapes pequeños moviendo minutos dentro del día,
    (d) completar campos faltantes SIN inventar actividades nuevas.
- NO reescribas "activity": preserva "Destino – Sub-parada" tal como viene.

DAY_HOURS (soft):
- Si viene day_hours (del usuario), úsalo como guía.
- NO inventes day_hours si no viene.
- NO sobreescribas start/end válidos de rows_draft; solo ajusta si hay solape o movimiento razonable.

Si faltan campos:
- from/to: si faltan, dedúcelos SOLO desde "Destino – Sub-parada" (sin inventar).
- transport: si no hay, usa "A pie" para urbano y "Vehículo alquilado o Tour guiado" para out-of-town cuando sea evidente por from/to.
- notes: si falta, usa 1 frase breve.

SALIDA ÚNICA (JSON):
{
  "destination":"Ciudad",
  "rows":[
    {"day":1,"start":"HH:MM","end":"HH:MM","activity":"","from":"","to":"","transport":"","duration":"","notes":"","kind":"","zone":""}
  ],
  "followup":""
}

REGLAS:
- JSON válido, sin texto fuera.
- NO inventes tours/actividades nuevas.
- Evita solapes.
- No pongas actividades diurnas entre 01:00–05:00.
- "Regreso a {ciudad}" debe ser la última fila del day-trip si aplica.

DURACIÓN:
- duration SIEMPRE:
  "Transporte: Xm\\nActividad: Ym"
- Si no conoces, usa:
  "Transporte: Verificar duración en el Info Chat\\nActividad: Verificar duración en el Info Chat"

MODO ACOTADO:
- Si viene "target_day", devuelve SOLO filas de ese día.
`.trim();

/* ============== Handler principal ============== */
export default async function handler(req, res) {
  // ✅ v50: mantener track de modo para el catch (quirúrgico)
  let _safeMode = "planner";
  let _safeBody = {};
  try {
    _safeBody = parseBody(req?.body);
    _safeMode = String(_safeBody?.mode || "planner").toLowerCase();
  } catch {}

  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = _safeBody;
    const mode = _safeMode;

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

      // ✅ v43.6.1: eliminar day_hours si parece plantilla rígida repetida
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

      // ✅ v50 performance: payload compacto (sin pretty-print)
      const infoUserMsg = { role: "user", content: JSON.stringify({ context }) };

      // 1) Primer intento
      let raw = await callText([{ role: "system", content: SYSTEM_INFO }, infoUserMsg], 0.35, 3200);
      let parsed = cleanToJSONPlus(raw);

      // 2) Si no parsea, intento estricto
      if (!parsed) {
        const strict = SYSTEM_INFO + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, infoUserMsg], 0.2, 3200);
        parsed = cleanToJSONPlus(raw);
      }

      // 3) Quality Gate + 1 retry (máximo)
      if (parsed) {
        const audit = _validateInfoResearch_(parsed, {
          days_total: context?.days_total || context?.days || context?.daysTotal || 1,
        });

        if (!audit.ok) {
          const repairPrompt = `
${SYSTEM_INFO}

REPARACIÓN OBLIGATORIA (QUALITY GATE):
Tu JSON anterior falló:
- ${audit.issues.join("\n- ")}

Corrige SIN texto fuera del JSON.
REGLAS:
1) rows_draft debe cubrir 1..days_total.
2) activity NO genérica.
3) duration EXACTAMENTE 2 líneas.
4) Macro-tour/day-trip: 5–8 sub-paradas + "Regreso a {ciudad base}" al cierre en el MISMO día.
5) Auroras NO consecutivas y NUNCA último día.
6) day_hours: NO inventar si no viene.

Responde SOLO JSON válido.
`.trim();

          const repairRaw = await callText([{ role: "system", content: repairPrompt }, infoUserMsg], 0.25, 3200);
          const repaired = cleanToJSONPlus(repairRaw);
          if (repaired) parsed = repaired;
        }
      }

      // 4) Fallback INFO si nada funcionó o quedó incompleto
      if (!parsed || !Array.isArray(parsed?.rows_draft) || !parsed.rows_draft.length) {
        parsed = fallbackInfoJSON(context || {});
      } else {
        const daysTotal = Number(parsed?.days_total || context?.days_total || context?.days || context?.daysTotal || 1);
        if (!_rowsHaveCoverage_(parsed.rows_draft, daysTotal)) {
          parsed = fallbackInfoJSON(context || {});
        }
      }

      // ✅ v50: completa from/to desde activity (sin inventar) + evita "A pie" fuera de ciudad (si vino así)
      try {
        parsed.rows_draft = _fillFromToFromActivity_(parsed.rows_draft);
        parsed.rows_draft = _maybeFixTransport_(parsed.rows_draft, parsed?.destination || context?.city || "");
      } catch {}

      parsed = normalizeDurationsInParsed(parsed);
      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    /* --------- MODO PLANNER (estructurador) --------- */
    if (mode === "planner") {
      // ✅ v43.6.2: validate=true NO llama al modelo
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

        let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, ...clientMessages], 0.35, 2800);
        let parsed = cleanToJSONPlus(raw);

        if (!parsed) {
          const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo un JSON válido.`;
          raw = await callText([{ role: "system", content: strict }, ...clientMessages], 0.2, 2600);
          parsed = cleanToJSONPlus(raw);
        }

        if (!parsed) parsed = fallbackJSON();

        // ✅ v50: post-proceso mínimo para evitar blanks y "A pie" fuera de ciudad
        try {
          if (Array.isArray(parsed?.rows)) {
            parsed.rows = _fillFromToFromActivity_(parsed.rows);
            parsed.rows = _maybeFixTransport_(parsed.rows, parsed?.destination || "");
          }
        } catch {}

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

      const plannerUserMsg = { role: "user", content: JSON.stringify(plannerUserPayload) };

      // 1) Primer intento
      let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, plannerUserMsg], 0.35, 2800);
      let parsed = cleanToJSONPlus(raw);

      // 2) Si no parsea, intento estricto
      if (!parsed) {
        const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, plannerUserMsg], 0.2, 2600);
        parsed = cleanToJSONPlus(raw);
      }

      // 3) Quality Gate + 1 retry (máximo)
      if (parsed) {
        const audit = _validatePlannerOutput_(parsed);

        if (!audit.ok) {
          const repairPlanner = `
${SYSTEM_PLANNER}

REPARACIÓN OBLIGATORIA (QUALITY GATE):
Fallos:
- ${audit.issues.join("\n- ")}

REGLAS:
- NO inventes nuevas actividades.
- Usa research_json.rows_draft como verdad.
- duration 2 líneas.
- Devuelve SOLO JSON válido.
`.trim();

          const repairRaw = await callText([{ role: "system", content: repairPlanner }, plannerUserMsg], 0.25, 2800);
          const repaired = cleanToJSONPlus(repairRaw);
          if (repaired) parsed = repaired;
        }
      }

      if (!parsed) parsed = fallbackJSON();

      // ✅ v50: post-proceso mínimo para evitar blanks y "A pie" fuera de ciudad
      try {
        if (Array.isArray(parsed?.rows)) {
          parsed.rows = _fillFromToFromActivity_(parsed.rows);
          parsed.rows = _maybeFixTransport_(parsed.rows, parsed?.destination || "");
        }
      } catch {}

      parsed = normalizeDurationsInParsed(parsed);
      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    return res.status(400).json({ error: "Invalid mode" });
  } catch (err) {
    console.error("❌ /api/chat error:", err);

    // ✅ v50 QUIRÚRGICO CRÍTICO:
    // si el error ocurre en INFO, devolver fallback INFO (NO fallback planner),
    // para que el PLANNER no quede con días “vacíos” o “pendientes” mal formateados.
    try {
      if (_safeMode === "info") {
        const context = _safeBody?.context || _safeBody || {};
        return res.status(200).json({ text: JSON.stringify(fallbackInfoJSON(context)) });
      }
    } catch {}

    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
