// /api/chat.js — v52.2 (ESM, Vercel)
// Basado EXACTO en v52.1 (tu código) + fixes quirúrgicos:
// 1) INFO: macro-tours obligatorios (5–8 sub-paradas + regreso) y detectar filas "gigantes" sin dividir.
// 2) INFO: comidas opcionales; si existen, NO fijar restaurante en "to"; poner 3 opciones en notes.
// 3) INFO: transporte flexible cuando usuario no define; y si no hay certeza de transporte: "Depende del lugar."
// 4) INFO: aurora.suggested_days siempre consistente con filas reales.
// 5) Menor latencia (para evitar AbortError del planner): límites de tokens y reparación más enfocada.
// Mantiene: { text: "<JSON>" } siempre.

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
    city_day: [
      {
        city: "Desconocido",
        day: 1,
        rows: [
          {
            day: 1,
            start: "09:30",
            end: "11:00",
            activity: "Desconocido – Itinerario base (fallback)",
            from: "Hotel",
            to: "Centro",
            transport: "A pie o Transporte local (según ubicación)",
            duration: "Transporte: Depende del lugar.\nActividad: ~1h",
            notes: "⚠️ No pude generar el itinerario. Revisa API key/despliegue y vuelve a intentar.",
            kind: "",
            zone: "",
          },
        ],
      },
    ],
    followup: "⚠️ Fallback local: revisa OPENAI_API_KEY o despliegue.",
  };
}

// Guard-rail: evita romper planner si INFO no pudo generar (NO es el objetivo final)
function skeletonCityDay(destination = "Destino", daysTotal = 1) {
  const city = String(destination || "Destino").trim() || "Destino";
  const n = Math.max(1, Number(daysTotal) || 1);
  const blocks = [];
  for (let d = 1; d <= n; d++) {
    blocks.push({
      city,
      day: d,
      rows: [
        {
          day: d,
          start: "09:30",
          end: "11:00",
          activity: `${city} – Reintentar generación (itinerario pendiente)`,
          from: "Hotel",
          to: "Centro",
          transport: "A pie o Transporte local (según ubicación)",
          duration: "Transporte: Depende del lugar.\nActividad: ~1h",
          notes:
            "⚠️ INFO no logró generar un itinerario válido en este intento. Reintenta o ajusta condiciones; cuando funcione, aquí verás el plan final.",
          kind: "",
          zone: "",
        },
      ],
    });
  }
  return blocks;
}

/* ===================== Responses API call (con timeout) ===================== */
async function callText(messages, temperature = 0.22, max_output_tokens = 4200, timeoutMs = 65000) {
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

function _activityHasDestDash_(activity) {
  const s = String(activity || "");
  return /\s[–-]\s/.test(s);
}

function _isAurora_(activity) {
  return /auroras?|aurora|northern\s*lights/i.test(String(activity || ""));
}

function _isMacroTourKey_(activity) {
  const t = _canonTxt_(activity);
  return /golden circle|circulo dorado|círculo dorado|day trip|excursion|excursión|tour\b|peninsula|península/i.test(t);
}

function _parseTimeToMin_(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function _spanMinutes_(startHHMM, endHHMM) {
  const s = _parseTimeToMin_(startHHMM);
  const e = _parseTimeToMin_(endHHMM);
  if (s == null || e == null) return null;
  if (e >= s) return e - s;
  // cruza medianoche
  return (24 * 60 - s) + e;
}

function _isNightWindow_(startHHMM, endHHMM) {
  const s = _parseTimeToMin_(startHHMM);
  const e = _parseTimeToMin_(endHHMM);
  if (s == null || e == null) return false;
  const isNightPoint = (min) => min >= 18 * 60 || min < 5 * 60;
  if (e <= s) return isNightPoint(s) || isNightPoint(e);
  return isNightPoint(s) && isNightPoint(e);
}

/* ===================== Duration normalization ===================== */
function _normalizeDurationText_(txt) {
  const s = String(txt ?? "").trim();
  if (!s) return s;

  if (/Transporte\s*:/i.test(s) && /Actividad\s*:/i.test(s) && s.includes(",")) {
    const fixed = s.replace(/\s*,\s*Actividad\s*:/i, "\nActividad:");
    if (!/^Transporte\s*:/i.test(fixed) && /^Actividad\s*:/i.test(fixed)) {
      const parts = fixed.split("\n").map((x) => x.trim());
      const tLine = parts.find((x) => /^Transporte\s*:/i.test(x)) || "Transporte: Depende del lugar.";
      const aLine = parts.find((x) => /^Actividad\s*:/i.test(x)) || "Actividad: ~1h";
      return `${tLine}\n${aLine}`;
    }
    return fixed;
  }

  if (/^Transporte\s*:\s*.*\nActividad\s*:\s*/i.test(s)) return s;
  return s;
}

function _hasTwoLineDuration_(duration) {
  const s = String(duration || "");
  return /^Transporte\s*:\s*.*\nActividad\s*:\s*/i.test(s);
}

function _hasZeroTransport_(duration) {
  const s = String(duration || "");
  return /Transporte\s*:\s*0m/i.test(s);
}

function _hasZeroActivity_(duration) {
  const s = String(duration || "");
  return /Actividad\s*:\s*0m/i.test(s);
}

/* ===================== Placeholders / meals ===================== */
function _isGenericPlaceholderActivity_(activity) {
  const t = _canonTxt_(activity);
  if (!t) return true;

  const bad = [
    "museo de arte",
    "parque local",
    "cafe local",
    "café local",
    "restaurante local",
    "cena local",
    "paseo por la ciudad",
    "recorrido por la ciudad",
    "museos y cultura",
    "cena en restaurante",
    "ultimas compras",
    "últimas compras",
    "centro comercial",
  ];

  if (t.length <= 10 && /^(museo|parque|cafe|café|restaurante|plaza|mercado|compras)$/i.test(t)) return true;
  if (bad.some((b) => t === b || t.includes(b))) return true;
  if (/^(museo|parque|cafe|café|restaurante|compras)\b/i.test(t) && t.split(" ").length <= 3) return true;

  return false;
}

function _looksLikeMealRow_(activity) {
  const t = _canonTxt_(activity);
  return /\b(cena|almuerzo|comida|desayuno|brunch|merienda)\b/.test(t);
}

function _mealIsGeneric_(row) {
  const a = _canonTxt_(row?.activity);
  const to = _canonTxt_(row?.to);
  if (!/\b(cena|almuerzo|comida|desayuno|brunch|merienda)\b/.test(a)) return false;
  if (to === "restaurante local" || to === "restaurante" || to === "cafe local" || to === "café local") return true;
  if (a.includes("cena local")) return true;
  return false;
}

/* ===================== day_hours sanitizer ===================== */
function _sanitizeIncomingDayHours_(day_hours, daysTotal) {
  try {
    if (!Array.isArray(day_hours) || !day_hours.length) return null;

    const need = Math.max(1, Number(daysTotal) || day_hours.length || 1);
    const norm = (t) => String(t || "").trim();

    const cleaned = day_hours.map((d, idx) => {
      if (typeof d === "string") {
        const m = d.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
        return { day: idx + 1, start: m ? m[1] : "", end: m ? m[2] : "" };
      }
      return { day: Number(d?.day) || idx + 1, start: norm(d?.start) || "", end: norm(d?.end) || "" };
    });

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
function _normalizeCityDayShape_(city_day, destinationFallback = "") {
  const blocks = Array.isArray(city_day) ? city_day : [];
  const out = blocks
    .map((b, idx) => ({
      city: String(b?.city || b?.destination || destinationFallback || "").trim(),
      day: Number(b?.day) || idx + 1,
      rows: Array.isArray(b?.rows) ? b.rows : [],
    }))
    .sort((a, b) => a.day - b.day);

  out.forEach((b) => {
    b.rows = (Array.isArray(b.rows) ? b.rows : []).map((r) => ({
      ...r,
      day: Number(r?.day) || b.day,
      duration: _normalizeDurationText_(r?.duration),
    }));
  });

  return out;
}

function _flattenCityDayBlocks_(city_day) {
  const blocks = Array.isArray(city_day) ? city_day : [];
  const out = [];
  blocks
    .map((b) => ({
      city: String(b?.city || b?.destination || "").trim(),
      day: Number(b?.day) || 1,
      rows: Array.isArray(b?.rows) ? b.rows : [],
    }))
    .sort((a, b) => a.day - b.day)
    .forEach((b) => {
      b.rows.forEach((r) =>
        out.push({
          ...r,
          day: Number(r?.day) || b.day || 1,
          duration: _normalizeDurationText_(r?.duration),
        })
      );
    });
  return out;
}

function _rowsHaveCoverage_(rows, daysTotal) {
  if (!Array.isArray(rows) || !rows.length) return false;
  const need = Math.max(1, Number(daysTotal) || 1);
  const present = new Set(rows.map((r) => Number(r.day) || 1));
  for (let d = 1; d <= need; d++) if (!present.has(d)) return false;
  return true;
}

/* ===================== Quality Gate INFO (SOLO city_day) ===================== */
function _validateInfoResearch_(parsed, contextHint = {}) {
  const issues = [];
  const daysTotal = Math.max(1, Number(parsed?.days_total || contextHint?.days_total || 1));
  const destination = String(parsed?.destination || contextHint?.destination || contextHint?.city || "").trim();

  const hasCityDay = Array.isArray(parsed?.city_day) && parsed.city_day.length;
  if (!hasCityDay) issues.push("city_day vacío o ausente (obligatorio).");

  const rows = hasCityDay ? _flattenCityDayBlocks_(parsed.city_day) : [];
  if (rows.length && !_rowsHaveCoverage_(rows, daysTotal)) issues.push("No cubre todos los días 1..days_total.");

  const badRequired = rows.filter((r) => {
    const startOK = _parseTimeToMin_(r.start) != null;
    const endOK = _parseTimeToMin_(r.end) != null;
    const notesOK = String(r.notes || "").trim().length >= 20;
    const fromOK = String(r.from || "").trim().length > 0;
    const toOK = String(r.to || "").trim().length > 0;
    const transportOK = String(r.transport || "").trim().length > 0;
    const activityOK = String(r.activity || "").trim().length > 0;
    return !(startOK && endOK && notesOK && fromOK && toOK && transportOK && activityOK);
  });
  if (badRequired.length) issues.push("Faltan campos obligatorios en filas (start/end, notes, from/to, transport, activity).");

  if (rows.length && rows.some((r) => !_hasTwoLineDuration_(r.duration))) issues.push("duration no cumple 2 líneas con \\n.");
  if (rows.length && rows.some((r) => _hasZeroTransport_(r.duration))) issues.push('hay "Transporte: 0m" (prohibido).');
  if (rows.length && rows.some((r) => _hasZeroActivity_(r.duration))) issues.push('hay "Actividad: 0m" (prohibido).');

  if (rows.length && rows.some((r) => _isGenericPlaceholderActivity_(r.activity))) issues.push("placeholders genéricos en activity.");
  if (rows.length && rows.some((r) => !_activityHasDestDash_(r.activity))) issues.push('activity sin "Destino – Sub-parada".');

  // comidas: si existen, NO genéricas
  const mealRows = rows.filter((r) => _looksLikeMealRow_(r.activity));
  if (mealRows.some((r) => _mealIsGeneric_(r))) issues.push("comidas genéricas detectadas (si se incluyen, deben ser a elección con opciones en notes).");

  // filas "gigantes" deben estar divididas (evita el caso 09:30–17:00 en una sola fila)
  const giant = rows.filter((r) => {
    if (_looksLikeMealRow_(r.activity)) return false;
    if (_isAurora_(r.activity)) return false;
    const span = _spanMinutes_(r.start, r.end);
    return span != null && span >= 240; // >= 4h
  });
  if (giant.length) issues.push("hay filas con bloques >=4h sin dividir en sub-paradas (obligatorio dividir).");

  // auroras
  const auroraRows = rows.filter((r) => _isAurora_(r.activity));
  const auroraDays = auroraRows.map((r) => Number(r.day) || 1).sort((a, b) => a - b);

  for (let i = 1; i < auroraDays.length; i++) {
    if (auroraDays[i] === auroraDays[i - 1] + 1) {
      issues.push("auroras en días consecutivos (evitar si hay opciones).");
      break;
    }
  }
  if (auroraDays.includes(daysTotal)) issues.push("auroras en el último día (evitar; solo condicional si no hay otra opción).");
  if (auroraRows.some((r) => !_isNightWindow_(r.start, r.end))) issues.push("auroras fuera de ventana nocturna (prohibido).");

  const auroraNotesBad = auroraRows.some((r) => {
    const n = String(r.notes || "").toLowerCase();
    const hasValid = n.includes("valid:");
    const hasClimate = /clima|nubosidad|nubes|cloud/i.test(n);
    const hasAlt = /alternativa|mirador|cerca|oscuro|dark|low cost/i.test(n);
    return !(hasValid && hasClimate && hasAlt);
  });
  if (auroraRows.length && auroraNotesBad) issues.push('auroras sin notes completas (valid: + clima/nubosidad + alternativa low-cost).');

  // macro-tours: si aparece keyword, exige 5–8 filas y regreso
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

    const macroishCount = dayRows.filter((r) => _isMacroTourKey_(r.activity)).length;
    if (macroishCount < 5) issues.push(`macro-tour/day-trip en día ${d} con <5 sub-paradas.`);

    const hasReturn = dayRows.some((r) => {
      const a = _canonTxt_(r.activity);
      const to = _canonTxt_(r.to);
      const wants = _canonTxt_(baseCity || "");
      return a.includes("regreso") || (wants && (to.includes(wants) || a.includes(wants)));
    });
    if (!hasReturn) issues.push(`macro-tour/day-trip en día ${d} sin regreso explícito a ${baseCity || "ciudad base"}.`);

    if (d === daysTotal) issues.push("macro-tour/day-trip en el último día (evitar).");
  }

  return { ok: issues.length === 0, issues };
}

/* ===================== Prompts ===================== */
const SYSTEM_INFO = `
Eres el **Info Chat interno** de ITravelByMyOwn.
Debes devolver **UN ÚNICO JSON VÁLIDO** (sin texto fuera).

OBJETIVO:
1) Piensa el itinerario COMPLETO primero (coherente, optimizado, sin contradicciones).
2) Devuelve city_day[] (Ciudad–Día) ORDENADO y COMPLETO 1..days_total.
3) Cada fila debe ser "tabla-ready": TODO lo necesario para render.

CONTRATO row (OBLIGATORIO):
- day (número)
- start/end: HH:MM (hora local realista). Si el usuario no da horas, tú decides como experto.
- activity: "DESTINO – SUB-PARADA" (– o - con espacios). Evita genéricos.
- from/to: NO vacíos
- transport: NO vacío (realista). Si el usuario NO define transporte ("recomiéndame"), usa formato flexible:
  "Vehículo alquilado (por cuenta propia) o Tour guiado (según duración/pickup)"
- duration: 2 líneas EXACTAS con salto \\n:
  "Transporte: <estimación realista o ~rango o Depende del lugar.>"
  "Actividad: <estimación realista o ~rango>"
  PROHIBIDO: "Transporte: 0m" o "Actividad: 0m"
- notes: OBLIGATORIAS (>= 20 caracteres):
  1) frase emotiva/motivadora
  2) tip logístico claro (y alternativa/condición si aplica)

COMIDAS (flexible):
- NO obligatorias.
- Si las incluyes, NO fijes restaurante en la columna "to".
  Usa "Centro (a elección)" o "Zona gastronómica (a elección)".
- En notes agrega 3 opciones concretas (sin inventar marcas raras; lugares conocidos/locales).

MACRO-TOURS / DAY-TRIPS (OBLIGATORIO si lo propones):
- NO permitas una sola fila enorme (p.ej. 09:30–17:00).
- Debe venir en 5–8 sub-paradas (filas).
- Cerrar con una fila "Regreso a {Destino}" o retorno claro a hotel/ciudad base.

AURORAS (research/inferencia):
- Solo sugerir si plausibles por latitud/temporada.
- NO usar horas por defecto: infiere patrón local típico y asigna start/end coherentes.
- Evitar días consecutivos si hay opciones. Evitar último día; si solo cabe, marcar condicional.
- Notes obligatorias incluyen:
  "valid: <latitud/temporada> | clima/nubosidad" + alternativa low-cost (mirador oscuro cercano).

SALIDA mínima (incluye city_day):
{
  "destination":"Ciudad",
  "country":"País",
  "days_total":N,
  "hotel_base":"...",
  "rationale":"...",
  "imperdibles":[],
  "macro_tours":[],
  "meals_suggestions":[],
  "aurora":{"plausible":false,"suggested_days":[],"window_local":{"start":"","end":""},"duration":"...","transport_default":"...","note":""},
  "constraints":{"max_substops_per_tour":8,"no_consecutive_auroras":true,"no_last_day_aurora":true,"thermal_lagoons_min_stay_minutes":180},
  "day_hours":[],
  "city_day":[{"city":"Ciudad","day":1,"rows":[...]}],
  "rows_skeleton":[]
}

Responde SOLO JSON válido.
`.trim();

const SYSTEM_INFO_ULTRA = `
${SYSTEM_INFO}

IMPORTANTE:
- NO uses markdown ni backticks.
- NO agregues texto fuera del JSON.
- Start/end siempre HH:MM.
- Si transporte no se puede inferir: "Transporte: Depende del lugar."
- Actividad SIEMPRE con tiempo estimado.

EJEMPLO DE COMIDA:
{
  "day": 1,
  "start": "12:30",
  "end": "14:00",
  "activity": "Ciudad – Almuerzo",
  "from": "Lugar anterior",
  "to": "Centro (a elección)",
  "transport": "Caminando / Transporte local (según distancia)",
  "duration": "Transporte: Depende del lugar.\\nActividad: ~1h",
  "notes": "¡Recarga energías! Opciones: Opción1, Opción2, Opción3. Tip: evita hora pico si puedes."
}

Responde SOLO JSON válido.
`.trim();

const SYSTEM_PLANNER = `
Eres **Astra Planner**. Recibes "research_json".
Fuente de verdad: research_json (NO inventes POIs).
Tu tarea es devolver city_day limpio y utilizable por el frontend.

REGLA:
- Usa SOLO research_json.city_day como fuente.
- NO uses rows_draft ni rows, aunque existan.
- NO recortes ni dedupe aquí.

Salida:
{ "destination":"Ciudad", "city_day":[...], "followup":"" }
`.trim();

/* ===================== Post-process helpers ===================== */
function normalizeDurationsInParsed(parsed) {
  if (!parsed) return parsed;

  const touchRows = (rows = []) =>
    rows.map((r) => ({
      ...r,
      duration: _normalizeDurationText_(r.duration),
    }));

  try {
    if (Array.isArray(parsed.rows)) parsed.rows = touchRows(parsed.rows);

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
        city_day: Array.isArray(d.city_day)
          ? d.city_day.map((b) => ({ ...b, rows: Array.isArray(b.rows) ? touchRows(b.rows) : b.rows }))
          : d.city_day,
      }));
    }
  } catch {}

  return parsed;
}

function _syncAuroraSuggestedDays_(parsed) {
  try {
    const rows = Array.isArray(parsed?.city_day) ? _flattenCityDayBlocks_(parsed.city_day) : [];
    const days = [...new Set(rows.filter((r) => _isAurora_(r.activity)).map((r) => Number(r.day) || 1))].sort((a, b) => a - b);
    if (!parsed.aurora || typeof parsed.aurora !== "object") parsed.aurora = {};
    parsed.aurora.suggested_days = days;
    // si hay auroras en filas, plausible true; si no, mantener lo que venga
    if (days.length) parsed.aurora.plausible = true;
  } catch {}
  return parsed;
}

/* ===================== INFO generation with retries ===================== */
async function generateInfoJSON(infoUserMsg) {
  // intento 1: normal
  let raw = await callText([{ role: "system", content: SYSTEM_INFO }, infoUserMsg], 0.22, 4200, 65000);
  let parsed = cleanToJSONPlus(raw);
  if (parsed) return { parsed, raw, stage: "normal" };

  // intento 2: ultra estricto
  raw = await callText([{ role: "system", content: SYSTEM_INFO_ULTRA }, infoUserMsg], 0.16, 4600, 70000);
  parsed = cleanToJSONPlus(raw);
  if (parsed) return { parsed, raw, stage: "ultra" };

  return { parsed: null, raw: raw || "", stage: "failed" };
}

/* ===================== Handler ===================== */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = parseBody(req.body);
    const mode = String(body.mode || "planner").toLowerCase();

    /* ===================== INFO ===================== */
    if (mode === "info") {
      let context = body.context;

      if (!context && Array.isArray(body.messages) && body.messages.length) {
        context = { messages: body.messages };
      }
      if (!context && !Array.isArray(body.messages)) {
        const { mode: _m, ...rest } = body || {};
        context = rest;
      }

      // day_hours: se sanea; si no aporta, se elimina para dejar libertad al Info Chat
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

      // 1) generar (con retries)
      let gen = await generateInfoJSON(infoUserMsg);
      let parsed = gen.parsed;

      const ctxDays = context?.days_total || context?.days || context?.daysTotal || 1;
      const ctxDest = context?.city || "Destino";

      // 2) si aún no hay parsed, fallback honesto (pero no vacío)
      if (!parsed) {
        parsed = {
          destination: ctxDest,
          country: context?.country || "",
          days_total: ctxDays,
          hotel_base: context?.hotel_address || context?.hotel_base || "",
          rationale: "⚠️ No se pudo parsear un JSON válido del modelo en este intento.",
          imperdibles: [],
          macro_tours: [],
          meals_suggestions: [],
          aurora: {
            plausible: false,
            suggested_days: [],
            window_local: { start: "", end: "" },
            transport_default: "Vehículo alquilado (por cuenta propia) o Tour guiado (según duración/pickup)",
            note: "Actividad sujeta a clima/nubosidad.",
            duration: "~3h–5h",
          },
          constraints: {
            max_substops_per_tour: 8,
            no_consecutive_auroras: true,
            no_last_day_aurora: true,
            thermal_lagoons_min_stay_minutes: 180,
          },
          day_hours: [],
          city_day: skeletonCityDay(ctxDest, ctxDays),
          rows_skeleton: [],
          followup: "⚠️ INFO no generó JSON válido. Se devolvió skeleton para no romper el Planner. Reintenta INFO.",
        };

        parsed = normalizeDurationsInParsed(parsed);
        parsed = _syncAuroraSuggestedDays_(parsed);
        return res.status(200).json({ text: JSON.stringify(parsed) });
      }

      // 3) normaliza shape + limpia legacy
      try {
        const destinationFallback = String(parsed?.destination || ctxDest || "").trim();
        parsed.city_day = _normalizeCityDayShape_(parsed.city_day, destinationFallback);
        if (!Array.isArray(parsed.rows_skeleton)) parsed.rows_skeleton = [];
        if (!Array.isArray(parsed.day_hours)) parsed.day_hours = [];
        if ("rows_draft" in parsed) delete parsed.rows_draft;
        if ("rows" in parsed) delete parsed.rows;
      } catch {
        if (!Array.isArray(parsed.city_day)) parsed.city_day = [];
        if (!Array.isArray(parsed.rows_skeleton)) parsed.rows_skeleton = [];
        if (!Array.isArray(parsed.day_hours)) parsed.day_hours = [];
        if ("rows_draft" in parsed) delete parsed.rows_draft;
        if ("rows" in parsed) delete parsed.rows;
      }

      // 4) quality gate + repair iterativo (1 ronda fuerte)
      const contextHint = {
        days_total: ctxDays,
        destination: ctxDest,
        city: ctxDest,
      };

      const audit = _validateInfoResearch_(parsed, contextHint);
      if (!audit.ok) {
        const repairPrompt = `
${SYSTEM_INFO}

REPARACIÓN OBLIGATORIA:
Fallos detectados:
- ${audit.issues.join("\n- ")}

Instrucciones:
- Re-emite TODO el JSON (no parches).
- Si hay macro-tour/day-trip: 5–8 sub-paradas + regreso explícito.
- PROHIBIDO una sola fila enorme (>=4h) sin dividir.
- Comidas: solo si aportan; "to" debe ser (a elección) y notes con 3 opciones.
- Duración transporte si incierta: "Depende del lugar."
- Actividad siempre con tiempo estimado.

Responde SOLO JSON válido.
`.trim();

        const repairRaw = await callText([{ role: "system", content: repairPrompt }, infoUserMsg], 0.14, 4600, 70000);
        const repaired = cleanToJSONPlus(repairRaw);
        if (repaired) {
          parsed = repaired;
          try {
            const destinationFallback = String(parsed?.destination || ctxDest || "").trim();
            parsed.city_day = _normalizeCityDayShape_(parsed.city_day, destinationFallback);
            if (!Array.isArray(parsed.rows_skeleton)) parsed.rows_skeleton = [];
            if (!Array.isArray(parsed.day_hours)) parsed.day_hours = [];
            if ("rows_draft" in parsed) delete parsed.rows_draft;
            if ("rows" in parsed) delete parsed.rows;
          } catch {}
        }
      }

      // 5) guard-rail final: nunca city_day vacío
      try {
        const destinationFallback = String(parsed?.destination || ctxDest || "Destino").trim() || "Destino";
        const daysTotal = Math.max(1, Number(parsed?.days_total || ctxDays || 1));
        if (!Array.isArray(parsed.city_day) || parsed.city_day.length === 0) {
          parsed.city_day = skeletonCityDay(destinationFallback, daysTotal);
          parsed.followup =
            "⚠️ INFO no logró generar un itinerario válido (city_day vacío). Se devolvió skeleton por día para no romper el Planner. Reintenta INFO.";
        }
      } catch {}

      parsed = normalizeDurationsInParsed(parsed);
      parsed = _syncAuroraSuggestedDays_(parsed);
      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    /* ===================== PLANNER ===================== */
    if (mode === "planner") {
      const research = body.research_json || null;

      if (!research) {
        const clientMessages = extractMessages(body);
        let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, ...clientMessages], 0.18, 2200, 55000);
        let parsed = cleanToJSONPlus(raw);
        if (!parsed) parsed = fallbackJSON();

        const destinationFallback = String(parsed?.destination || "").trim();
        parsed.city_day = _normalizeCityDayShape_(parsed.city_day, destinationFallback);
        if ("rows_draft" in parsed) delete parsed.rows_draft;
        if ("rows" in parsed) delete parsed.rows;

        parsed = normalizeDurationsInParsed(parsed);
        return res.status(200).json({ text: JSON.stringify(parsed) });
      }

      const destination = String(research?.destination || research?.city || body?.destination || "").trim() || "Destino";

      // ✅ SOLO city_day como fuente de verdad
      let city_day = _normalizeCityDayShape_(research?.city_day, destination);

      // Último recurso legacy (solo si city_day viene vacío)
      if ((!Array.isArray(city_day) || !city_day.length) && Array.isArray(research?.rows) && research.rows.length) {
        const byDay = new Map();
        research.rows.forEach((r) => {
          const d = Number(r?.day) || 1;
          if (!byDay.has(d)) byDay.set(d, []);
          byDay.get(d).push({ ...r, day: d });
        });
        city_day = [...byDay.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([day, rows]) => ({ city: destination, day, rows }));
        city_day = _normalizeCityDayShape_(city_day, destination);
      }

      if (!Array.isArray(city_day) || city_day.length === 0) {
        city_day = skeletonCityDay(destination, Number(research?.days_total || 1));
      }

      const out = { destination, city_day, followup: "" };
      const normalized = normalizeDurationsInParsed(out);
      return res.status(200).json({ text: JSON.stringify(normalized) });
    }

    return res.status(400).json({ error: "Invalid mode" });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
