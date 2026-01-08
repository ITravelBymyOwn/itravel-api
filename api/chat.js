// /api/chat.js — v51 (ESM, Vercel)
// Basado QUIRÚRGICAMENTE en tu v50.
// Cambio clave: INFO planifica TODO y devuelve bloques ordenados "Ciudad–Día" (city_day[]).
// PLANNER consume city_day en orden y monta tablas (sin inventar POIs). Mantiene compat con rows_draft.
//
// Respuesta SIEMPRE: { text: "<JSON|texto>" }.
// ⚠️ NO incluye lógica del Info Chat EXTERNO (vive en /api/info-public.js).

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
    return "";
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

    // Si ya viene en 2 líneas, no tocar
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

    // 🆕 city_day
    if (Array.isArray(parsed.city_day)) {
      parsed.city_day = parsed.city_day.map((b) => ({
        ...b,
        rows: Array.isArray(b.rows) ? touchRows(b.rows) : b.rows,
      }));
    }

    if (Array.isArray(parsed.destinations)) {
      parsed.destinations = parsed.destinations.map((d) => ({
        ...d,
        rows: Array.isArray(d.rows) ? touchRows(d.rows) : d.rows,
        rows_draft: Array.isArray(d.rows_draft) ? touchRows(d.rows_draft) : d.rows_draft,
        city_day: Array.isArray(d.city_day)
          ? d.city_day.map((b) => ({ ...b, rows: Array.isArray(b.rows) ? touchRows(b.rows) : b.rows }))
          : d.city_day,
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
    "cena en restaurante",
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

  const isNightPoint = (min) => min >= 18 * 60 || min < 5 * 60;

  if (e <= s) return isNightPoint(s) || isNightPoint(e);
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

/* ===================== city_day helpers ===================== */
function _flattenCityDayToRows_(research, fallbackDestination = "Destino") {
  const destination = String(research?.destination || research?.city || fallbackDestination || "Destino").trim() || "Destino";

  // Caso A: city_day a nivel raíz
  if (Array.isArray(research?.city_day) && research.city_day.length) {
    const blocks = research.city_day
      .filter((b) => b && (String(b.city || b.destination || "").trim() || destination))
      .map((b) => ({
        city: String(b.city || b.destination || destination).trim() || destination,
        day: Number(b.day) || 1,
        rows: Array.isArray(b.rows) ? b.rows : [],
      }))
      .sort((a, b) => a.day - b.day);

    const rows = [];
    blocks.forEach((b) => {
      (b.rows || []).forEach((r) => rows.push({ ...r, day: Number(r.day) || b.day || 1 }));
    });

    return { destination, city_day: blocks, rows_draft: rows };
  }

  // Caso B: legacy rows_draft
  if (Array.isArray(research?.rows_draft) && research.rows_draft.length) {
    return { destination, city_day: null, rows_draft: research.rows_draft };
  }

  return { destination, city_day: null, rows_draft: [] };
}

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

  if (_isAurora_(row.activity)) return "Vehículo alquilado o Tour guiado";
  if (zone.includes("fuera") || zone.includes("out") || zone.includes("golden") || zone.includes("circulo")) return "Vehículo alquilado o Tour guiado";
  if (/lagoon|blue lagoon|thingvellir|geysir|gullfoss|sn[aæ]fells/i.test(act)) return "Vehículo alquilado o Tour guiado";

  const macros = Array.isArray(research?.macro_tours) ? research.macro_tours.map(_canonTxt_) : [];
  if (macros.some((m) => m && act.includes(m))) return "Vehículo alquilado o Tour guiado";
  if (_isMacroTourKey_(row.activity)) return "Vehículo alquilado o Tour guiado";

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

    // notes: no inventar POIs
    if (!String(row.notes || "").trim()) row.notes = "";

    return row;
  });
}

/* ===================== Quality Gate INFO (ahora valida city_day o rows_draft) ===================== */
function _validateInfoResearch_(parsed, contextHint = {}) {
  const issues = [];

  const daysTotal = Math.max(1, Number(parsed?.days_total || contextHint?.days_total || 1));
  const destination = String(parsed?.destination || contextHint?.destination || contextHint?.city || "").trim();

  // Acepta city_day[] (preferido) o rows_draft (legacy)
  let rows = [];
  if (Array.isArray(parsed?.city_day) && parsed.city_day.length) {
    const blocks = parsed.city_day;
    blocks.forEach((b) => {
      const bd = Number(b?.day) || 1;
      const br = Array.isArray(b?.rows) ? b.rows : [];
      br.forEach((r) => rows.push({ ...r, day: Number(r.day) || bd }));
    });
  } else if (Array.isArray(parsed?.rows_draft)) {
    rows = parsed.rows_draft;
  }

  if (!rows.length) issues.push("rows_draft/city_day vacío o ausente (obligatorio).");
  if (rows.length && !_rowsHaveCoverage_(rows, daysTotal)) issues.push("No cubre todos los días 1..days_total.");

  if (rows.length && rows.some((r) => !_hasTwoLineDuration_(r.duration))) {
    issues.push('duration no cumple 2 líneas ("Transporte" + "Actividad").');
  }
  if (rows.length && rows.some((r) => _hasZeroTransport_(r.duration))) {
    issues.push('hay "Transporte: 0m" (prohibido).');
  }

  if (rows.length && rows.some((r) => _isGenericPlaceholderActivity_(r.activity))) {
    issues.push("hay placeholders genéricos en activity.");
  }
  if (rows.length && rows.some((r) => !_activityHasDestDash_(r.activity))) {
    issues.push('hay activity sin formato "Destino – Sub-parada" (obligatorio).');
  }

  if (rows.length && rows.some((r) => !String(r.from || "").trim() || !String(r.to || "").trim())) {
    issues.push("hay filas con from/to vacíos (obligatorio).");
  }
  if (rows.length && rows.some((r) => !String(r.transport || "").trim())) {
    issues.push("hay filas con transport vacío (obligatorio).");
  }

  // Auroras
  const auroraRows = rows.filter((r) => _isAurora_(r.activity));
  const auroraDays = auroraRows.map((r) => Number(r.day) || 1).sort((a, b) => a - b);
  for (let i = 1; i < auroraDays.length; i++) {
    if (auroraDays[i] === auroraDays[i - 1] + 1) {
      issues.push("auroras en días consecutivos (no permitido).");
      break;
    }
  }
  if (auroraDays.includes(daysTotal)) issues.push("auroras en el último día (no permitido).");
  if (auroraRows.some((r) => !_isNightWindow_(r.start, r.end))) issues.push("hay auroras fuera de ventana nocturna (prohibido).");

  // Macro-tours por día (heurística segura)
  const baseCity = String(parsed?.destination || contextHint?.destination || "").trim() || destination;
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

    const macroishCount = dayRows.filter((r) => _isMacroTourKey_(r.activity) || _canonTxt_(r.zone).includes("circulo") || _canonTxt_(r.zone).includes("golden")).length;
    if (macroishCount < 5) issues.push(`macro-tour en día ${d} con <5 sub-paradas (mínimo 5).`);

    const hasReturn = dayRows.some((r) => {
      const a = _canonTxt_(r.activity);
      return a.includes("regreso") && (baseCity ? a.includes(_canonTxt_(baseCity)) : true);
    });
    if (!hasReturn) issues.push(`macro-tour en día ${d} sin "Regreso a ${baseCity || "ciudad base"}".`);

    if (d === daysTotal) issues.push("macro-tour/day-trip en el último día (no permitido).");
  }

  return { ok: issues.length === 0, issues };
}

/* ===================== Quality Gate PLANNER (seguro) ===================== */
function _validatePlannerOutput_(parsed) {
  try {
    const issues = [];
    const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    if (!rows.length) issues.push("rows vacío o ausente (obligatorio).");

    if (rows.length && rows.some((r) => !_hasTwoLineDuration_(r?.duration))) issues.push('duration no cumple 2 líneas.');
    if (rows.length && rows.some((r) => _hasZeroTransport_(r?.duration))) issues.push('hay "Transporte: 0m".');
    if (rows.length && rows.some((r) => _isGenericPlaceholderActivity_(r?.activity))) issues.push("placeholders genéricos en activity.");
    if (rows.length && rows.some((r) => !_activityHasDestDash_(r?.activity) && !_isAurora_(r?.activity)))
      issues.push('activity sin "Destino – Sub-parada".');
    if (rows.length && rows.some((r) => !String(r?.from || "").trim() || !String(r?.to || "").trim())) issues.push("from/to vacíos.");
    if (rows.length && rows.some((r) => !String(r?.transport || "").trim())) issues.push("transport vacío.");
    if (rows.length && rows.some((r) => _isAurora_(r?.activity) && !_isNightWindow_(r?.start, r?.end))) issues.push("auroras fuera de noche.");
    if (rows.length && rows.some((r) => Number(r?.day) < 1 || !Number.isFinite(Number(r?.day)))) issues.push("day inválido.");

    return { ok: issues.length === 0, issues };
  } catch {
    return { ok: true, issues: [] };
  }
}

/* ===================== Prompts ===================== */

/* ===================== INFO (interno) ===================== */
const SYSTEM_INFO = `
Eres el **Info Chat interno** de ITravelByMyOwn.
Tu salida será consumida por un Planner que NO inventa POIs: solo estructura/renderiza lo que tú decidas.
Debes devolver **UN ÚNICO JSON VÁLIDO** (sin texto fuera).

OBJETIVO:
1) Primero PIENSA el itinerario completo (evita repeticiones/contradicciones).
2) Luego entrega el resultado por bloques **Ciudad–Día** en un arreglo ordenado: city_day[].

CONTRATO (NO NEGOCIABLE) — city_day:
- Debes devolver city_day: [ { city:"Reykjavik", day:1, rows:[...] }, {city:"Reykjavik", day:2, rows:[...]}, ... ]
- El orden de city_day es el orden final de render.
- Dentro de rows, cada fila DEBE incluir:
  day, start "HH:MM", end "HH:MM",
  activity SIEMPRE "DESTINO – SUB-PARADA" (usa – o - con espacios),
  from (NO vacío), to (NO vacío), transport (NO vacío),
  duration EXACTAMENTE 2 líneas:
    "Transporte: <tiempo o Verificar duración en el Info Chat>"
    "Actividad: <tiempo o Verificar duración en el Info Chat>"
  notes (1 frase útil),
  kind, zone (pueden ser "" pero preferible llenarlos).

PROHIBIDO:
- activity sin "Destino – Sub-parada"
- from/to vacíos
- transport vacío
- "Transporte: 0m"
- auroras de día
- placeholders genéricos ("Museos y Cultura", "Exploración de la ciudad", "Restaurante local", etc.)
- repetir el mismo macro-tour en varios días

DAY_HOURS:
- Si el usuario NO define day_hours en el contexto: NO lo inventes. Devuelve day_hours: [].

SI EL USUARIO NO INDICA HORAS:
- Asume días completos (sin imponer plantilla rígida repetida).
- Crea horarios realistas por filas, con buffers ~15m.

TRANSPORTE:
- Si no puedes determinar con confianza: usa EXACTAMENTE "Vehículo alquilado o Tour guiado".
- En ciudad: "A pie" es válido si es céntrico.

AURORAS (solo si plausible por latitud/época):
- máximo 1 por día, NO consecutivas, NUNCA en el último día.
- SIEMPRE en noche (aprox. 18:00–02:00).
- activity ejemplo: "{Destino} – Auroras: Observación (zona oscura)".

MACRO-TOURS / DAY-TRIPS:
- Un day-trip fuerte ocupa el día.
- Debe tener 5–8 sub-paradas (cada una una fila: "Tour/Área – Sub-parada").
- Debe cerrar con fila explícita: "{Destino} – Regreso a {Destino}" o "{Destino} – Regreso al hotel".
- No day-trips duros el último día.

COMIDAS:
- NO son obligatorias. Solo inclúyelas si aportan valor real (icónico/logística).

SALIDA (JSON) — estructura mínima:
{
  "destination":"Ciudad base principal si aplica",
  "country":"País",
  "days_total":1,
  "hotel_base":"...",
  "rationale":"...",
  "imperdibles":["..."],
  "macro_tours":["..."],
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
  "city_day":[
    {
      "city":"Ciudad",
      "day":1,
      "rows":[
        {"day":1,"start":"HH:MM","end":"HH:MM","activity":"Destino – Sub-parada","from":"...","to":"...","transport":"...","duration":"Transporte: ...\\nActividad: ...","notes":"...","kind":"","zone":""}
      ]
    }
  ]
}

RESPONDE SOLO JSON VÁLIDO.
`.trim();

/* ===================== PLANNER (estructurador) ===================== */
const SYSTEM_PLANNER = `
Eres **Astra Planner**. Recibes "research_json" del Info Chat interno.
El Info Chat es fuente de verdad de actividades/orden/tiempos.
Tu trabajo: estructurar/normalizar/validar para render, SIN inventar POIs.

REGLAS:
1) Si research_json.city_day existe: úsalo como fuente primaria (ordenado).
2) Si no existe, usa research_json.rows_draft (legacy).
3) Correcciones mínimas seguras:
   - Si activity no trae "Destino – Sub-parada": conviértela a "{destination} – {activity}".
   - Si from/to faltan: derivar desde activity.
   - Si transport falta: "A pie" urbano, si aurora/out-of-town -> "Vehículo alquilado o Tour guiado".
   - duration SIEMPRE 2 líneas. Si "Transporte: 0m" -> "Verificar duración...".
4) AURORAS: si research_json.aurora.window_local existe, encaja start/end a esa ventana (misma day).
5) Evita solapes obvios; buffers >=15m cuando sea razonable. No reescribas POIs.
6) JSON válido, sin texto fuera.

SALIDA (compat):
{
  "destination":"Ciudad",
  "rows":[...],
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

      // Sanitiza day_hours entrante (plantilla rígida repetida)
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

      const infoUserMsg = { role: "user", content: JSON.stringify({ context }, null, 2) };

      // 1) intento base
      let raw = await callText([{ role: "system", content: SYSTEM_INFO }, infoUserMsg], 0.3, 3200, 55000);
      let parsed = cleanToJSONPlus(raw);

      // 2) intento estricto
      if (!parsed) {
        const strict = SYSTEM_INFO + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, infoUserMsg], 0.2, 2800, 45000);
        parsed = cleanToJSONPlus(raw);
      }

      // 3) quality gate + 1 repair máx (performance)
      if (parsed) {
        const audit = _validateInfoResearch_(parsed, {
          days_total: context?.days_total || context?.days || context?.daysTotal || 1,
          destination: context?.city || parsed?.destination || "",
          city: context?.city || "",
        });

        if (!audit.ok) {
          const repairPrompt = `
${SYSTEM_INFO}

REPARACIÓN OBLIGATORIA (QUALITY GATE):
Tu JSON anterior falló:
- ${audit.issues.join("\n- ")}

INSTRUCCIONES:
- Devuelve city_day completo y ordenado.
- Cada fila con "Destino – Sub-parada", from/to/transport llenos.
- duration 2 líneas; PROHIBIDO "Transporte: 0m".
- Auroras SOLO nocturnas (18:00–02:00), NO consecutivas, NO último día.
- Si hay Golden Circle/Círculo Dorado: 5–8 sub-paradas + fila final "Regreso a {Destino}" y NO en último día.
- No uses placeholders genéricos.

Responde SOLO JSON válido.
`.trim();

          const repairRaw = await callText([{ role: "system", content: repairPrompt }, infoUserMsg], 0.22, 3400, 55000);
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
          city_day: [],
        };
      }

      // Normalización ligera de duraciones
      parsed = normalizeDurationsInParsed(parsed);
      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    /* ===================== MODO PLANNER ===================== */
    if (mode === "planner") {
      // validate=true no llama al modelo
      try {
        if (body && body.validate === true && Array.isArray(body.rows)) {
          const out = { allowed: body.rows, rejected: [] };
          return res.status(200).json({ text: JSON.stringify(out) });
        }
      } catch {}

      const research = body.research_json || null;

      // Camino legado sin research_json
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

      // 🆕 Multi-ciudad (futuro): si viene research.destinations, armamos también destinations_out
      const hasMulti = Array.isArray(research?.destinations) && research.destinations.length > 0;

      // Para compat con UI actual, seguimos devolviendo destination+rows del "primer destino" si multi.
      const primaryResearch = hasMulti ? research.destinations[0] : research;

      const destination = String(primaryResearch?.destination || primaryResearch?.city || body?.destination || "").trim() || "Destino";

      // Fuente: city_day (preferido) o rows_draft (legacy)
      let { rows_draft } = _flattenCityDayToRows_(primaryResearch, destination);

      // Normalización mínima local (sin inventar POIs)
      let rowsDraft = _normalizeRowsMinimal_(rows_draft, destination, primaryResearch);

      // Encajar auroras a ventana si existe
      try {
        const win = primaryResearch?.aurora?.window_local;
        if (win && win.start && win.end) {
          rowsDraft = rowsDraft.map((r) => {
            if (!_isAurora_(r.activity)) return r;
            if (_isNightWindow_(r.start, r.end)) return r;
            return { ...r, start: String(win.start), end: String(win.end) };
          });
        }
      } catch {}

      // target_day -> sin modelo
      const targetDay = body.target_day ?? null;
      if (targetDay != null) {
        const td = Number(targetDay);
        const out = {
          destination,
          rows: rowsDraft
            .filter((r) => Number(r.day) === td)
            .map((r) => ({ ...r, duration: _replaceZeroTransport_(_ensureTwoLineDuration_(r.duration)) })),
          followup: "",
        };
        out.rows = _normalizeRowsMinimal_(out.rows, destination, primaryResearch);
        return res.status(200).json({ text: JSON.stringify(out) });
      }

      // Por performance, NO llamamos al modelo si ya tenemos rowsDraft
      const out = {
        destination,
        rows: rowsDraft.map((r) => ({ ...r, duration: _replaceZeroTransport_(_ensureTwoLineDuration_(r.duration)) })),
        followup: "",
      };

      const auditLocal = _validatePlannerOutput_(out);
      if (auditLocal.ok) {
        // Si multi, devolvemos también destinations[] para que tu JS pueda usarlo más adelante
        if (hasMulti) {
          const destinations_out = research.destinations.map((d) => {
            const destName = String(d?.destination || d?.city || "").trim() || "Destino";
            const flat = _flattenCityDayToRows_(d, destName);
            let rr = _normalizeRowsMinimal_(flat.rows_draft, destName, d).map((r) => ({
              ...r,
              duration: _replaceZeroTransport_(_ensureTwoLineDuration_(r.duration)),
            }));
            // encajar auroras si window_local existe
            try {
              const win = d?.aurora?.window_local;
              if (win && win.start && win.end) {
                rr = rr.map((r) => {
                  if (!_isAurora_(r.activity)) return r;
                  if (_isNightWindow_(r.start, r.end)) return r;
                  return { ...r, start: String(win.start), end: String(win.end) };
                });
              }
            } catch {}
            return { destination: destName, rows: rr, followup: "" };
          });

          const payload = { ...out, destinations: destinations_out };
          const normalized = normalizeDurationsInParsed(payload);
          return res.status(200).json({ text: JSON.stringify(normalized) });
        }

        const normalized = normalizeDurationsInParsed(out);
        return res.status(200).json({ text: JSON.stringify(normalized) });
      }

      // Si aún falla, 1 repair con el modelo (máximo 1)
      const plannerUserPayload = {
        research_json: { ...primaryResearch, rows_draft: rowsDraft },
        day_hours: body.day_hours ?? null,
        existing_rows: body.existing_rows ?? null,
        note: "Corrige validaciones sin inventar POIs nuevos. Mantén orden y contenido.",
      };
      const plannerUserMsg = { role: "user", content: JSON.stringify(plannerUserPayload, null, 2) };

      const repairPlanner = `
${SYSTEM_PLANNER}

REPARACIÓN OBLIGATORIA:
Falló validaciones:
- ${auditLocal.issues.join("\n- ")}

Reglas:
- NO inventes POIs nuevos.
- Arregla activity a "Destino – Sub-parada" si falta.
- Llena from/to/transport.
- duration 2 líneas; prohíbe "Transporte: 0m".
- Auroras nocturnas; si aurora.window_local existe úsala.

Responde SOLO JSON válido.
`.trim();

      const repairRaw = await callText([{ role: "system", content: repairPlanner }, plannerUserMsg], 0.2, 2400, 45000);
      let repaired = cleanToJSONPlus(repairRaw);

      if (!repaired) {
        repaired = out;
      } else {
        repaired.destination = repaired.destination || destination;
        repaired.rows = _normalizeRowsMinimal_(repaired.rows, destination, primaryResearch).map((r) => ({
          ...r,
          duration: _replaceZeroTransport_(_ensureTwoLineDuration_(r.duration)),
        }));
        repaired.followup = repaired.followup || "";
      }

      repaired = normalizeDurationsInParsed(repaired);
      return res.status(200).json({ text: JSON.stringify(repaired) });
    }

    return res.status(400).json({ error: "Invalid mode" });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
