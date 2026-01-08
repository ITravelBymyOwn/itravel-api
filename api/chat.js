// /api/chat.js — v50 (ESM, Vercel)
// Doble etapa: (1) INFO (decide y entrega rows_draft “listo para tabla”) → (2) PLANNER (normaliza/valida/auto-repara mínimamente).
// Respuesta SIEMPRE: { text: "<JSON|texto>" }.
// ⚠️ NO incluye lógica del Info Chat EXTERNO (vive en /api/info-public.js).
//
// Objetivo v50:
// 1) Endurecer contrato INFO (Destino – Sub-parada, from/to/transport obligatorios, auroras nocturnas, day-trips coherentes).
// 2) Quality gate REAL (rechaza: activity sin " – ", from/to vacíos, transport vacío, "Transporte: 0m", auroras de día, macro-tour mal armado, duplicados fuertes).
// 3) Auto-repair máximo 1 vez por modo (para performance).
// 4) Planner aplica “normalización mínima segura” cuando INFO falla en detalles (sin inventar POIs):
//    - si activity no trae " – ", lo convierte a `${destination} – ${activity}` y llena from/to.
//    - si transport viene vacío -> set por heurística segura.
//    - si duration trae "Transporte: 0m" -> "Verificar duración..." (sin inventar).
//    - si aurora está fuera de ventana nocturna y existe aurora.window_local -> la encaja a esa ventana (misma day).
//
// Mantiene compat con tu UI/otros códigos: mismos campos, mismos modos, mismo shape de respuesta.

import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ===================== Utils ===================== */
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

/* ===================== Responses API call (con timeout) ===================== */
async function callText(messages, temperature = 0.3, max_output_tokens = 2600, timeoutMs = 55000) {
  const inputStr = messages
    .map((m) => {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${String(m.role || "user").toUpperCase()}: ${c}`;
    })
    .join("\n\n");

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await client.responses.create(
      {
        model: "gpt-4o-mini",
        temperature,
        max_output_tokens,
        input: inputStr,
      },
      { signal: controller.signal }
    );

    return resp?.output_text?.trim() || resp?.output?.[0]?.content?.[0]?.text?.trim() || "";
  } catch (e) {
    return ""; // forzar fallback/repair rápido
  } finally {
    clearTimeout(t);
  }
}

/* ===================== Normalización de duraciones ===================== */
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

  const touchRows = (rows = []) => rows.map((r) => ({ ...r, duration: norm(r.duration) }));

  try {
    if (Array.isArray(parsed.rows)) parsed.rows = touchRows(parsed.rows);
    if (Array.isArray(parsed.rows_draft)) parsed.rows_draft = touchRows(parsed.rows_draft);
    if (Array.isArray(parsed.destinations)) {
      parsed.destinations = parsed.destinations.map((d) => ({
        ...d,
        rows: Array.isArray(d.rows) ? touchRows(d.rows) : d.rows,
        rows_draft: Array.isArray(d.rows_draft) ? touchRows(d.rows_draft) : d.rows_draft,
      }));
    }
    if (Array.isArray(parsed.itineraries)) {
      parsed.itineraries = parsed.itineraries.map((it) => ({
        ...it,
        rows: Array.isArray(it.rows) ? touchRows(it.rows) : it.rows,
        rows_draft: Array.isArray(it.rows_draft) ? touchRows(it.rows_draft) : it.rows_draft,
      }));
    }
  } catch {}

  return parsed;
}

/* ===================== Canon helpers ===================== */
function _canonTxt_(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _hasTwoLineDuration_(duration) {
  const s = String(duration || "");
  return /Transporte\s*:\s*.*\nActividad\s*:\s*/i.test(s);
}

function _rowsHaveCoverage_(rows, daysTotal) {
  if (!Array.isArray(rows) || !rows.length) return false;
  const need = Math.max(1, Number(daysTotal) || 1);
  const present = new Set(rows.map((r) => Number(r.day) || 1));
  for (let d = 1; d <= need; d++) {
    if (!present.has(d)) return false;
  }
  return true;
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
    "museos y cultura local",
  ];

  if (t.length <= 10 && /^(museo|parque|cafe|restaurante|plaza|mercado)$/i.test(t)) return true;
  if (bad.some((b) => t === b || t.includes(b))) return true;
  if (/^(museo|parque|cafe|restaurante)\b/i.test(t) && t.split(" ").length <= 3) return true;

  return false;
}

function _activityHasDestDash_(activity) {
  const s = String(activity || "");
  // Acepta " – " (en dash) o " - "
  return /\s[–-]\s/.test(s);
}

function _isAurora_(activity) {
  return /auroras?|aurora|northern\s*lights/i.test(String(activity || ""));
}

function _isMacroTourKey_(activity) {
  const t = _canonTxt_(activity);
  return /golden circle|circulo dorado|day trip|excursion|tour\b/.test(t);
}

function _parseTimeToMin_(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function _isNightWindow_(startHHMM, endHHMM) {
  const s = _parseTimeToMin_(startHHMM);
  const e = _parseTimeToMin_(endHHMM);
  if (s == null || e == null) return false;
  // noche: >= 18:00 o < 05:00
  const isNightPoint = (min) => min >= 18 * 60 || min < 5 * 60;
  // permite cruces de medianoche
  if (e <= s) {
    // cruza medianoche => válido si el inicio o fin cae en noche
    return isNightPoint(s) || isNightPoint(e);
  }
  return isNightPoint(s) && isNightPoint(e);
}

function _hasZeroTransport_(duration) {
  const s = String(duration || "");
  return /Transporte\s*:\s*0m/i.test(s);
}

/* ===================== day_hours sanitizer (mantener compat) ===================== */
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

/* ===================== Quality Gate INFO (nuevo y más duro) ===================== */
function _validateInfoResearch_(parsed, contextHint = {}) {
  const issues = [];

  const daysTotal = Math.max(1, Number(parsed?.days_total || contextHint?.days_total || 1));
  const rows = Array.isArray(parsed?.rows_draft) ? parsed.rows_draft : [];

  if (!rows.length) issues.push("rows_draft vacío o ausente (obligatorio).");
  if (rows.length && !_rowsHaveCoverage_(rows, daysTotal)) issues.push("rows_draft no cubre todos los días 1..days_total.");

  // duration formato + no “Transporte: 0m”
  if (rows.length && rows.some((r) => !_hasTwoLineDuration_(r.duration))) {
    issues.push('duration no cumple formato 2 líneas ("Transporte" + "Actividad") en una o más filas.');
  }
  if (rows.length && rows.some((r) => _hasZeroTransport_(r.duration))) {
    issues.push('hay filas con "Transporte: 0m" (prohibido).');
  }

  // activity: no genérico y debe tener "Destino – Sub-parada"
  if (rows.length && rows.some((r) => _isGenericPlaceholderActivity_(r.activity))) {
    issues.push("hay placeholders genéricos en activity.");
  }
  if (rows.length && rows.some((r) => !_activityHasDestDash_(r.activity))) {
    issues.push('hay activity sin formato "Destino – Sub-parada" (obligatorio).');
  }

  // from/to/transport obligatorios
  if (rows.length && rows.some((r) => !String(r.from || "").trim() || !String(r.to || "").trim())) {
    issues.push("hay filas con from/to vacíos (obligatorio).");
  }
  if (rows.length && rows.some((r) => !String(r.transport || "").trim())) {
    issues.push("hay filas con transport vacío (obligatorio).");
  }

  // AURORAS: no consecutivas, no último día, y SOLO en noche
  const auroraDays = rows
    .filter((r) => _isAurora_(r.activity))
    .map((r) => Number(r.day))
    .sort((a, b) => a - b);

  for (let i = 1; i < auroraDays.length; i++) {
    if (auroraDays[i] === auroraDays[i - 1] + 1) {
      issues.push("auroras programadas en días consecutivos (no permitido).");
      break;
    }
  }
  if (auroraDays.includes(daysTotal)) issues.push("auroras programadas en el último día (no permitido).");

  const auroraBadTime = rows.some((r) => _isAurora_(r.activity) && !_isNightWindow_(r.start, r.end));
  if (auroraBadTime) issues.push("hay auroras fuera de horario nocturno (prohibido).");

  // MACRO-TOURS: si hay macro-tour en un día, exigir >=5 sub-paradas y cierre “Regreso a {base}”
  // (heurística: si ese día tiene actividades con key macro, debe ser day-trip dedicado y con retorno)
  const baseCity = String(parsed?.destination || contextHint?.destination || "").trim();
  const byDay = new Map();
  rows.forEach((r) => {
    const d = Number(r.day) || 1;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(r);
  });

  for (let d = 1; d <= daysTotal; d++) {
    const dayRows = byDay.get(d) || [];
    const hasMacro = dayRows.some((r) => _isMacroTourKey_(r.activity));
    if (!hasMacro) continue;

    // contar sub-paradas “macro-ish” ese día
    const macroishCount = dayRows.filter((r) => _isMacroTourKey_(r.activity) || _canonTxt_(r.zone).includes("circulo") || _canonTxt_(r.zone).includes("golden")).length;
    if (macroishCount < 5) issues.push(`macro-tour en día ${d} sin suficientes sub-paradas (mínimo 5).`);

    // exigir regreso a base (texto flexible pero debe existir)
    const hasReturn = dayRows.some((r) => _canonTxt_(r.activity).includes("regreso") && (_canonTxt_(r.activity).includes(_canonTxt_(baseCity)) || !baseCity));
    if (!hasReturn) issues.push(`macro-tour en día ${d} sin fila explícita de "Regreso a ${baseCity || "la ciudad base"}".`);

    // no macro-tour duro en último día
    if (d === daysTotal) issues.push("macro-tour/day-trip en el último día (no permitido).");
  }

  // Duplicados fuertes: mismo macro key en múltiples días
  const macroKeysByDay = {};
  rows.forEach((r) => {
    const t = _canonTxt_(r.activity);
    if (!t) return;
    if (/golden circle|circulo dorado/.test(t)) {
      macroKeysByDay["golden_circle"] = macroKeysByDay["golden_circle"] || new Set();
      macroKeysByDay["golden_circle"].add(Number(r.day) || 1);
    }
  });
  if (macroKeysByDay["golden_circle"] && macroKeysByDay["golden_circle"].size > 1) {
    issues.push(`"Golden Circle/Círculo Dorado" aparece en múltiples días (${[...macroKeysByDay["golden_circle"]].join(", ")}).`);
  }

  return { ok: issues.length === 0, issues };
}

/* ===================== Quality Gate PLANNER (más duro + seguro) ===================== */
function _validatePlannerOutput_(parsed) {
  try {
    const issues = [];
    const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    if (!rows.length) issues.push("rows vacío o ausente (obligatorio).");

    if (rows.length && rows.some((r) => !_hasTwoLineDuration_(r?.duration))) {
      issues.push('duration no cumple formato 2 líneas ("Transporte" + "Actividad").');
    }
    if (rows.length && rows.some((r) => _hasZeroTransport_(r?.duration))) {
      issues.push('hay "Transporte: 0m" (prohibido).');
    }
    if (rows.length && rows.some((r) => _isGenericPlaceholderActivity_(r?.activity))) {
      issues.push("hay placeholders genéricos en activity.");
    }
    if (rows.length && rows.some((r) => !_activityHasDestDash_(r?.activity) && !_isAurora_(r?.activity))) {
      issues.push('hay activity sin formato "Destino – Sub-parada".');
    }
    if (rows.length && rows.some((r) => !String(r?.from || "").trim() || !String(r?.to || "").trim())) {
      issues.push("hay filas con from/to vacíos.");
    }
    if (rows.length && rows.some((r) => !String(r?.transport || "").trim())) {
      issues.push("hay filas con transport vacío.");
    }
    if (rows.length && rows.some((r) => _isAurora_(r?.activity) && !_isNightWindow_(r?.start, r?.end))) {
      issues.push("hay auroras fuera de horario nocturno.");
    }

    if (rows.length && rows.some((r) => Number(r?.day) < 1 || !Number.isFinite(Number(r?.day)))) {
      issues.push("hay filas con 'day' inválido.");
    }

    return { ok: issues.length === 0, issues };
  } catch {
    return { ok: true, issues: [] };
  }
}

/* ===================== Normalizador “mínimo seguro” del PLANNER (sin inventar POIs) ===================== */
function _splitActivity_(activity) {
  const s = String(activity || "");
  const m = s.match(/^(.*?)\s[–-]\s(.*)$/);
  if (!m) return null;
  return { dest: String(m[1] || "").trim(), sub: String(m[2] || "").trim() };
}

function _ensureTwoLineDuration_(duration) {
  const s = String(duration || "").trim();
  if (_hasTwoLineDuration_(s)) return s || "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat";
  return "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat";
}

function _replaceZeroTransport_(duration) {
  const s = _ensureTwoLineDuration_(duration);
  if (!_hasZeroTransport_(s)) return s;
  return s.replace(/Transporte\s*:\s*0m/i, "Transporte: Verificar duración en el Info Chat");
}

function _inferTransportSafe_(row, destination, research) {
  const existing = String(row.transport || "").trim();
  if (existing) return existing;

  const zone = _canonTxt_(row.zone);
  const kind = _canonTxt_(row.kind);
  const act = _canonTxt_(row.activity);

  // Aurora o fuera de ciudad => seguro
  if (_isAurora_(row.activity)) return "Vehículo alquilado o Tour guiado";
  if (zone.includes("fuera") || zone.includes("out") || zone.includes("golden") || zone.includes("circulo")) return "Vehículo alquilado o Tour guiado";
  if (/lagoon|blue lagoon|thingvellir|geysir|gullfoss|sn[aæ]fells/i.test(act)) return "Vehículo alquilado o Tour guiado";

  // Macro tours declarados => seguro
  const macros = Array.isArray(research?.macro_tours) ? research.macro_tours.map(_canonTxt_) : [];
  if (macros.some((m) => m && act.includes(m))) return "Vehículo alquilado o Tour guiado";
  if (_isMacroTourKey_(row.activity)) return "Vehículo alquilado o Tour guiado";

  // Urbano por defecto
  if (kind.includes("cultural") || kind.includes("gastr") || kind.includes("shopping") || zone.includes("centro") || act.includes(_canonTxt_(destination))) {
    return "A pie";
  }

  return "Vehículo alquilado o Tour guiado";
}

function _normalizeRowsMinimal_(rows, destination, research) {
  return (Array.isArray(rows) ? rows : []).map((r) => {
    const row = { ...r };

    // activity "Destino – Sub-parada"
    if (!_activityHasDestDash_(row.activity)) {
      const a = String(row.activity || "").trim();
      if (a) row.activity = `${destination} – ${a}`;
    }

    // from/to: derivar desde activity si falta
    const parts = _splitActivity_(row.activity);
    if (!String(row.from || "").trim()) row.from = parts?.dest || destination || "";
    if (!String(row.to || "").trim()) row.to = parts?.sub || String(row.to || "").trim() || "";

    // transport
    row.transport = _inferTransportSafe_(row, destination, research);

    // duration: 2 líneas + no 0m
    row.duration = _replaceZeroTransport_(row.duration);

    // notes: no tocar si existe; si no, mantener breve sin inventar POIs
    if (!String(row.notes || "").trim()) row.notes = "";

    return row;
  });
}

/* ===================== Prompts del sistema ===================== */

/* ===================== INFO (interno) ===================== */
const SYSTEM_INFO = `
Eres el **Info Chat interno** de ITravelByMyOwn.
Tu salida será consumida por un Planner que **no inventa POIs**: solo estructura y renderiza lo que tú decidas.
Por eso debes devolver **UN ÚNICO JSON VÁLIDO** (sin texto fuera) listo para tabla.

OBJETIVO: crear un itinerario premium, realista, optimizado, secuencial y claro.

CONTRATO (NO NEGOCIABLE) — rows_draft:
Cada fila DEBE incluir:
- day (1..days_total)
- start "HH:MM", end "HH:MM"
- activity SIEMPRE con formato: "DESTINO – SUB-PARADA" (obligatorio, usa guion largo – o guion normal - con espacios)
- from (obligatorio, NO vacío)
- to (obligatorio, NO vacío)
- transport (obligatorio, NO vacío)
- duration (obligatorio, EXACTAMENTE 2 líneas):
  "Transporte: <tiempo o Verificar duración en el Info Chat>"
  "Actividad: <tiempo o Verificar duración en el Info Chat>"
- notes (1 frase útil)
- kind, zone (pueden ser "" pero preferible llenarlos)

PROHIBIDO:
- activity sin "Destino – Sub-parada"
- from/to vacíos
- transport vacío
- "Transporte: 0m"
- auroras de día
- placeholders genéricos: "Museos y Cultura", "Exploración de la ciudad", "Museo de Arte" sin nombre propio.

DAY_HOURS:
- Si el usuario NO define day_hours en el contexto: NO lo inventes. Devuelve day_hours: [].

TRANSPORTE (regla segura):
- Si no puedes determinar con confianza: usa EXACTAMENTE "Vehículo alquilado o Tour guiado".
- En ciudad: "A pie" es válido si todo es céntrico.

AURORAS (solo si es plausible por latitud/época):
- Si se incluyen: máximo 1 por día, NO consecutivas, NUNCA en el último día.
- Deben estar en horario nocturno (aprox. 18:00–02:00). Nunca 01:00–05:00 para actividades diurnas.
- activity ejemplo: "Auroras – Observación (zona oscura)" con from/to/transport y duration 2 líneas.

MACRO-TOURS / DAY-TRIPS (crítico):
- Un day-trip fuerte ocupa el día.
- Debe tener 5–8 sub-paradas (cada una una fila con "Tour/Área – Sub-parada").
- Debe cerrar con una fila explícita: "{Ciudad base} – Regreso a {Ciudad base}" o "{Ciudad base} – Regreso al hotel".
- No colocar day-trips duros el último día.
- No duplicar el mismo macro-tour en varios días.

COMIDAS:
- No son obligatorias. Solo inclúyelas cuando aporten valor real (icónico o logística). No “rellenes” por rellenar.

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

RESPONDE SOLO JSON VÁLIDO.
`.trim();

/* ===================== PLANNER (estructurador) ===================== */
const SYSTEM_PLANNER = `
Eres **Astra Planner**. Recibes un objeto "research_json" del Info Chat interno.
El Info Chat es la fuente de verdad de actividades/orden/tiempos.
Tu trabajo es **estructurar, normalizar y validar** para renderizar en tabla, sin inventar POIs.

REGLAS:
1) Si research_json.rows_draft existe: úsalo como base.
2) Puedes aplicar correcciones mínimas seguras:
   - Si activity NO trae "Destino – Sub-parada", conviértela a "{destination} – {activity}".
   - Si from/to faltan, derivarlos desde activity (parte izquierda = from, derecha = to).
   - Si transport falta, usa "A pie" para urbano y "Vehículo alquilado o Tour guiado" si es out-of-town/aurora/macro-tour.
   - duration SIEMPRE 2 líneas. Si ves "Transporte: 0m", reemplaza por "Transporte: Verificar duración en el Info Chat".
3) AURORAS: si hay filas con aurora y research_json.aurora.window_local existe, encaja start/end a esa ventana (misma day) sin crear nuevas filas.
4) Evita solapes obvios; buffers >=15m cuando sea razonable. No reescribas POIs.
5) JSON válido, sin texto fuera.

SALIDA:
{
  "destination":"Ciudad",
  "rows":[{"day":1,"start":"HH:MM","end":"HH:MM","activity":"...","from":"...","to":"...","transport":"...","duration":"Transporte: ...\\nActividad: ...","notes":"...","kind":"","zone":""}],
  "followup":""
}

MODO ACOTADO:
- Si viene "target_day", devuelve SOLO filas de ese día.
`.trim();

/* ===================== Handler ===================== */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = parseBody(req.body);
    const mode = String(body.mode || "planner").toLowerCase();

    /* ===================== MODO INFO ===================== */
    if (mode === "info") {
      let context = body.context;

      if (!context && Array.isArray(body.messages) && body.messages.length) {
        context = { messages: body.messages };
      }
      if (!context && !Array.isArray(body.messages)) {
        const { mode: _m, ...rest } = body || {};
        context = rest;
      }

      // Sanitiza day_hours entrante (si viene como plantilla rígida repetida)
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

      // (muy importante) incluir hints del Planner/prefs sin forzar comidas
      // Si el UI manda alwaysIncludeDinner:true pero el usuario no lo quiere como regla dura,
      // el prompt ya declara comidas como NO obligatorias. No tocamos el payload para no romper integraciones.

      const infoUserMsg = { role: "user", content: JSON.stringify({ context }, null, 2) };

      // 1) intento base
      let raw = await callText([{ role: "system", content: SYSTEM_INFO }, infoUserMsg], 0.3, 3000, 55000);
      let parsed = cleanToJSONPlus(raw);

      // 2) intento estricto si no parsea
      if (!parsed) {
        const strict = SYSTEM_INFO + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, infoUserMsg], 0.2, 2600, 45000);
        parsed = cleanToJSONPlus(raw);
      }

      // 3) quality gate + 1 repair máximo (performance)
      if (parsed) {
        const audit = _validateInfoResearch_(parsed, {
          days_total: context?.days_total || context?.days || context?.daysTotal || 1,
          destination: context?.city || parsed?.destination || "",
        });

        if (!audit.ok) {
          const repairPrompt = `
${SYSTEM_INFO}

REPARACIÓN OBLIGATORIA (QUALITY GATE):
Tu JSON anterior falló estas validaciones:
- ${audit.issues.join("\n- ")}

INSTRUCCIONES DE REPARACIÓN (OBLIGATORIO):
- REESCRIBE rows_draft COMPLETO cumpliendo contrato.
- activity SIEMPRE "Destino – Sub-parada".
- from/to/transport SIEMPRE llenos.
- duration 2 líneas, y PROHIBIDO "Transporte: 0m".
- Auroras SOLO nocturnas (18:00–02:00), NO consecutivas, NO último día.
- Si hay Golden Circle/Círculo Dorado: 5–8 sub-paradas + fila final "Regreso a {ciudad base}" y NO en último día.
- No uses placeholders genéricos.
Responde SOLO JSON válido.
`.trim();

          const repairRaw = await callText([{ role: "system", content: repairPrompt }, infoUserMsg], 0.22, 3200, 55000);
          const repaired = cleanToJSONPlus(repairRaw);
          if (repaired) parsed = repaired;
        }
      }

      // 4) fallback mínimo
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
            transport_default: "Vehículo alquilado o Tour guiado",
            note: "Actividad sujeta a clima.",
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
          rows_draft: [],
          rows_skeleton: [],
        };
      }

      parsed = normalizeDurationsInParsed(parsed);
      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    /* ===================== MODO PLANNER ===================== */
    if (mode === "planner") {
      // validate=true no debe llamar al modelo
      try {
        if (body && body.validate === true && Array.isArray(body.rows)) {
          const out = { allowed: body.rows, rejected: [] };
          return res.status(200).json({ text: JSON.stringify(out) });
        }
      } catch {}

      const research = body.research_json || null;

      // Camino legado sin research_json (mantener compat)
      if (!research) {
        const clientMessages = extractMessages(body);

        let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, ...clientMessages], 0.25, 2400, 45000);
        let parsed = cleanToJSONPlus(raw);

        if (!parsed) {
          const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo un JSON válido.`;
          raw = await callText([{ role: "system", content: strict }, ...clientMessages], 0.2, 2200, 40000);
          parsed = cleanToJSONPlus(raw);
        }

        if (!parsed) parsed = fallbackJSON();
        parsed = normalizeDurationsInParsed(parsed);
        return res.status(200).json({ text: JSON.stringify(parsed) });
      }

      const destination = String(research?.destination || research?.city || body?.destination || "").trim() || "Destino";

      // 0) Normalización mínima local (sin inventar POIs)
      let rowsDraft = Array.isArray(research?.rows_draft) ? research.rows_draft : [];
      rowsDraft = _normalizeRowsMinimal_(rowsDraft, destination, research);

      // 0.1) Encajar auroras a ventana si existe (sin inventar; solo mover a la ventana declarada)
      try {
        const win = research?.aurora?.window_local;
        if (win && win.start && win.end) {
          rowsDraft = rowsDraft.map((r) => {
            if (!_isAurora_(r.activity)) return r;
            // si ya es noche y razonable, no tocar
            if (_isNightWindow_(r.start, r.end)) return r;
            return { ...r, start: String(win.start), end: String(win.end) };
          });
        }
      } catch {}

      // Respetar target_day sin depender del modelo (performance)
      const targetDay = body.target_day ?? null;
      if (targetDay != null) {
        const td = Number(targetDay);
        const out = {
          destination,
          rows: rowsDraft.filter((r) => Number(r.day) === td),
          followup: "",
        };
        out.rows = _normalizeRowsMinimal_(out.rows, destination, research).map((r) => ({
          ...r,
          duration: _replaceZeroTransport_(_ensureTwoLineDuration_(r.duration)),
        }));
        return res.status(200).json({ text: JSON.stringify(out) });
      }

      // 1) Intento con el modelo (Planner) SOLO si hace falta (si el draft viene débil o se quiere re-balance)
      // En v50, por performance, preferimos NO llamar al modelo si rows_draft ya existe.
      // Aun así, mantenemos una llamada opcional por compat si deseas (cuando body.force_model === true).
      const forceModel = body.force_model === true;

      if (!forceModel) {
        const out = {
          destination,
          rows: rowsDraft.map((r) => ({
            ...r,
            duration: _replaceZeroTransport_(_ensureTwoLineDuration_(r.duration)),
          })),
          followup: "",
        };

        const auditLocal = _validatePlannerOutput_(out);
        if (auditLocal.ok) {
          return res.status(200).json({ text: JSON.stringify(out) });
        }

        // Si aún falla, hacemos 1 repair con el modelo (máximo 1)
        const plannerUserPayload = {
          research_json: { ...research, rows_draft: rowsDraft },
          day_hours: body.day_hours ?? null,
          existing_rows: body.existing_rows ?? null,
          note: "El JSON debe corregir las validaciones sin inventar POIs nuevos.",
        };

        const plannerUserMsg = { role: "user", content: JSON.stringify(plannerUserPayload, null, 2) };

        const repairPlanner = `
${SYSTEM_PLANNER}

REPARACIÓN OBLIGATORIA:
Falló estas validaciones:
- ${auditLocal.issues.join("\n- ")}

Reglas:
- NO inventes POIs nuevos.
- Arregla activity a "Destino – Sub-parada" si falta.
- Llena from/to/transport.
- duration 2 líneas; prohíbe "Transporte: 0m".
- Auroras nocturnas; si research_json.aurora.window_local existe úsala.

Responde SOLO JSON válido.
`.trim();

        const repairRaw = await callText([{ role: "system", content: repairPlanner }, plannerUserMsg], 0.2, 2400, 45000);
        let repaired = cleanToJSONPlus(repairRaw);

        if (!repaired) {
          // último recurso local
          repaired = out;
        } else {
          // normalización mínima otra vez
          repaired.destination = repaired.destination || destination;
          repaired.rows = _normalizeRowsMinimal_(repaired.rows, destination, research).map((r) => ({
            ...r,
            duration: _replaceZeroTransport_(_ensureTwoLineDuration_(r.duration)),
          }));
          repaired.followup = repaired.followup || "";
        }

        repaired = normalizeDurationsInParsed(repaired);
        return res.status(200).json({ text: JSON.stringify(repaired) });
      }

      // 2) force_model === true -> pipeline modelo clásico
      const plannerUserPayload = {
        research_json: { ...research, rows_draft: rowsDraft },
        day_hours: body.day_hours ?? null,
        existing_rows: body.existing_rows ?? null,
      };
      const plannerUserMsg = { role: "user", content: JSON.stringify(plannerUserPayload, null, 2) };

      let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, plannerUserMsg], 0.25, 2400, 45000);
      let parsed = cleanToJSONPlus(raw);

      if (!parsed) {
        const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, plannerUserMsg], 0.2, 2200, 40000);
        parsed = cleanToJSONPlus(raw);
      }

      if (!parsed) parsed = { destination, rows: rowsDraft, followup: "" };

      // Normalización final
      parsed.destination = parsed.destination || destination;
      parsed.rows = _normalizeRowsMinimal_(parsed.rows, destination, research).map((r) => ({
        ...r,
        duration: _replaceZeroTransport_(_ensureTwoLineDuration_(r.duration)),
      }));
      parsed.followup = parsed.followup || "";

      // Auditoría + 1 repair máximo
      const audit = _validatePlannerOutput_(parsed);
      if (!audit.ok) {
        const repairPlanner = `
${SYSTEM_PLANNER}

REPARACIÓN OBLIGATORIA:
Falló estas validaciones:
- ${audit.issues.join("\n- ")}

Reglas:
- NO inventes POIs nuevos.
- Usa research_json.rows_draft como base.
- Asegura "Destino – Sub-parada", from/to/transport y duration 2 líneas sin "Transporte: 0m".
- Auroras nocturnas y coherentes con window_local si existe.

Responde SOLO JSON válido.
`.trim();

        const repairRaw = await callText([{ role: "system", content: repairPlanner }, plannerUserMsg], 0.2, 2400, 45000);
        const repaired = cleanToJSONPlus(repairRaw);
        if (repaired) parsed = repaired;

        parsed.destination = parsed.destination || destination;
        parsed.rows = _normalizeRowsMinimal_(parsed.rows, destination, research).map((r) => ({
          ...r,
          duration: _replaceZeroTransport_(_ensureTwoLineDuration_(r.duration)),
        }));
        parsed.followup = parsed.followup || "";
      }

      parsed = normalizeDurationsInParsed(parsed);
      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    return res.status(400).json({ error: "Invalid mode" });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
