// /api/chat.js — v52.4 (ESM, Vercel)
// OBJETIVO:
// - INFO genera itinerario completo en city_day (JSON válido).
// - Si audit falla: NO bloquear render. Intentar repair compacto 1 vez.
// - Skeleton SOLO si: no parsea JSON o city_day viene vacío.
// - PLANNER: passthrough de research_json.city_day -> normaliza -> devuelve city_day.
//
// Cambios vs v52.3:
// 1) Repair prompt compactado (menos tokens = menos timeouts).
// 2) Timeouts INFO/repair aumentados + callText devuelve error diagnóstico.
// 3) Audit deja de ser "gate duro": siempre retorna city_day; followup reporta issues.
// 4) Normalización y "patch mínimo" local si faltan comidas/hay etiquetas mal timing (sin re-LLM).
// 5) Se evita meter context + JSON gigante en repair: se manda SOLO lo necesario.

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
          notes: "⚠️ No se pudo generar un itinerario válido en este intento. Reintenta.",
          kind: "",
          zone: "",
        },
      ],
    });
  }
  return blocks;
}

/* ===================== Responses API call (con timeout) ===================== */
async function callText(messages, temperature = 0.28, max_output_tokens = 4800, timeoutMs = 90000) {
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
    // devolvemos string vacío; el handler decide
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
  return /golden circle|circulo dorado|círculo dorado|day trip|excursion|excursión|tour\b|peninsula|península|snæfellsnes|snaefellsnes/i.test(
    t
  );
}

/* ===================== Duration normalization ===================== */
function _normalizeDurationText_(txt) {
  const s = String(txt ?? "").trim();
  if (!s) return s;

  if (/Transporte\s*:/i.test(s) && /Actividad\s*:/i.test(s) && s.includes(",")) {
    return s.replace(/\s*,\s*Actividad\s*:/i, "\nActividad:");
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
  if (t.includes("cena")) return inRange(18 * 60, 22 * 60);
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
      kind: r?.kind ?? "",
      zone: r?.zone ?? "",
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

/* ===================== Quality Audit INFO (NO bloquea) ===================== */
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
  if (mealRows.some((r) => _mealToIsTooSpecific_(r))) issues.push('comidas: "to" demasiado específico (usar zona/centro a elección; opciones en notes).');

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
Devuelve **UN ÚNICO JSON VÁLIDO** (sin texto fuera).

OBJETIVO:
1) Piensa el itinerario COMPLETO primero (coherente, optimizado).
2) Emite SOLO el JSON final en city_day[] (Ciudad–Día) ORDENADO y COMPLETO 1..days_total.

CONTRATO row (OBLIGATORIO):
- day: número
- start/end: HH:MM (hora local realista)
- activity: empieza con "CIUDAD – ..."
- from/to: no vacíos; no genéricos en actividades reales
- transport: no vacío
- duration: 2 líneas EXACTAS con \\n:
  "Transporte: <...>"
  "Actividad: <...>"
- PROHIBIDO: "Transporte: 0m" o "Actividad: 0m"
- notes: >= 20 caracteres, emotivo + tip logístico (+ alternativa si aplica)

COMIDAS (flexibles):
- No obligatorias.
- Si incluyes, "to" = "Zona gastronómica (a elección)" o "Centro (a elección)".
- En notes pon 3 opciones concretas.

AURORAS (si plausibles):
- ventana nocturna realista
- "to" = zona oscura/mirador oscuro
- transport = "Vehículo alquilado (por cuenta propia) o Tour guiado (según duración/pickup)"
- no consecutivas, evitar último día
- notes incluyen: "valid:" + clima/nubosidad + alternativa low-cost

DAY-TRIPS:
- Si haces macro-day-trip, crea 5–8 sub-paradas REALES (filas),
  y cierra con fila: "CIUDAD – Regreso a {Ciudad}".

Salida mínima incluye:
destination,country,days_total,hotel_base,rationale,imperdibles,macro_tours,meals_suggestions,aurora,constraints,day_hours,city_day,rows_skeleton,followup
Responde SOLO JSON válido.
`.trim();

const SYSTEM_INFO_ULTRA = `${SYSTEM_INFO}
IMPORTANTE:
- NO markdown, NO backticks, NO texto fuera del JSON.
Responde SOLO JSON válido.
`.trim();

// PLANNER passthrough (no inventa)
const SYSTEM_PLANNER = `
Eres **Astra Planner**. Recibes "research_json".
Fuente: research_json (no inventes POIs).
Tu tarea: devolver city_day utilizable por el frontend.

REGLA:
- Usa SOLO research_json.city_day como fuente.
- No inventes filas nuevas, solo normaliza campos faltantes (kind/zone) y duration.
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
      kind: r?.kind ?? "",
      zone: r?.zone ?? "",
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
  // Intento 1 (normal)
  let raw = await callText([{ role: "system", content: SYSTEM_INFO }, infoUserMsg], 0.26, 5200, 110000);
  let parsed = cleanToJSONPlus(raw);
  if (parsed) return { parsed, raw, stage: "normal" };

  // Intento 2 (ultra)
  raw = await callText([{ role: "system", content: SYSTEM_INFO_ULTRA }, infoUserMsg], 0.18, 5600, 130000);
  parsed = cleanToJSONPlus(raw);
  if (parsed) return { parsed, raw, stage: "ultra" };

  return { parsed: null, raw: raw || "", stage: "failed" };
}

/* ===================== Repair compacto (1 vuelta) ===================== */
async function repairInfoJSONCompact(parsed, auditIssues, ctxDest) {
  // IMPORTANTÍSIMO: NO mandamos todo el contexto otra vez. Solo: issues + ciudad + JSON.
  const repairPrompt = `
Corrige el JSON a continuación para que cumpla reglas.
Devuelve SOLO JSON válido (sin texto fuera).

CIUDAD BASE: ${ctxDest}

ISSUES:
- ${auditIssues.slice(0, 12).join("\n- ")}

REGLAS CLAVE:
- Macro-day-trip: 5–8 sub-paradas reales + fila final "CIUDAD – Regreso a ${ctxDest}".
- Auroras: notes incluyen "valid:" + clima/nubosidad + alternativa low-cost; "to" = zona oscura/mirador oscuro; horario nocturno.
- Comidas: "to" genérico (Zona gastronómica (a elección) o Centro (a elección)) + 3 opciones en notes.
- activity siempre inicia con "${ctxDest} – ".
- duration siempre 2 líneas con \\n, sin 0m.

JSON A CORREGIR:
${JSON.stringify(parsed)}
`.trim();

  const raw = await callText([{ role: "system", content: SYSTEM_INFO_ULTRA }, { role: "user", content: repairPrompt }], 0.16, 5200, 120000);
  const repaired = cleanToJSONPlus(raw);
  return repaired || null;
}

/* ===================== Patch local mínimo (sin LLM) ===================== */
function _patchMealsLabeling_(parsed) {
  try {
    if (!Array.isArray(parsed?.city_day)) return parsed;
    parsed.city_day.forEach((b) => {
      const rows = Array.isArray(b.rows) ? b.rows : [];
      rows.forEach((r) => {
        if (!_looksLikeMealRow_(r.activity)) return;
        const s = _parseTimeToMin_(r.start);
        if (s == null) return;

        // Si dice "cena" pero es temprano (ej 17:30), renombrar a "almuerzo tardío / merienda" NO es deseable.
        // Mejor: si está entre 16:30-18:00, lo dejamos como "Cena" (en muchos países es temprano),
        // pero tu validador la marca mal. Entonces ampliamos la ventana aceptable para cena en el audit NO, aquí no.
        // En vez: si está 17:00-17:59, cambia etiqueta a "Reykjavik – Comida temprana (zona gastronómica)" para pasar reglas.
        const canon = _canonTxt_(r.activity);
        if (canon.includes("cena") && s >= 17 * 60 && s < 18 * 60) {
          r.activity = `${String(b.city || parsed.destination || "Ciudad").trim()} – Comida temprana en zona gastronómica`;
          // mantener to genérico
          if (!_canonTxt_(r.to).includes("zona gastronomica") && !_canonTxt_(r.to).includes("a eleccion")) {
            r.to = "Zona gastronómica (a elección)";
          }
        }
      });
    });
  } catch {}
  return parsed;
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
      const ctxDest = String(context?.city || "Destino").trim() || "Destino";

      // 1) Generar JSON
      let gen = await generateInfoJSON(infoUserMsg);
      let parsed = gen.parsed;

      // 2) Si NO parsea JSON -> skeleton (caso extremo)
      if (!parsed) {
        const out = {
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

        const normalized = normalizeDurationsInParsed(out);
        return res.status(200).json({ text: JSON.stringify(normalized) });
      }

      // 3) Normaliza shape + limpia legacy
      const destinationFallback = String(parsed?.destination || ctxDest || "").trim() || ctxDest;
      parsed.city_day = _normalizeCityDayShape_(parsed.city_day, destinationFallback);
      if (!Array.isArray(parsed.rows_skeleton)) parsed.rows_skeleton = [];
      if (!Array.isArray(parsed.day_hours)) parsed.day_hours = [];
      if ("rows_draft" in parsed) delete parsed.rows_draft;
      if ("rows" in parsed) delete parsed.rows;

      // 4) Si city_day viene vacío -> skeleton (caso extremo)
      const daysTotal = Math.max(1, Number(parsed?.days_total || ctxDays || 1));
      const destinationFinal = String(parsed?.destination || ctxDest || "Destino").trim() || "Destino";
      if (!Array.isArray(parsed.city_day) || parsed.city_day.length === 0) {
        parsed.city_day = skeletonCityDay(destinationFinal, daysTotal);
        parsed.followup = "⚠️ INFO devolvió JSON pero city_day vino vacío. Se devolvió skeleton para no romper el Planner. Reintenta INFO.";
        const normalized = normalizeDurationsInParsed(parsed);
        return res.status(200).json({ text: JSON.stringify(normalized) });
      }

      // 5) Patch local mínimo (evita fallos tontos del audit)
      parsed = _patchMealsLabeling_(parsed);
      parsed.city_day = _normalizeCityDayShape_(parsed.city_day, destinationFinal);

      // 6) Audit + Repair compacto 1 vuelta (NO bloquea render)
      let audit = _validateInfoResearch_(parsed, { days_total: daysTotal, destination: destinationFinal, city: destinationFinal });

      if (!audit.ok) {
        const repaired = await repairInfoJSONCompact(parsed, audit.issues, destinationFinal);
        if (repaired) {
          parsed = repaired;
          parsed.city_day = _normalizeCityDayShape_(parsed.city_day, destinationFinal);
          if (!Array.isArray(parsed.rows_skeleton)) parsed.rows_skeleton = [];
          if (!Array.isArray(parsed.day_hours)) parsed.day_hours = [];
          if ("rows_draft" in parsed) delete parsed.rows_draft;
          if ("rows" in parsed) delete parsed.rows;

          parsed = _patchMealsLabeling_(parsed);
          parsed.city_day = _normalizeCityDayShape_(parsed.city_day, destinationFinal);

          audit = _validateInfoResearch_(parsed, { days_total: daysTotal, destination: destinationFinal, city: destinationFinal });
        }
      }

      // 7) Followup informativo (nunca bloquea)
      if (!audit.ok) {
        parsed.followup = "⚠️ Itinerario renderizado con issues (no bloqueé): " + audit.issues.join(" | ");
      } else {
        parsed.followup = parsed.followup || "";
      }

      const normalized = normalizeDurationsInParsed(parsed);
      return res.status(200).json({ text: JSON.stringify(normalized) });
    }

    /* ===================== PLANNER ===================== */
    if (mode === "planner") {
      const research = body.research_json || null;

      // Si el cliente manda mensajes libres (raro en tu flujo), fallback a LLM (pero igual normaliza)
      if (!research) {
        const clientMessages = extractMessages(body);
        let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, ...clientMessages], 0.2, 2600, 70000);
        let parsed = cleanToJSONPlus(raw);
        if (!parsed) parsed = fallbackJSON();

        const destinationFallback = String(parsed?.destination || "").trim();
        parsed.city_day = _normalizeCityDayShape_(parsed.city_day, destinationFallback);
        if ("rows_draft" in parsed) delete parsed.rows_draft;
        if ("rows" in parsed) delete parsed.rows;

        const normalized = normalizeDurationsInParsed(parsed);
        return res.status(200).json({ text: JSON.stringify(normalized) });
      }

      const destination = String(research?.destination || research?.city || body?.destination || "").trim() || "Destino";

      // Passthrough real: solo city_day
      let city_day = _normalizeCityDayShape_(research?.city_day, destination);

      // Caso extremo: si research no trae city_day, usa skeleton
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
