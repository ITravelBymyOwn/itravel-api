// /api/chat.js — v30.5 (ESM compatible en Vercel)
// Base: v30.4 con mejoras completas de conocimiento turístico, formato de subparadas expandido,
// limpieza avanzada de notas (Blue Lagoon), y ajustes de regreso por tour.

import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==============================
// Helpers
// ==============================
function extractMessages(body = {}) {
  const { messages, input, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;
  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";
  return [...prev, { role: "user", content: userText }];
}

function cleanToJSONPlus(raw = "") {
  if (!raw || typeof raw !== "string") return null;
  try { return JSON.parse(raw); } catch {}
  try {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      const sliced = raw.slice(first, last + 1);
      return JSON.parse(sliced);
    }
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
    rows: [{
      day: 1,
      start: "08:30",
      end: "19:00",
      activity: "Itinerario base (fallback)",
      from: "",
      to: "",
      transport: "",
      duration: "",
      notes: "Explora libremente la ciudad y descubre sus lugares más emblemáticos."
    }],
    followup: "⚠️ Fallback local: revisa configuración de Vercel o API Key."
  };
}

// ==============================
// Limpieza de notas
// ==============================
function scrubLagoonAdjustable(text = "") {
  if (!text) return text;
  return text
    .replace(/valid:[^.\n\r]*auroral[^.\n\r]*\.?/gi, "")
    .replace(/min\s*stay[^.\n\r]*|ajustable|recommended\s*stay[^.\n\r]*/gi, "")
    .trim();
}

// ==============================
// LÓGICA POST-PROCESO (auroras, transporte, subparadas)
// ==============================
const AURORA_DESTINOS = [
  "reykjavik", "reykjavík", "tromso", "tromsø", "rovaniemi",
  "kiruna", "abisko", "alta", "ivalo", "yellowknife",
  "fairbanks", "akureyri"
];

function auroraNightsByLength(totalDays) {
  if (totalDays <= 2) return 1;
  if (totalDays <= 4) return 2;
  if (totalDays <= 6) return 2;
  if (totalDays <= 9) return 3;
  return 3;
}

function planAuroraDays(totalDays, count) {
  const start = (totalDays % 2 === 0) ? 1 : 2;
  const out = [];
  let d = start;
  while (out.length < count && d < totalDays) {
    out.push(d);
    d += 2;
  }
  return out;
}

const AURORA_NOTE_SHORT =
  "Noche especial de caza de auroras. Con cielos despejados y paciencia, podrás presenciar un espectáculo natural inolvidable. " +
  "La hora de regreso dependerá del tour o del punto elegido. " +
  "Puedes optar por tour guiado o conducir por tu cuenta (considera condiciones de nieve y visibilidad).";

function isAuroraRow(r) {
  const t = (r?.activity || "").toLowerCase();
  return t.includes("aurora");
}

const NO_BUS_TOPICS = [
  "círculo dorado", "thingvellir", "þingvellir", "geysir", "geyser",
  "gullfoss", "seljalandsfoss", "skógafoss", "reynisfjara",
  "vik", "vík", "snaefellsnes", "snæfellsnes",
  "blue lagoon", "reykjanes", "krýsuvík", "arnarstapi"
];

function needsVehicleOrTour(row) {
  const a = (row.activity || "").toLowerCase();
  const to = (row.to || "").toLowerCase();
  return NO_BUS_TOPICS.some(k => a.includes(k) || to.includes(k));
}

function coerceTransport(rows) {
  return rows.map(r => {
    const transport = (r.transport || "").toLowerCase();
    if (transport.includes("bus") && needsVehicleOrTour(r)) {
      return { ...r, transport: "Vehículo alquilado o Tour guiado" };
    }
    return r;
  });
}

// tours de 1 día con subparadas (una fila por parada)
function expandDayTourSubstops(rows) {
  const out = [];
  for (const r of rows) {
    if (!r) continue;
    const act = (r.activity || "").toLowerCase();
    const matchTour = act.includes("excursión") || act.includes("tour") ||
      act.includes("costa sur") || act.includes("círculo dorado") ||
      act.includes("península") || act.includes("blue lagoon") ||
      act.includes("reykjanes");
    if (matchTour && r.to) {
      const title = r.to.replace(/^visita (a |al )?/i, "").trim();
      const parent = (r.activity || "").replace(/\s—.*$/, "");
      r.activity = `${parent} — ${title}`;
    }
    out.push(r);
  }
  return out;
}

// ajuste de duración de regreso
function adjustDayTripReturns(rows) {
  const out = [...rows];
  const contains = (arr, regex) =>
    arr.some(x => regex.test(((x.activity || "") + " " + (x.to || "")).toLowerCase()));

  const days = {};
  for (const r of out) {
    const d = Number(r.day) || 1;
    if (!days[d]) days[d] = [];
    days[d].push(r);
  }

  Object.values(days).forEach(dayRows => {
    const isSouth = contains(dayRows, /(vik|vík|reynisfjara|seljalandsfoss|skógafoss)/i);
    const isGolden = contains(dayRows, /(gullfoss|geysir|thingvellir|þingvellir)/i);
    const isSnaef = contains(dayRows, /(snæfellsnes|snaefellsnes|kirkjufell|arnarstapi|hellnar)/i);
    const isReykjanes = contains(dayRows, /(blue lagoon|reykjanes|krýsuvík|grindavik)/i);

    const target =
      isSouth ? "≈ 2h45m–3h" :
      isGolden ? "≈ 1h15m–1h45m" :
      isSnaef ? "≈ 2h15m–3h" :
      isReykjanes ? "≈ 45m–1h" :
      "≈ 1h+";

    for (const r of dayRows) {
      if (/regreso a reykjav[ií]k/i.test(r.activity)) {
        r.duration = target;
        if (needsVehicleOrTour(r)) r.transport = "Vehículo alquilado o Tour guiado";
      }
    }
  });

  return out;
}

// unión de toda la lógica post-proceso
function ensureAuroras(parsed) {
  const dest = (parsed?.destination || parsed?.Destination || parsed?.city || parsed?.name || "").toString();
  const destName = dest || (parsed?.destinations?.[0]?.name || "");
  const low = destName.toLowerCase();

  const rows = Array.isArray(parsed?.rows)
    ? parsed.rows
    : Array.isArray(parsed?.destinations?.[0]?.rows)
      ? parsed.destinations[0].rows
      : [];

  if (!rows.length) return parsed;

  const totalDays = Math.max(...rows.map(r => Number(r.day) || 1));
  const isAuroraPlace = AURORA_DESTINOS.some(x => low.includes(x));

  let base = expandDayTourSubstops(coerceTransport(rows))
    .map(r => ({ ...r, notes: scrubLagoonAdjustable(r.notes) }));

  base = adjustDayTripReturns(base);

  if (!isAuroraPlace) return normalizeShape(parsed, base);

  base = base.filter(r => !isAuroraRow(r));

  const targetCount = auroraNightsByLength(totalDays);
  const targetDays = planAuroraDays(totalDays, targetCount);

  for (const d of targetDays) {
    base.push({
      day: d,
      start: "18:00",
      end: "01:00",
      activity: "Caza de auroras boreales",
      from: "Hotel",
      to: "Puntos de observación (variable)",
      transport: "Vehículo alquilado o Tour guiado",
      duration: "~7h",
      notes: AURORA_NOTE_SHORT,
    });
  }

  base.sort((a, b) => (a.day - b.day) || (a.start || "").localeCompare(b.start || ""));
  return normalizeShape(parsed, base);
}

function normalizeShape(parsed, rowsFixed) {
  if (Array.isArray(parsed?.rows)) {
    return { ...parsed, rows: rowsFixed };
  }
  if (Array.isArray(parsed?.destinations)) {
    const name = parsed.destinations?.[0]?.name || parsed.destination || "Destino";
    return { destination: name, rows: rowsFixed, followup: parsed.followup || "" };
  }
  return { destination: parsed?.destination || "Destino", rows: rowsFixed, followup: parsed?.followup || "" };
}

// ==============================
// Prompt base con conocimiento turístico extendido
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn.
Usa tus conocimientos de turismo mundial, distancias, clima, accesibilidad y tiempos reales entre atracciones.

📌 FORMATO JSON ÚNICO
{"destination":"City","rows":[{...}],"followup":"texto breve"}

⚙️ REGLAS
- Devuelve siempre al menos una actividad.
- Cero texto fuera del JSON.
- Hasta 20 actividades por día, horas realistas (08:30–19:00 si no se indica otra).
- No incluyas campos vacíos ni seeds.

🚗 TRANSPORTE
- Usa "Vehículo alquilado o Tour guiado" cuando el destino no tenga transporte público eficiente.
- Aplica conocimientos reales sobre distancias y tiempos entre atracciones.

🏔️ TOURS CLÁSICOS DESDE REYKJAVÍK
- Círculo Dorado: Thingvellir → Geysir → Gullfoss → regreso (≈1h15m–1h45m)
- Costa Sur: Seljalandsfoss → Skógafoss → Reynisfjara → Vík → regreso (≈2h30m–3h)
- Snæfellsnes: Kirkjufell, Arnarstapi, Hellnar, Djúpalónssandur → regreso (≈2h15m–3h)
- Reykjanes / Blue Lagoon: última parada en la laguna → regreso (≈45m–1h)

🌌 AURORAS
- Noches alternas según paridad de días (par→1,3,5…; impar→2,4,6…), nunca el último día.
- Horario 18:00–01:00, transporte “Vehículo alquilado o Tour guiado”.
- No incluyas frases de validez climática.

🧩 FORMATO DE TOURS Y SUBPARADAS
- Muestra cada parada en su propia fila.
  Ejemplo: "Excursión a la Costa Sur — Seljalandsfoss", "Excursión a la Costa Sur — Skógafoss".
- Máximo 8 subparadas antes del regreso.
`.trim();

// ==============================
// Llamada al modelo
// ==============================
async function callStructured(messages, temperature = 0.4) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    input: messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
    max_output_tokens: 3000,
  });
  const text =
    resp?.output_text?.trim() ||
    resp?.output?.[0]?.content?.[0]?.text?.trim() ||
    resp?.output?.[0]?.content?.[0]?.json?.trim() ||
    "";
  return text;
}

// ==============================
// Handler principal
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const body = req.body;
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    if (mode === "info") {
      const raw = await callStructured(clientMessages);
      return res.status(200).json({ text: raw || "⚠️ No se obtuvo respuesta." });
    }

    let raw = await callStructured([{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages]);
    let parsed = cleanToJSONPlus(raw);

    if (!parsed || (!parsed.rows && !parsed.destinations)) {
      const strictPrompt = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve solo JSON con al menos 1 fila en "rows".`;
      raw = await callStructured([{ role: "system", content: strictPrompt }, ...clientMessages], 0.25);
      parsed = cleanToJSONPlus(raw);
    }

    if (!parsed) parsed = fallbackJSON();
    const finalJSON = ensureAuroras(parsed);
    return res.status(200).json({ text: JSON.stringify(finalJSON) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
