// /api/chat.js — v51.4 (ESM, Vercel)
// Basado EXACTAMENTE en v51.2 + ajustes quirúrgicos para render-ready y reglas flexibles.
// Cambios clave:
// - INFO: filas render-ready SIEMPRE: start/end + duration 2 líneas + notes emotivas obligatorias.
// - COMIDAS: regla flexible (no obligatorias, nunca relleno; solo si aportan valor y son específicas).
// - AURORAS: regla flexible + research/inferencia obligatoria (plausibilidad + horario típico + duración tour típica),
//            transport dual (por cuenta propia o tour), notes con "valid:" + clima + alternativa low-cost.
// - Quality Gate + repair con re-audit (hasta 2 intentos).
// - Macro-tours: detección ampliada y regla 5–8 sub-paradas + regreso.
// - PLANNER: passthrough estricto de research_json.city_day; sin research_json => NO LLM (fallback).

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
            start: "",
            end: "",
            activity: "Desconocido – Itinerario base (fallback)",
            from: "Hotel",
            to: "Centro",
            transport: "Caminando",
            duration: "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat",
            notes: "⚠️ No se pudo generar itinerario. Revisa despliegue o vuelve a intentar.",
            kind: "",
            zone: "",
          },
        ],
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

function _rowsHaveCoverage_(rows, daysTotal) {
  if (!Array.isArray(rows) || !rows.length) return false;
  const need = Math.max(1, Number(daysTotal) || 1);
  const present = new Set(rows.map((r) => Number(r.day) || 1));
  for (let d = 1; d <= need; d++) {
    if (!present.has(d)) return false;
  }
  return true;
}

function _activityHasDestDash_(activity) {
  const s = String(activity || "");
  return /\s[–-]\s/.test(s);
}

function _isAurora_(activity) {
  return /auroras?|aurora|northern\s*lights/i.test(String(activity || ""));
}

function _hasZeroTransport_(duration) {
  const s = String(duration || "");
  return /Transporte\s*:\s*0m/i.test(s);
}

function _hasValidHHMM_(s) {
  return /^(\d{1,2}):(\d{2})$/.test(String(s || ""));
}

/* ===================== Placeholders & generics ===================== */
function _isGenericPlaceholderActivity_(activity) {
  const t = _canonTxt_(activity);
  if (!t) return true;

  // Nota: comidas NO son obligatorias, pero si existen deben ser específicas;
  // por eso mantenemos "cena local" como genérico si aparece sin especificidad.
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
    "cena local",
    "almuerzo local",
    "desayuno local",
  ];

  if (t.length <= 10 && /^(museo|parque|cafe|restaurante|plaza|mercado)$/i.test(t)) return true;
  if (bad.some((b) => t === b || t.includes(b))) return true;
  if (/^(museo|parque|cafe|restaurante)\b/i.test(t) && t.split(" ").length <= 3) return true;

  return false;
}

function _isGenericPlace_(s) {
  const t = _canonTxt_(s);
  if (!t) return true;
  if (t === "hotel") return false; // permitido como base
  const bad = [
    "restaurante local",
    "zona de observacion",
    "zona de observación",
    "centro comercial",
    "centro",
    "centro de la ciudad",
    "mirador",
    "cafe local",
    "café local",
    "mercado",
    "parque",
  ];
  if (bad.some((b) => t === _canonTxt_(b))) return true;
  if (t.split(" ").length <= 2 && /^(restaurante|mirador|zona|mercado|parque|cafe|café)$/i.test(t)) return true;
  return false;
}

/* ===================== Notes quality (emocionales + específicas) ===================== */
function _notesLooksExciting_(notes) {
  const s = String(notes || "").trim();
  if (!s) return false;
  const t = _canonTxt_(s);

  // Debe tener cierta longitud y evitar frases ultra genéricas
  const tooGeneric = [
    "disfruta",
    "explora",
    "pasa un buen rato",
    "diviertete",
    "diviértete",
    "haz fotos",
    "toma fotos",
    "relajate",
    "relájate",
  ].some((g) => t === _canonTxt_(g));

  if (tooGeneric) return false;
  if (t.length < 30) return false; // obliga un mínimo de riqueza

  // Señales de "energía" (no rígidas, pero ayudan)
  const hasEnergy =
    /[!✨🌟😍🤩🔥🎉🌌🌋🏔️🗺️📸]/.test(s) ||
    /(imperdible|ic[oó]nico|wow|magia|espectacular|asombroso|inolvidable|vistas?|panor[aá]micas?|c[aá]lido|acogedor|sabor|aut[eé]ntic)/i.test(
      s
    );

  return hasEnergy;
}

/* ===================== Macro-tour detection ===================== */
function _isMacroTourKey_(activity) {
  const t = _canonTxt_(activity);
  return /golden circle|circulo dorado|círculo dorado|day trip|excursion|excursión|tour\b|peninsula|península|snaefellsnes|snæfellsnes|south coast|costa sur|ring road|ruta 1|glacier|glaciar|waterfall|cascada/.test(
    t
  );
}

/* ===================== day_hours sanitizer ===================== */
function _sanitizeIncomingDayHours_(day_hours, daysTotal) {
  try {
    if (!Array.isArray(day_hours) || !day_hours.length) return null;

    const need = Math.max(1, Number(daysTotal) || day_hours.length || 1);
    const norm = (t) => String(t || "").trim();

    // string ["09:00-18:00", ...] con "-" o "–"
    const cleaned = day_hours.map((d, idx) => {
      if (typeof d === "string") {
        const m = d.match(/^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/);
        return {
          day: idx + 1,
          start: m ? m[1] : "",
          end: m ? m[2] : "",
        };
      }
      return {
        day: Number(d?.day) || idx + 1,
        start: norm(d?.start) || "",
        end: norm(d?.end) || "",
      };
    });

    const hasAny = cleaned.some((d) => d.start || d.end);
    if (!hasAny) return null;

    // No descartamos por "todos iguales": si vienen, se usan.
    const out = [];
    for (let i = 0; i < need; i++) {
      out.push(cleaned[i] || { day: i + 1, start: "", end: "" });
      out[i].day = i + 1;
    }
    return out;
  } catch {
    return null;
  }
}

/* ===================== city_day helpers ===================== */
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
      b.rows.forEach((r) => out.push({ ...r, day: Number(r.day) || b.day || 1 }));
    });
  return out;
}

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
    b.rows = (Array.isArray(b.rows) ? b.rows : []).map((r) => ({ ...r, day: Number(r?.day) || b.day }));
  });

  return out;
}

/* ===================== Normalización de duraciones (solo formato) ===================== */
function normalizeDurationsInParsed(parsed) {
  if (!parsed) return parsed;

  const norm = (txt) => {
    const s = String(txt ?? "").trim();
    if (!s) return s;

    if (_hasTwoLineDuration_(s)) return s;

    // "Transporte: X,Actividad: Y" => 2 líneas
    if (/Transporte\s*:/i.test(s) && /Actividad\s*:/i.test(s) && !/\n/.test(s)) {
      const fixed = s
        .replace(/\s*,\s*Actividad\s*:/i, "\nActividad:")
        .replace(/\s*;\s*Actividad\s*:/i, "\nActividad:");
      if (_hasTwoLineDuration_(fixed)) return fixed;
    }

    return s;
  };

  const touchRows = (rows = []) => rows.map((r) => ({ ...r, duration: norm(r.duration) }));

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

/* ===================== Aurora row checks (flexibles pero obligatorias en estructura) ===================== */
function _auroraTransportLooksFlexible_(transport) {
  const s = String(transport || "").toLowerCase();
  // Debe reflejar dualidad "o" / "tour" / "por cuenta propia"
  const hasDual =
    s.includes(" o ") &&
    (s.includes("tour") || s.includes("guiad") || s.includes("por cuenta propia") || s.includes("vehículo") || s.includes("vehiculo"));
  return hasDual;
}

function _auroraNotesHasValidity_(notes) {
  const s = String(notes || "");
  const t = _canonTxt_(s);

  const hasValid = /(^|\b)valid\s*:/i.test(s);
  const hasPlausibility = /(latitud|cinturon|cinturón|auroral|temporad|invierno|otoñ|primaver|fecha aproximada|condicional)/i.test(s);
  const hasWeather = /(clima|nubos|nubes|cielo|pron[oó]stico|kp|actividad solar)/i.test(s);
  const hasAlt = /(alternativa|plan b|opci[oó]n barata|bajo costo|mirador oscuro|punto oscuro|lugar oscuro)/i.test(s);

  return hasValid && hasPlausibility && hasWeather && hasAlt && t.length >= 60;
}

/* ===================== Quality Gate INFO (valida SOLO city_day) ===================== */
function _validateInfoResearch_(parsed, contextHint = {}) {
  const issues = [];
  const daysTotal = Math.max(1, Number(parsed?.days_total || contextHint?.days_total || 1));
  const destination = String(parsed?.destination || contextHint?.destination || contextHint?.city || "").trim();

  const hasCityDay = Array.isArray(parsed?.city_day) && parsed.city_day.length;
  if (!hasCityDay) issues.push("city_day vacío o ausente (obligatorio).");

  const rows = hasCityDay ? _flattenCityDayBlocks_(parsed.city_day) : [];
  if (rows.length && !_rowsHaveCoverage_(rows, daysTotal)) issues.push("No cubre todos los días 1..days_total.");

  // start/end obligatorios (render-ready)
  if (rows.length && rows.some((r) => !_hasValidHHMM_(r.start) || !_hasValidHHMM_(r.end))) {
    issues.push("start/end ausentes o inválidos (HH:MM) en una o más filas.");
  }

  // duration 2 líneas + sin Transporte:0m
  if (rows.length && rows.some((r) => !_hasTwoLineDuration_(r.duration))) issues.push("duration no cumple 2 líneas.");
  if (rows.length && rows.some((r) => _hasZeroTransport_(r.duration))) issues.push('hay "Transporte: 0m" (prohibido).');

  // placeholders y campos obligatorios
  if (rows.length && rows.some((r) => _isGenericPlaceholderActivity_(r.activity))) issues.push("placeholders genéricos en activity.");
  if (rows.length && rows.some((r) => !_activityHasDestDash_(r.activity))) issues.push('activity sin "Destino – Sub-parada".');
  if (rows.length && rows.some((r) => !String(r.from || "").trim() || !String(r.to || "").trim())) issues.push("from/to vacíos.");
  if (rows.length && rows.some((r) => !String(r.transport || "").trim())) issues.push("transport vacío.");

  // Evitar lugares ultra genéricos en to/from (Hotel permitido)
  if (rows.length && rows.some((r) => _isGenericPlace_(r.to) || _isGenericPlace_(r.from))) {
    issues.push("from/to demasiado genéricos (p.ej. 'Restaurante local', 'Zona de observación', 'Centro comercial').");
  }

  // Notes obligatorias, excitantes y específicas
  if (rows.length && rows.some((r) => !String(r.notes || "").trim())) issues.push("notes vacío (obligatorio).");
  if (rows.length && rows.some((r) => !_notesLooksExciting_(r.notes))) issues.push("notes no cumple tono motivador/específico (muy genérico o corto).");

  // Auroras (flexible + research/inferencia obligatorio si se propone)
  const auroraRows = rows.filter((r) => _isAurora_(r.activity));
  const auroraDays = auroraRows.map((r) => Number(r.day) || 1).sort((a, b) => a - b);

  // Reglas suaves: no consecutivas y evitar último día (si cabe). Aquí lo mantenemos como restricción (tu base lo quería).
  for (let i = 1; i < auroraDays.length; i++) {
    if (auroraDays[i] === auroraDays[i - 1] + 1) {
      issues.push("auroras en días consecutivos (evitar; no permitido en output).");
      break;
    }
  }
  // Si el modelo insiste en último día, puede marcar condicional, pero sigue siendo mala práctica.
  // Mantengo tu regla original de evitar último día.
  if (auroraDays.includes(daysTotal)) issues.push("auroras en el último día (evitar; no permitido en output).");

  // Deben tener start/end nocturnos y transport dual + notes con valid:
  if (auroraRows.some((r) => !_isNightWindow_(r.start, r.end))) issues.push("auroras fuera de ventana nocturna (prohibido).");
  if (auroraRows.some((r) => !_auroraTransportLooksFlexible_(r.transport)))
    issues.push('aurora: transport debe reflejar "por cuenta propia o tour guiado".');
  if (auroraRows.some((r) => !_auroraNotesHasValidity_(r.notes)))
    issues.push('aurora: notes debe incluir "valid:" + plausibilidad (latitud/temporada) + clima + alternativa low-cost.');

  // Macro-tours/day-trips
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
      return a.includes("regreso") && (baseCity ? a.includes(_canonTxt_(baseCity)) : true);
    });
    if (!hasReturn) issues.push(`macro-tour/day-trip en día ${d} sin "Regreso a ${baseCity || "ciudad base"}".`);

    if (d === daysTotal) issues.push("macro-tour/day-trip en el último día (no permitido).");
  }

  return { ok: issues.length === 0, issues };
}

/* ===================== Prompts ===================== */
const SYSTEM_INFO = `
Eres el **Info Chat interno** de ITravelByMyOwn.
Debes devolver **UN ÚNICO JSON VÁLIDO** (sin texto fuera).

ROL:
Actúas como un **experto mundial en viajes** y como un **planner profesional**.
Debes "pensar completo" el itinerario y SOLO cuando esté listo lo entregas como JSON.

OBJETIVO:
1) Planifica el itinerario completo (evita repeticiones/contradicciones).
2) Devuelve city_day[] (Ciudad–Día) ORDENADO y COMPLETO 1..days_total.
3) El JSON debe estar listo para renderizar una tabla (horas + duración + notas).

CONTRATO filas (OBLIGATORIO por cada row):
- day: número
- start: "HH:MM" (obligatorio)
- end: "HH:MM" (obligatorio)
- activity: "DESTINO – SUB-PARADA" (– o - con espacios)
- from/to/transport: NO vacíos y NO genéricos ("Restaurante local", "Zona de observación", "Centro comercial" prohibidos; "Hotel" permitido)
- duration: EXACTAMENTE 2 líneas con salto de línea \\n:
  "Transporte: <tiempo realista o 'Verificar duración en el Info Chat'>"
  "Actividad: <tiempo realista o 'Verificar duración en el Info Chat'>"
- PROHIBIDO: "Transporte: 0m"
- notes: OBLIGATORIO, **súper motivador y excitante**, específico del lugar (no genérico), que haga al viajero sonreír.

COMIDAS (Regla Flexible):
- NO son obligatorias ni prioritarias.
- Inclúyelas solo si aportan valor real al flujo del día (ritmo, logística, cultura local).
- Si incluyes comidas, deben ser específicas (no genéricas) y con horarios realistas (cena ~19:00–21:30).
- Si NO incluyes comidas, el día sigue siendo válido.
- Nunca rellenes huecos automáticamente con comidas.

DURACIONES (research/inferencia):
- Estima duraciones como lo haría un experto: transporte según distancia/tipo (caminando, auto, tour) y actividad según el lugar.
- Solo usa "Verificar duración en el Info Chat" si realmente es imposible estimar con seguridad.
- Evita horarios imposibles; incluye buffers ~10–20m cuando aplique.

HORARIOS:
- Si day_hours existe (por día), respeta ese rango.
- Si day_hours no existe o está vacío, tú decides horarios realistas y coherentes para todo el día.

AURORAS (Regla Flexible + research obligatorio):
- Solo sugerir auroras si son PLAUSIBLES para la ciudad y fechas aproximadas:
  • Plausibilidad por latitud (cinturón auroral) + época del año (temporada).
  • Si no hay fecha exacta, asume posible pero indícalo como condicional en notes.

- NO fijes horas por defecto:
  • Debes INVESTIGAR/INFERIR el horario típico local (picos habituales) en esa ciudad/época.
  • Luego asigna start/end coherentes con ese patrón (buffers ~10–20m).

- Tours de auroras:
  • Si propones tour, INVESTIGA/INFIERE duración típica local.
  • duration (2 líneas):
    - Transporte: estimación realista (pickup/traslados si aplica) o "Verificar..." solo si es imposible.
    - Actividad: duración típica del tour (ej. "~3h–5h"), no genérica.

- Transporte (columna transport) debe ser explícito y flexible:
  • Debe reflejar dualidad "por cuenta propia vs tour".
  • Formato recomendado:
    "Vehículo alquilado (por cuenta propia) o Tour guiado (según duración/pickup)"
  • Nunca transport vacío.

- Reglas suaves:
  • Evitar auroras en días consecutivos si hay varias opciones.
  • Evitar ponerla como última actividad obligatoria del último día; si solo cabe ese día, marcar como condicional.

- Notes obligatorias para auroras (en la fila de aurora):
  • Incluir "valid:" con justificación breve (latitud/temporada) + aviso clima/nubosidad.
  • Sugerir alternativa de bajo costo (mirador oscuro cercano/punto oscuro).

- Si no puedes estimar con seguridad:
  • Solo entonces usar "Verificar duración en el Info Chat".

DAY-TRIPS / MACRO-TOURS:
- 5–8 sub-paradas reales (no genéricas) + cerrar con "Regreso a {Destino}".
- No en el último día.

SALIDA mínima:
{
  "destination":"Ciudad",
  "country":"País",
  "days_total":N,
  "hotel_base":"...",
  "rationale":"...",
  "imperdibles":[],
  "macro_tours":[],
  "meals_suggestions":[],
  "aurora":{"plausible":false,"suggested_days":[],"window_local":{"start":"","end":""},"duration":"~3h–5h","transport_default":"Vehículo alquilado (por cuenta propia) o Tour guiado (según duración/pickup)","note":""},
  "constraints":{"max_substops_per_tour":8,"no_consecutive_auroras":true,"no_last_day_aurora":true,"thermal_lagoons_min_stay_minutes":180},
  "day_hours":[],
  "city_day":[{"city":"Ciudad","day":1,"rows":[...]}],
  "rows_skeleton":[]
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

Salida:
{ "destination":"Ciudad", "city_day":[...], "followup":"" }
`.trim();

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

      // Sanitize day_hours (sin asumir horas)
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

      // Intento 1
      let raw = await callText([{ role: "system", content: SYSTEM_INFO }, infoUserMsg], 0.28, 4200, 55000);
      let parsed = cleanToJSONPlus(raw);

      // Intento 2 si no parsea
      if (!parsed) {
        const strict = SYSTEM_INFO + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, infoUserMsg], 0.2, 3800, 55000);
        parsed = cleanToJSONPlus(raw);
      }

      // Audit + Repair (hasta 2), con re-audit
      if (parsed) {
        const ctxDays = context?.days_total || context?.days || context?.daysTotal || 1;
        const ctxDest = context?.city || parsed?.destination || "";
        const ctxCity = context?.city || "";

        const audit1 = _validateInfoResearch_(normalizeDurationsInParsed(parsed), {
          days_total: ctxDays,
          destination: ctxDest,
          city: ctxCity,
        });

        if (!audit1.ok) {
          const repairPrompt1 = `
${SYSTEM_INFO}

REPARACIÓN OBLIGATORIA:
Fallos:
- ${audit1.issues.join("\n- ")}

Instrucciones:
- No cambies el destino ni los días.
- Mantén el plan, pero corrige: start/end, duration (2 líneas), notes excitantes en cada fila.
- Asegura que comidas NO sean relleno: solo si aportan y sean específicas.
- AURORAS: si propones auroras, incluye "valid:" (latitud/temporada + clima + alternativa low-cost), transport dual, y horarios inferidos (no default).
- Asegura day-trips con 5–8 sub-paradas + regreso.

Responde SOLO JSON válido.
`.trim();

          const repairRaw1 = await callText([{ role: "system", content: repairPrompt1 }, infoUserMsg], 0.16, 5200, 55000);
          const repaired1 = cleanToJSONPlus(repairRaw1);
          if (repaired1) parsed = repaired1;

          const audit2 = _validateInfoResearch_(normalizeDurationsInParsed(parsed), {
            days_total: ctxDays,
            destination: ctxDest,
            city: ctxCity,
          });

          if (!audit2.ok) {
            const repairPrompt2 = `
${SYSTEM_INFO}

REPARACIÓN FINAL (OBLIGATORIA):
Persisten fallos:
- ${audit2.issues.join("\n- ")}

Devuelve city_day cumpliendo 100% el contrato.
Responde SOLO JSON válido.
`.trim();

            const repairRaw2 = await callText([{ role: "system", content: repairPrompt2 }, infoUserMsg], 0.14, 5600, 55000);
            const repaired2 = cleanToJSONPlus(repairRaw2);
            if (repaired2) parsed = repaired2;
          }
        }
      }

      // Fallback mínimo si no hay parsed
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
            transport_default: "Vehículo alquilado (por cuenta propia) o Tour guiado (según duración/pickup)",
            note: "Actividad sujeta a clima.",
            duration: "~3h–5h",
          },
          constraints: {
            max_substops_per_tour: 8,
            no_consecutive_auroras: true,
            no_last_day_aurora: true,
            thermal_lagoons_min_stay_minutes: 180,
          },
          day_hours: Array.isArray(context?.day_hours) ? context.day_hours : [],
          city_day: [],
          rows_skeleton: [],
          followup: "⚠️ No se pudo generar un itinerario válido. Intenta nuevamente.",
        };
      }

      // ✅ Asegurar forma city_day (y limpiar legacy)
      try {
        const destinationFallback = String(parsed?.destination || context?.city || "").trim();
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

      parsed = normalizeDurationsInParsed(parsed);
      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    /* ===================== PLANNER ===================== */
    if (mode === "planner") {
      // Solo passthrough; NO LLM si falta research_json
      const research = body.research_json || null;

      if (!research) {
        return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
      }

      const destination = String(research?.destination || research?.city || body?.destination || "").trim() || "Destino";

      // ✅ SOLO city_day como fuente de verdad
      let city_day = _normalizeCityDayShape_(research?.city_day, destination);

      // Compat (último recurso): reconstruir desde rows (legacy) si city_day viene vacío
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

      const out = {
        destination,
        city_day,
        followup: "",
      };

      const normalized = normalizeDurationsInParsed(out);
      return res.status(200).json({ text: JSON.stringify(normalized) });
    }

    return res.status(400).json({ error: "Invalid mode" });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
