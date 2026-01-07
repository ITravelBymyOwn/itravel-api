// /api/chat.js — v50.0.0 (ESM, Vercel)
// Doble etapa: (1) INFO (investiga y decide) → (2) PLANNER (estructura/valida).
// Respuestas SIEMPRE como { text: "<JSON|texto>" }.
// ⚠️ Sin lógica del Info Chat EXTERNO (vive en /api/info-public.js).
//
// v50.0.0 (QUIRÚRGICO sobre v43.6.2):
// - Mantiene contrato de entrada/salida y modos ("info" / "planner").
// - Optimiza para evitar timeouts: máx 1 intento + 1 reparación (no más loops).
// - Agrega fallback INFO robusto (rows_draft mínimo por día) para no romper Planner.
// - Reglas INFO: priorizar transporte público en day-trips cuando aplique; si no hay certeza → "Vehículo alquilado o Tour guiado".
// - Comidas: guía flexible (NO obligatoria, NO predefinir cenas).
// - Enforcements locales: auroras no consecutivas / no último día; insertar "Regreso a {ciudad}" si hay macro-tour; from/to desde activity.
// - callText: usa Chat Completions con roles reales (más estable que input string consolidado en prompts largos).

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

  try {
    return JSON.parse(raw);
  } catch {}

  try {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(raw.slice(first, last + 1));
  } catch {}

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

/* ✅ Fallback INFO robusto (no rompe Planner: rows_draft cubre 1..days_total) */
function fallbackInfoJSON(context = {}) {
  const city = String(context?.city || context?.destination || "Destino").trim() || "Destino";
  const country = String(context?.country || "").trim();
  const daysTotal = Math.max(1, Number(context?.days_total || context?.days || context?.daysTotal || 1));

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
    hotel_base: String(context?.hotel_address || context?.hotel_base || "").trim(),
    rationale: "Fallback mínimo (INFO).",
    imperdibles: [],
    macro_tours: [],
    in_city_routes: [],
    meals_suggestions: [],
    aurora: {
      plausible: false,
      suggested_days: [],
      window_local: { start: "", end: "" },
      duration: "~3h–4h",
      transport_default: "",
      note: "Fallback: depende de clima/latitud y del tour.",
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

/* ============== Llamada al modelo (roles reales) ============== */
async function callText(messages, temperature = 0.3, max_tokens = 2400) {
  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature,
    max_tokens,
    messages: (messages || []).map((m) => ({
      role: String(m.role || "user"),
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    })),
  });

  return resp?.choices?.[0]?.message?.content?.trim() || "";
}

/* ============== Normalizador de duraciones ============== */
function normalizeDurationsInParsed(parsed) {
  if (!parsed) return parsed;

  const norm = (txt) => {
    const s = String(txt ?? "").trim();
    if (!s) return s;
    if (/^Transporte\s*:/i.test(s) || /^Actividad\s*:/i.test(s)) return s;
    if (/^~\s*\d+(\.\d+)?\s*h$/i.test(s)) return s;

    const dh = s.match(/^(\d+(?:\.\d+)?)\s*h$/i);
    if (dh) {
      const hours = parseFloat(dh[1]);
      const total = Math.round(hours * 60);
      const h = Math.floor(total / 60);
      const m = total % 60;
      return h > 0 ? (m > 0 ? `${h}h${m}m` : `${h}h`) : `${m}m`;
    }

    const hMix = s.match(/^(\d+)\s*h\s*(\d{1,2})$/i);
    if (hMix) return `${hMix[1]}h${hMix[2]}m`;

    if (/^\d+\s*m$/i.test(s)) return s;
    if (/^\d+\s*h$/i.test(s)) return s;

    return s;
  };

  const touchRows = (rows = []) => rows.map((r) => ({ ...r, duration: norm(r?.duration) }));

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

/* ============== Quality Gate (ligero) ============== */
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
  const present = new Set(rows.map((r) => Number(r?.day) || 0));
  for (let d = 1; d <= need; d++) if (!present.has(d)) return false;
  return true;
}

function _missingDays_(rows, daysTotal) {
  try {
    const need = Math.max(1, Number(daysTotal) || 1);
    const present = new Set((Array.isArray(rows) ? rows : []).map((r) => Number(r?.day) || 0));
    const missing = [];
    for (let d = 1; d <= need; d++) if (!present.has(d)) missing.push(d);
    return missing;
  } catch {
    return [];
  }
}

function _validateInfoResearch_(parsed, contextHint = {}) {
  const issues = [];
  const daysTotal = Number(parsed?.days_total || contextHint?.days_total || 1);
  const rows = Array.isArray(parsed?.rows_draft) ? parsed.rows_draft : [];

  if (!rows.length) issues.push("rows_draft vacío o ausente (obligatorio).");
  if (rows.length && !_rowsHaveCoverage_(rows, daysTotal)) issues.push("rows_draft no cubre todos los días 1..days_total.");
  if (rows.length && rows.some((r) => !_hasTwoLineDuration_(r?.duration))) issues.push('duration no cumple formato 2 líneas ("Transporte" + "Actividad") en una o más filas.');
  if (rows.length && rows.some((r) => _isGenericPlaceholderActivity_(r?.activity))) issues.push("hay placeholders genéricos en activity.");

  // Auroras: no consecutivas, no último día
  const auroraDays = rows
    .filter((r) => /auroras?|northern\s*lights/i.test(String(r?.activity || "")) || String(r?.kind || "").toLowerCase() === "aurora")
    .map((r) => Number(r?.day))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  for (let i = 1; i < auroraDays.length; i++) {
    if (auroraDays[i] === auroraDays[i - 1] + 1) {
      issues.push("auroras programadas en días consecutivos (no permitido).");
      break;
    }
  }
  if (auroraDays.includes(daysTotal)) issues.push("auroras programadas en el último día (no permitido).");

  return { ok: issues.length === 0, issues };
}

function _validatePlannerOutput_(parsed) {
  try {
    const issues = [];
    const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    if (!rows.length) issues.push("rows vacío o ausente (obligatorio).");
    if (rows.length) {
      if (rows.some((r) => !_hasTwoLineDuration_(r?.duration))) issues.push('duration no cumple formato 2 líneas ("Transporte" + "Actividad") en una o más filas.');
      if (rows.some((r) => _isGenericPlaceholderActivity_(r?.activity))) issues.push("hay placeholders genéricos en activity.");
      if (rows.some((r) => Number(r?.day) < 1 || !Number.isFinite(Number(r?.day)))) issues.push("hay filas con 'day' inválido.");
    }
    return { ok: issues.length === 0, issues };
  } catch {
    return { ok: true, issues: [] };
  }
}

/* ============== Sanitizador day_hours entrante ============== */
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

/* ============== Enforcements locales (ligeros, sin loops) ============== */
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

function _dedupeConsecutiveDays_(days = []) {
  const sorted = [...new Set(days.map((n) => Number(n)).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    const d = sorted[i];
    if (out.length && d === out[out.length - 1] + 1) continue;
    out.push(d);
  }
  return out;
}

function _enforceAuroras_(parsed, daysTotal) {
  try {
    if (!parsed || !Array.isArray(parsed.rows_draft)) return parsed;

    const total = Math.max(1, Number(daysTotal) || Number(parsed?.days_total) || 1);
    const auroraMeta = parsed?.aurora && typeof parsed.aurora === "object" ? parsed.aurora : null;
    const plausible = auroraMeta ? Boolean(auroraMeta.plausible) : null;

    if (plausible === false) {
      parsed.rows_draft = parsed.rows_draft.filter(
        (r) => !(String(r?.kind || "").toLowerCase() === "aurora" || /auroras?|northern\s*lights/i.test(String(r?.activity || "")))
      );
      if (auroraMeta) {
        auroraMeta.suggested_days = [];
        parsed.aurora = auroraMeta;
      }
      return parsed;
    }

    const auroraRows = parsed.rows_draft.filter(
      (r) => String(r?.kind || "").toLowerCase() === "aurora" || /auroras?|northern\s*lights/i.test(String(r?.activity || ""))
    );

    const days = auroraRows.map((r) => Number(r?.day)).filter((n) => Number.isFinite(n));
    let keepDays = _dedupeConsecutiveDays_(days).filter((d) => d !== total);

    const keepSet = new Set(keepDays);
    parsed.rows_draft = parsed.rows_draft.filter((r) => {
      const isAur = String(r?.kind || "").toLowerCase() === "aurora" || /auroras?|northern\s*lights/i.test(String(r?.activity || ""));
      if (!isAur) return true;
      const d = Number(r?.day);
      return keepSet.has(d);
    });

    if (auroraMeta) {
      auroraMeta.suggested_days = [...keepSet].sort((a, b) => a - b);
      parsed.aurora = auroraMeta;
    }

    return parsed;
  } catch {
    return parsed;
  }
}

function _insertReturnRowIfMissing_(parsed, baseCity) {
  try {
    if (!parsed || !Array.isArray(parsed.rows_draft) || !parsed.rows_draft.length) return parsed;

    const city = String(baseCity || parsed?.destination || "").trim();
    if (!city) return parsed;

    const byDay = new Map();
    parsed.rows_draft.forEach((r) => {
      const d = Number(r?.day) || 0;
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(r);
    });

    const outRows = [];
    const isMacro = (r) => String(r?.kind || "").toLowerCase() === "macro_tour" || /day\s*trip|excursion|tour\b/i.test(String(r?.activity || ""));
    const isReturn = (r) => /regreso\s+a\s+/i.test(String(r?.activity || ""));

    const inferFromPlace = (rows) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        const rr = rows[i];
        const t = String(rr?.to || "").trim();
        if (t) return t;
        const sp = _splitActivityDestSub_(rr?.activity);
        if (sp?.to) return sp.to;
      }
      return "";
    };

    const inferTransport = (rows) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        const tr = String(rows[i]?.transport || "").trim();
        if (tr) return tr;
      }
      return "Vehículo alquilado o Tour guiado";
    };

    const inferZone = (rows) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        const z = String(rows[i]?.zone || "").trim();
        if (z) return z;
      }
      return "";
    };

    const days = [...byDay.keys()].filter((d) => d > 0).sort((a, b) => a - b);

    days.forEach((d) => {
      const dayRows = (byDay.get(d) || []).slice().sort((a, b) => String(a?.start || "").localeCompare(String(b?.start || "")));
      const hasMacro = dayRows.some(isMacro);
      const alreadyReturn = dayRows.some(isReturn);

      dayRows.forEach((r) => outRows.push(r));

      if (hasMacro && !alreadyReturn) {
        const fromPlace = inferFromPlace(dayRows);
        const transport = inferTransport(dayRows);
        const zone = inferZone(dayRows);

        outRows.push({
          day: d,
          start: "",
          end: "",
          activity: `Regreso a ${city}`,
          from: fromPlace || "",
          to: city,
          transport,
          duration: "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat",
          notes: "Regreso a la ciudad base para descansar.",
          kind: "macro_tour",
          zone: zone || "",
        });
      }
    });

    parsed.rows_draft = outRows;
    return parsed;
  } catch {
    return parsed;
  }
}

function _enforceInfoHardRules_(parsed, daysTotalHint) {
  try {
    if (!parsed || typeof parsed !== "object") return parsed;
    const total = Math.max(1, Number(parsed?.days_total || daysTotalHint || 1));

    if (Array.isArray(parsed.rows_draft)) parsed.rows_draft = _fillFromToFromActivity_(parsed.rows_draft);
    parsed = _enforceAuroras_(parsed, total);
    parsed = _insertReturnRowIfMissing_(parsed, parsed?.destination);
    if (Array.isArray(parsed.rows_draft)) parsed.rows_draft = _fillFromToFromActivity_(parsed.rows_draft);

    // Si falta cobertura, NO llamamos otra vez al modelo: completamos con placeholders mínimos (evita timeout)
    const rows = Array.isArray(parsed?.rows_draft) ? parsed.rows_draft : [];
    const missing = _missingDays_(rows, total);
    if (missing.length) {
      const city = String(parsed?.destination || "Destino").trim() || "Destino";
      missing.forEach((d) => {
        parsed.rows_draft.push({
          day: d,
          start: "",
          end: "",
          activity: `Planificación pendiente (Día ${d})`,
          from: city,
          to: city,
          transport: "",
          duration: "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat",
          notes: "Completar este día con el Info Chat interno.",
          kind: "",
          zone: "",
        });
      });
      parsed.rows_draft.sort((a, b) => (Number(a?.day) || 0) - (Number(b?.day) || 0) || String(a?.start || "").localeCompare(String(b?.start || "")));
    }

    return parsed;
  } catch {
    return parsed;
  }
}

/* ============== Prompts del sistema ============== */
const SYSTEM_INFO = `
Eres el **Info Chat interno** de ITravelByMyOwn: un **experto mundial en turismo** con criterio premium.
Tu objetivo: un plan **impactante, optimizado, realista, secuencial y claro**.
Debes devolver **UN ÚNICO JSON VÁLIDO** (sin texto fuera) listo para tabla.

✅ ARQUITECTURA (OPCIÓN A):
- Tú (INFO) eres la **fuente de verdad** de horarios: start/end por fila en rows_draft.
- El Planner solo valida solapes pequeños; NO inventa ventanas ni rellena horarios.

REGLA 1 — IMPERDIBLES + ALCANCE REAL:
- Identifica imperdibles reales según temporada, clima probable, perfil del grupo, intereses y días.
- Mezcla óptima: ciudad + day-trips (si aplican) sin sacrificar lo esencial urbano.
- Imperdibles deben reflejarse en rows_draft y listarse en imperdibles.
- Day-trips elegidos deben listarse en macro_tours.

REGLA 2 — TRANSPORTE INTELIGENTE (CRÍTICO):
- Evalúa opciones reales (metro/bus/tren + buses interurbanos) y sugiérelas cuando aplique.
- Si existe transporte público eficiente para un day-trip (tren rápido / bus frecuente y razonable), **PRIORIZA transporte público** sobre vehículo.
- Si NO puedes determinar con confianza, usa EXACTAMENTE: "Vehículo alquilado o Tour guiado".
- Dentro de ciudad usa transporte coherente (a pie/metro/bus/taxi/uber) según zonas.
- Cuando sea posible, estima duraciones de transporte con tiempos típicos/realistas; si no hay certeza, usa "Verificar duración en el Info Chat".

REGLA 3 — CLARIDAD POR SUB-PARADAS:
- En recorridos multi-parada (macro-tours o urbano), expresa secuencia como:
  "Destino – Sub-parada" o "Ruta/Área – Sub-parada".
- Cada sub-parada debe ser una fila con start/end, from/to, transport, duration y notes.
- from/to NO deben ir vacíos: completa ambos.

HORARIOS:
- Si el usuario define day_hours, respétalas como base (puedes extender noche si hace falta).
- Si NO define day_hours:
  - PROHIBIDO emitir plantilla rígida repetida (ej. 08:30–19:00 para todos).
  - Genera horarios realistas por filas según ciudad/estación/ritmo.
- Buffers mínimos 15m.
- Actividades diurnas NO entre 01:00–05:00.

COMIDAS (GUÍA FLEXIBLE, NO PRIORITARIA):
- Solo sugiere comidas si aportan valor (icónico/logística/pausa).
- No obligues un bloque diario.
- Evita genéricos como "Restaurante local" sin nombre; si no puedes ser específico, omite la fila.

DURACIÓN (OBLIGATORIO 2 LÍNEAS):
- duration SIEMPRE exactamente:
  "Transporte: <tiempo>"
  "Actividad: <tiempo>"
- Si no puedes estimar, NO inventes: usa
  "Transporte: Verificar duración en el Info Chat" o "Actividad: Verificar duración en el Info Chat"
  manteniendo 2 líneas.

MACRO-TOURS / DAY-TRIPS:
- Un day-trip fuerte dedica el día al tour.
- Debe tener 5–8 sub-paradas.
- Incluye explícitamente al cierre: "Regreso a {ciudad base}" (duración 2 líneas).
- NO colocar day-trips duros el último día.
- NO duplicados bilingües del mismo tour.

AURORAS (SOLO SI ES PLAUSIBLE):
- Por latitud y época del año.
- Si plausible: máximo 1 por día, NO consecutivas, NUNCA el último día; ventana local concreta; transporte coherente.

CALIDAD PREMIUM (PROHIBIDO GENÉRICO):
- Prohibido "Museo de Arte", "Parque local", "Café local", "Restaurante local" como actividad principal sin especificidad.
- Agrupa por zonas; evita va y ven.

CRÍTICO — SALIDA:
- Incluye SIEMPRE rows_draft completo (todas las filas de todos los días) con:
  day, start, end, activity, from, to, transport, duration(2 líneas), notes, kind, zone, opcional _crossDay.
- Si NO viene day_hours en el contexto, devuelve day_hours: [] (no lo inventes).

SALIDA (JSON) (sin texto fuera): usa la estructura del contrato ya conocida.
`.trim();

const SYSTEM_PLANNER = `
Eres **Astra Planner**. Recibes "research_json" del Info Chat interno.
El Info Chat YA DECIDIÓ: actividades, orden, tiempos, transporte y notas.
Tu trabajo: **estructurar y validar** para tabla. **NO aportes creatividad.**

CONTRATO:
- Si research_json incluye rows_draft (o rows_final), esas filas son la verdad.
  → Úsalas como base y SOLO:
    (a) normalizar HH:MM,
    (b) asegurar buffers >=15m cuando falten,
    (c) corregir solapes pequeños moviendo minutos dentro del día,
    (d) completar campos faltantes SIN inventar actividades nuevas.
- NO reescribas "activity": preserva "Destino – Sub-parada".

DAY_HOURS:
- Si viene day_hours (del usuario), úsalo como guía.
- NO inventes day_hours si no viene.
- NO sobreescribas start/end válidos; solo ajusta si hay solape o cae claramente fuera de ventana y es razonable mover.

Si faltan campos:
- from/to: dedúcelos SOLO desde "Destino – Sub-parada" (sin inventar).
- transport: si no hay nada, usa "A pie" para urbano y "Vehículo alquilado o Tour guiado" para out-of-town evidente.
- notes: 1 frase breve accionable (sin inventar POIs nuevos).

SALIDA ÚNICA (JSON):
{
  "destination":"Ciudad",
  "rows":[{"day":1,"start":"HH:MM","end":"HH:MM","activity":"","from":"","to":"","transport":"","duration":"","notes":"","kind":"","zone":""}],
  "followup":""
}

REGLAS:
- JSON válido, sin texto fuera.
- NO inventes tours/actividades nuevas.
- Evita solapes.
- No pongas actividades diurnas entre 01:00–05:00.
- "Regreso a {ciudad}" debe ser última fila del day-trip si aplica.
- duration: 2 líneas obligatorias; si no conoces: "Verificar duración en el Info Chat".
- MODO ACOTADO: si viene "target_day", devuelve SOLO filas de ese día.
`.trim();

/* ============== Handler principal ============== */
export default async function handler(req, res) {
  // leer body/mode temprano para catch/fallback correcto
  let safeBody = {};
  let safeMode = "planner";
  try {
    safeBody = parseBody(req?.body);
    safeMode = String(safeBody?.mode || "planner").toLowerCase();
  } catch {}

  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = safeBody;
    const mode = safeMode;

    // si falta API key → fallback por modo (evita crash y timeouts)
    if (!process.env.OPENAI_API_KEY) {
      if (mode === "info") {
        const context = body?.context || body || {};
        return res.status(200).json({ text: JSON.stringify(fallbackInfoJSON(context)) });
      }
      return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
    }

    /* --------- MODO INFO --------- */
    if (mode === "info") {
      let context = body.context;

      if (!context && Array.isArray(body.messages) && body.messages.length) {
        context = { messages: body.messages };
      }
      if (!context && !Array.isArray(body.messages)) {
        const { mode: _m, ...rest } = body || {};
        context = rest;
      }

      // sanitizar day_hours entrante si parece plantilla rígida
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

      const daysTotalHint = context?.days_total || context?.days || context?.daysTotal || 1;
      const infoUserMsg = { role: "user", content: JSON.stringify({ context }, null, 2) };

      // 1) intento principal (acotado para velocidad)
      let raw = await callText([{ role: "system", content: SYSTEM_INFO }, infoUserMsg], 0.3, 2600);
      let parsed = cleanToJSONPlus(raw);

      // 2) si falla quality gate, un SOLO repair (evita timeouts por loops)
      if (parsed) {
        const audit = _validateInfoResearch_(parsed, { days_total: daysTotalHint });
        if (!audit.ok) {
          const repairPrompt = `
${SYSTEM_INFO}

REPARACIÓN (OBLIGATORIA):
Fallos:
- ${audit.issues.join("\n- ")}

Corrige SIN texto fuera del JSON.
Recuerda:
- rows_draft cubre 1..days_total
- duration: 2 líneas
- evita genéricos
- auroras: no consecutivas, no último día
- macro-tour: 5–8 sub-paradas + "Regreso a {ciudad base}"
- day_hours: NO inventar

Responde SOLO JSON válido.
`.trim();

          const repairRaw = await callText([{ role: "system", content: repairPrompt }, infoUserMsg], 0.22, 2600);
          const repaired = cleanToJSONPlus(repairRaw);
          if (repaired) parsed = repaired;
        }
      }

      // fallback si no parseó
      if (!parsed) {
        parsed = fallbackInfoJSON(context || {});
      } else {
        // enforcements locales + completar cobertura sin más llamadas
        parsed = _enforceInfoHardRules_(parsed, daysTotalHint);

        // si por cualquier motivo rows_draft quedó vacío, fallback INFO
        try {
          if (!Array.isArray(parsed?.rows_draft) || !parsed.rows_draft.length) {
            parsed = fallbackInfoJSON(context || {});
          }
        } catch {}
      }

      parsed = normalizeDurationsInParsed(parsed);
      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    /* --------- MODO PLANNER --------- */
    if (mode === "planner") {
      // validate=true no llama al modelo
      try {
        if (body && body.validate === true && Array.isArray(body.rows)) {
          const out = { allowed: body.rows, rejected: [] };
          return res.status(200).json({ text: JSON.stringify(out) });
        }
      } catch {}

      const research = body.research_json || null;

      // camino legado (mensajes del cliente)
      if (!research) {
        const clientMessages = extractMessages(body);

        let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, ...clientMessages], 0.28, 2200);
        let parsed = cleanToJSONPlus(raw);

        if (!parsed) parsed = fallbackJSON();

        // completa from/to desde activity si vienen vacíos
        try {
          if (Array.isArray(parsed?.rows)) parsed.rows = _fillFromToFromActivity_(parsed.rows);
        } catch {}

        parsed = normalizeDurationsInParsed(parsed);
        return res.status(200).json({ text: JSON.stringify(parsed) });
      }

      // camino nuevo (research_json directo)
      const plannerUserPayload = {
        research_json: research,
        target_day: body.target_day ?? null,
        day_hours: body.day_hours ?? null,
        existing_rows: body.existing_rows ?? null,
      };

      const plannerUserMsg = { role: "user", content: JSON.stringify(plannerUserPayload, null, 2) };

      let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, plannerUserMsg], 0.28, 2200);
      let parsed = cleanToJSONPlus(raw);

      // 1 repair como máximo si quality gate falla
      if (parsed) {
        const audit = _validatePlannerOutput_(parsed);
        if (!audit.ok) {
          const repairPlanner = `
${SYSTEM_PLANNER}

REPARACIÓN (OBLIGATORIA):
Fallos:
- ${audit.issues.join("\n- ")}

Reglas:
- NO inventes nuevas actividades.
- Usa research_json.rows_draft como verdad.
- NO reescribas "activity".
- duration: 2 líneas.
- day_hours solo guía si viene.

Responde SOLO JSON válido.
`.trim();

          const repairRaw = await callText([{ role: "system", content: repairPlanner }, plannerUserMsg], 0.2, 2200);
          const repaired = cleanToJSONPlus(repairRaw);
          if (repaired) parsed = repaired;
        }
      }

      if (!parsed) parsed = fallbackJSON();

      // completa from/to desde activity si vienen vacíos
      try {
        if (Array.isArray(parsed?.rows)) parsed.rows = _fillFromToFromActivity_(parsed.rows);
      } catch {}

      parsed = normalizeDurationsInParsed(parsed);
      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    return res.status(400).json({ error: "Invalid mode" });
  } catch (err) {
    console.error("❌ /api/chat error:", err);

    // fallback respetando modo para no romper INFO→PLANNER
    try {
      if (safeMode === "info") {
        const context = safeBody?.context || safeBody || {};
        return res.status(200).json({ text: JSON.stringify(fallbackInfoJSON(context)) });
      }
    } catch {}

    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
