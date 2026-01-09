// /api/chat.js — v52.4 (ESM, Vercel)
// FIXES vs v52.3:
// A) Macro-tours: PROHIBIDO devolver 1 sola fila tipo "Golden Circle Tour" / "Excursión ... ~8h".
//    -> Si hay macro-day-trip, DEBE desglosar 5–8 sub-paradas reales + "Regreso a {Ciudad}".
//    -> Si NO puede nombrar sub-paradas reales, NO proponer macro-tour; rellenar con city activities válidas.
// B) Meals validator: cena permitida desde 17:00 (muchos países cenan temprano).
// C) preferences.alwaysIncludeDinner: si true, incluir cena cada día (flexible, "zona gastronómica a elección").
// D) Prompt endurecido: primero plan completo, luego JSON; cero texto extra.

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
            duration: "Transporte: Depende del lugar\nActividad: ~1h",
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
          duration: "Transporte: Depende del lugar\nActividad: ~1h",
          notes:
            "⚠️ INFO no logró generar un itinerario válido en este intento. Reintenta; cuando funcione, aquí verás el plan final.",
          kind: "",
          zone: "",
        },
      ],
    });
  }
  return blocks;
}

/* ===================== Responses API call (con timeout) ===================== */
async function callText(messages, temperature = 0.28, max_output_tokens = 5200, timeoutMs = 90000) {
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
  } catch {
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

function _parseTimeToMin_(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function _isNightWindow_(startHHMM, endHHMM) {
  const s = _parseTimeToMin_(startHHMM);
  const e = _parseTimeToMin_(endHHMM);
  if (s == null || e == null) return false;
  const isNightPoint = (min) => min >= 18 * 60 || min < 5 * 60;
  if (e <= s) return isNightPoint(s) || isNightPoint(e);
  return isNightPoint(s) && isNightPoint(e);
}

function _isAurora_(activity) {
  return /auroras?|aurora|northern\s*lights/i.test(String(activity || ""));
}

function _isMacroTourKey_(activity) {
  const t = _canonTxt_(activity);
  return /golden circle|circulo dorado|círculo dorado|day trip|excursion|excursion|excursión|tour\b|peninsula|península|snæfellsnes|snaefellsnes/i.test(
    t
  );
}

/* ===================== Duration normalization ===================== */
function _normalizeDurationText_(txt) {
  const s = String(txt ?? "").trim();
  if (!s) return s;

  if (/Transporte\s*:/i.test(s) && /Actividad\s*:/i.test(s) && s.includes(",")) {
    const fixed = s.replace(/\s*,\s*Actividad\s*:/i, "\nActividad:");
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

/* ===================== Meals helpers ===================== */
function _looksLikeMealRow_(activity) {
  const t = _canonTxt_(activity);
  return /\b(cena|almuerzo|comida|desayuno|brunch|merienda)\b/.test(t);
}

function _mealLabelWindowOK_(activity, startHHMM) {
  const t = _canonTxt_(activity);
  const s = _parseTimeToMin_(startHHMM);
  if (s == null) return true;
  const inRange = (a, b) => s >= a && s <= b;

  if (t.includes("desayuno") || t.includes("brunch")) return inRange(6 * 60, 10 * 60 + 30);
  if (t.includes("almuerzo") || t.includes("comida")) return inRange(11 * 60, 15 * 60);

  // ✅ FIX: permitir cenas tempranas desde 17:00 (realista en muchos países)
  if (t.includes("cena")) return inRange(17 * 60, 22 * 60 + 30);

  return true;
}

function _mealToIsTooSpecific_(row) {
  if (!_looksLikeMealRow_(row?.activity)) return false;
  const to = String(row?.to || "").trim();
  if (!to) return true;

  const canon = _canonTxt_(to);
  if (canon.includes("a eleccion") || canon.includes("a elección")) return false;
  if (canon.includes("zona gastronomica") || canon.includes("zona gastronómica")) return false;
  if (canon === "centro" || canon.startsWith("centro ")) return false;

  const words = canon.split(" ").filter(Boolean);
  if (words.length >= 2 && !canon.includes("zona") && !canon.includes("centro")) return true;
  return false;
}

/* ===================== Placeholders ===================== */
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
          __city: b.city,
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

/* ===================== STRICT activity prefix rule ===================== */
function _activityStartsWithCityDash_(activity, city) {
  const a = String(activity || "").trim();
  const c = String(city || "").trim();
  if (!a || !c) return false;
  return a.startsWith(`${c} – `) || a.startsWith(`${c} - `);
}

/* ===================== Aurora to/location rule ===================== */
function _auroraToLooksValid_(to) {
  const t = _canonTxt_(to);
  if (!t) return false;
  return /zona oscura|mirador oscuro|spot oscuro|lugar oscuro|dark spot|dark sky|away from lights|cielo oscuro/.test(t);
}

/* ===================== Non-meal generic from/to guard ===================== */
function _isTooGenericFromTo_(row) {
  const from = _canonTxt_(row?.from);
  const to = _canonTxt_(row?.to);
  const a = _canonTxt_(row?.activity);
  if (!from || !to) return true;
  if (_looksLikeMealRow_(a)) return false;
  if ((from === "centro" || from.startsWith("centro ")) && (to === "centro" || to.startsWith("centro "))) return true;
  if (to.includes("zona gastronomica") || to.includes("zona gastronómica")) return true;
  return false;
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

  const badActivityPrefix = rows.some((r) => !_activityStartsWithCityDash_(r.activity, r.__city || destination));
  if (badActivityPrefix) issues.push('activity no empieza con "Ciudad – " (prefijo obligatorio).');

  if (rows.length && rows.some((r) => _isTooGenericFromTo_(r))) issues.push("from/to demasiado genéricos o vacíos (no-comida).");

  const mealRows = rows.filter((r) => _looksLikeMealRow_(r.activity));
  if (mealRows.some((r) => !_mealLabelWindowOK_(r.activity, r.start))) issues.push("comida mal etiquetada según horario (desayuno/almuerzo/cena).");
  if (mealRows.some((r) => _mealToIsTooSpecific_(r))) issues.push('comidas: "to" demasiado específico (usar zona gastronómica a elección; opciones van en notes).');

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
  if (auroraRows.some((r) => !_auroraToLooksValid_(r.to))) issues.push('auroras: "to" debe ser zona oscura/mirador oscuro (no Centro).');

  const auroraNotesBad = auroraRows.some((r) => {
    const n = String(r.notes || "").toLowerCase();
    const hasValid = n.includes("valid:");
    const hasClimate = /clima|nubosidad|nubes|cloud|weather/.test(n);
    const hasAlt = /alternativa|mirador|cerca|oscuro|dark|low cost|gratis|free/.test(n);
    return !(hasValid && hasClimate && hasAlt);
  });
  if (auroraRows.length && auroraNotesBad) issues.push('auroras sin notes completas (valid: + clima/nubosidad + alternativa low-cost).');

  const baseCity = String(parsed?.destination || contextHint?.destination || "").trim() || destination;
  const byDay = new Map();
  rows.forEach((r) => {
    const d = Number(r.day) || 1;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(r);
  });

  for (let d = 1; d <= daysTotal; d++) {
    const dayRows = byDay.get(d) || [];
    const isMacroDay = dayRows.some((r) => _isMacroTourKey_(r.activity));
    if (!isMacroDay) continue;

    const substopsReal = dayRows.filter((r) => !_looksLikeMealRow_(r.activity) && !_isAurora_(r.activity)).length;
    if (substopsReal < 5) issues.push(`macro-tour/day-trip en día ${d} con <5 sub-paradas reales (sin comidas/auroras).`);

    const hasReturn = dayRows.some((r) => {
      const a = _canonTxt_(r.activity);
      return a.includes("regreso") && (baseCity ? a.includes(_canonTxt_(baseCity)) : true);
    });
    if (!hasReturn) issues.push(`macro-tour/day-trip en día ${d} sin "Regreso a ${baseCity || "ciudad base"}".`);
  }

  return { ok: issues.length === 0, issues };
}

/* ===================== Prompts ===================== */
const SYSTEM_INFO = `
Eres el **Info Chat interno** de ITravelByMyOwn.
Debes devolver **UN ÚNICO JSON VÁLIDO** (sin texto fuera).

OBJETIVO:
1) Piensa el itinerario COMPLETO primero (coherente, optimizado, sin contradicciones).
2) Luego emite SOLO el JSON final en city_day[] (Ciudad–Día) ORDENADO y COMPLETO 1..days_total.

REGLA CERO (NO NEGOCIABLE):
- PROHIBIDO devolver un macro-tour/day-trip como UNA sola fila tipo:
  "Ciudad – Golden Circle Tour", "Ciudad – Excursión ..." con Actividad ~8h.
  Si decides hacer un macro-day-trip, DEBES desglosar 5–8 sub-paradas REALES (filas)
  + una fila final: "CIUDAD – Regreso a {Ciudad}".
  Si NO puedes nombrar sub-paradas reales concretas, entonces NO propongas macro-day-trip;
  rellena el día con actividades urbanas reales y específicas (sin placeholders genéricos).

CONTRATO de cada row (OBLIGATORIO):
- day: número
- start/end: HH:MM (hora local realista).
- activity: DEBE empezar con "CIUDAD – ..." (– o - con espacios). Ej: "Reykjavik – Hallgrímskirkja".
- from/to: NO vacíos y NO genéricos en actividades reales.
- transport: NO vacío (realista)
- duration: 2 líneas EXACTAS con salto \\n:
  "Transporte: <estimación realista o Depende del lugar>"
  "Actividad: <estimación realista o ~rango>"
- PROHIBIDO: "Transporte: 0m" o "Actividad: 0m"
- notes: OBLIGATORIAS, motivadoras y útiles (>= 20 caracteres):
  - 1 frase emotiva + 1 tip logístico (+ condición/alternativa si aplica)

COMIDAS:
- Si preferences.alwaysIncludeDinner = true, incluye 1 cena cada día (flexible).
- Cena típica: 19:00–21:30 (ajusta por país si cenan temprano).
- Si incluyes comida, NO elijas restaurante en "to".
  Usa "Zona gastronómica (a elección)" o "Centro (a elección)".
  En notes SIEMPRE pon 3 opciones concretas.

AURORAS (flexible):
- Solo sugerir si plausibles por latitud/temporada.
- Infiere patrón típico local y asigna start/end coherentes.
- "to" debe ser zona oscura/mirador oscuro/spot oscuro (no "Centro").
- Transporte flexible:
  "Vehículo alquilado (por cuenta propia) o Tour guiado (según duración/pickup)"
- Evitar días consecutivos si hay opciones. Evitar último día; si solo cabe, marcar condicional.
- Notes obligatorias incluyen:
  "valid: <latitud/temporada> | <clima/nubosidad>" + alternativa low-cost.

Salida mínima:
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
- NO uses markdown.
- NO uses backticks.
- NO agregues texto fuera del JSON.
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

/* ===================== Normalización de duraciones en parsed ===================== */
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

/* ===================== INFO generation with retries ===================== */
async function generateInfoJSON(infoUserMsg) {
  let raw = await callText([{ role: "system", content: SYSTEM_INFO }, infoUserMsg], 0.24, 5200, 95000);
  let parsed = cleanToJSONPlus(raw);
  if (parsed) return { parsed, raw, stage: "normal" };

  raw = await callText([{ role: "system", content: SYSTEM_INFO_ULTRA }, infoUserMsg], 0.18, 5600, 110000);
  parsed = cleanToJSONPlus(raw);
  if (parsed) return { parsed, raw, stage: "ultra" };

  return { parsed: null, raw: raw || "", stage: "failed" };
}

/* ===================== Repair: CORREGIR EL JSON EXISTENTE ===================== */
async function repairInfoJSONWithCurrent(parsed, auditIssues, ctxDest, infoUserMsg) {
  const repairPrompt = `
${SYSTEM_INFO_ULTRA}

REPARACIÓN OBLIGATORIA:
Tú YA generaste un JSON, pero tiene problemas.
Debes DEVOLVER el JSON COMPLETO corregido (no parches).

Problemas detectados:
- ${auditIssues.join("\n- ")}

Contexto original (no lo repitas, solo úsalo):
${infoUserMsg.content}

JSON ACTUAL A CORREGIR (reescribe y mejora sin perder días):
${JSON.stringify(parsed)}

REGLAS CRÍTICAS (NO NEGOCIABLE):
1) Si hay macro-tour/day-trip (tour/excursión/day trip/círculo dorado/etc):
   - PROHIBIDO 1 sola fila con "~8h".
   - Debes crear 5–8 filas de sub-paradas REALES + "Regreso a ${ctxDest}".
   - Si no puedes nombrar sub-paradas reales concretas, elimina el macro-day-trip y crea un día urbano válido.
2) Si preferences.alwaysIncludeDinner=true en el contexto, incluye cena diaria (flexible).
3) Comidas: "to" genérico (zona/centro a elección) + 3 opciones en notes.
4) Auroras: notes incluyen "valid: <latitud/temporada> | <clima/nubosidad>" + alternativa low-cost; "to" = zona oscura/mirador oscuro.
5) activity siempre inicia con "${ctxDest} – ".

Responde SOLO JSON válido.
`.trim();

  const raw = await callText([{ role: "system", content: repairPrompt }], 0.18, 6000, 110000);
  const repaired = cleanToJSONPlus(raw);
  return repaired || null;
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

      const ctxDays = context?.days_total || context?.days || context?.daysTotal || 1;
      const ctxDest = context?.city || "Destino";

      // 1) Generar JSON
      let gen = await generateInfoJSON(infoUserMsg);
      let parsed = gen.parsed;

      // 2) Si no se pudo parsear, skeleton (único caso donde skeleton es válido)
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
          followup: "⚠️ INFO no generó JSON parseable. Se devolvió skeleton para no romper el Planner. Reintenta INFO.",
        };

        parsed = normalizeDurationsInParsed(parsed);
        return res.status(200).json({ text: JSON.stringify(parsed) });
      }

      // 3) Normaliza shape + limpia legacy
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

      // 4) Si city_day viene vacío, skeleton (caso extremo)
      const daysTotal = Math.max(1, Number(parsed?.days_total || ctxDays || 1));
      const destinationFinal = String(parsed?.destination || ctxDest || "Destino").trim() || "Destino";
      if (!Array.isArray(parsed.city_day) || parsed.city_day.length === 0) {
        parsed.city_day = skeletonCityDay(destinationFinal, daysTotal);
        parsed.followup =
          "⚠️ INFO devolvió JSON pero city_day vino vacío. Se devolvió skeleton para no romper el Planner. Reintenta INFO.";
        parsed = normalizeDurationsInParsed(parsed);
        return res.status(200).json({ text: JSON.stringify(parsed) });
      }

      // 5) Quality gate + repairs (SIN destruir el itinerario si falla)
      let audit = _validateInfoResearch_(parsed, { days_total: daysTotal, destination: destinationFinal, city: destinationFinal });

      // Intentar hasta 2 reparaciones corrigiendo el JSON actual
      for (let round = 1; round <= 2 && !audit.ok; round++) {
        const repaired = await repairInfoJSONWithCurrent(parsed, audit.issues, destinationFinal, infoUserMsg);
        if (!repaired) break;

        parsed = repaired;
        try {
          parsed.city_day = _normalizeCityDayShape_(parsed.city_day, destinationFinal);
          if (!Array.isArray(parsed.rows_skeleton)) parsed.rows_skeleton = [];
          if (!Array.isArray(parsed.day_hours)) parsed.day_hours = [];
          if ("rows_draft" in parsed) delete parsed.rows_draft;
          if ("rows" in parsed) delete parsed.rows;
        } catch {}

        audit = _validateInfoResearch_(parsed, { days_total: daysTotal, destination: destinationFinal, city: destinationFinal });
      }

      // 6) Si aun falla, NO skeleton: devolver lo que hay + followup con issues
      if (!audit.ok) {
        parsed.followup =
          "⚠️ Itinerario generado, pero con issues detectados (NO bloqueé el render): " + audit.issues.join(" | ");
      } else {
        parsed.followup = parsed.followup || "";
      }

      parsed = normalizeDurationsInParsed(parsed);
      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    /* ===================== PLANNER ===================== */
    if (mode === "planner") {
      const research = body.research_json || null;

      if (!research) {
        const clientMessages = extractMessages(body);
        let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, ...clientMessages], 0.2, 2600, 65000);
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

      let city_day = _normalizeCityDayShape_(research?.city_day, destination);

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
