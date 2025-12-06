// /api/chat.js — v30.8 (ESM compatible en Vercel)
// Base exacta: v30.4. Cambios anti-fallback y lógica:
// 1) Modo planner: response_format: { type: "json_object" } + input en TEXTO con roles (como 30.4).
// 2) Parser robusto (JSON directo → bloque {...} → limpieza de bordes) y 3 reintentos escalonados.
// 3) Prompt reforzado para que use conocimiento turístico global (como Info Chat) en tiempos de day-trips.
// 4) Post-proceso: subparadas (≤8) como filas “Excursión a {Ruta} — {Parada}”, coerción de transporte,
//    paridad de auroras y limpieza de notas (elimina “valid: … auroral …”, “min stay … (ajustable)”).

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

// Parser robusto (igual espíritu de tu 30.4)
function cleanToJSONPlus(raw = "") {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  try { return JSON.parse(raw); } catch {}
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

// Fallback mínimo (formato válido para la UI)
function fallbackJSON() {
  return {
    destination: "Desconocido",
    rows: [{
      day: 1, start: "08:30", end: "19:00",
      activity: "Itinerario base (fallback)", from: "", to: "",
      transport: "", duration: "", notes: "Explora libremente la ciudad."
    }],
    followup: "⚠️ Fallback local: revisa configuración de Vercel o API Key."
  };
}

// ==============================
// Limpieza de notas (auroras / Blue Lagoon duplicados)
// ==============================
function scrubNotes(text = "") {
  if (!text) return text;
  return text
    .replace(/valid:[^.\n\r]*auroral[^.\n\r]*\.?/gi, "")
    .replace(/ventana nocturna auroral[^.\n\r]*\.?/gi, "")
    .replace(/\b(sujeto a clima|subject to weather)\b[^.\n\r]*\.?/gi, "")
    .replace(/min\s*stay[^.\n\r]*\(ajustable\)/gi, "")
    .replace(/min\s*stay[^.\n\r]*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ==============================
// LÓGICA POST-PROCESO (auroras, transporte, subparadas)
// ==============================
const AURORA_DESTINOS = [
  "reykjavik","reykjavík","tromso","tromsø","rovaniemi","kiruna",
  "abisko","alta","ivalo","yellowknife","fairbanks","akureyri"
];

function auroraNightsByLength(totalDays) {
  if (totalDays <= 2) return 1;
  if (totalDays <= 4) return 2;
  if (totalDays <= 6) return 2;
  if (totalDays <= 9) return 3;
  return 3;
}

/** Paridad: total par→1,3,5… ; total impar→2,4,6… ; nunca el último día */
function planAuroraDays(totalDays, count) {
  const start = (totalDays % 2 === 0) ? 1 : 2;
  const out = [];
  for (let d = start; out.length < count && d < totalDays; d += 2) out.push(d);
  return out;
}

const AURORA_NOTE_SHORT =
  "Noche especial de caza de auroras. Con cielos despejados y paciencia, podrás presenciar un espectáculo natural inolvidable. " +
  "La hora de regreso dependerá del tour o del punto elegido. " +
  "Puedes optar por tour guiado o conducir por tu cuenta (considera nieve y visibilidad).";

function isAuroraRow(r) {
  const t = (r?.activity || "").toLowerCase();
  return t.includes("aurora");
}

const NO_BUS_TOPICS = [
  "círculo dorado","thingvellir","þingvellir","geysir","geyser","gullfoss",
  "seljalandsfoss","skógafoss","reynisfjara","vik","vík",
  "snaefellsnes","snæfellsnes","kirkjufell","arnarstapi","hellnar",
  "djúpalónssandur","djupalonssandur","blue lagoon","reykjanes","krýsuvík"
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
    return { ...r };
  });
}

/** Formato requerido: fila por subparada — “Excursión a {Ruta} — {Parada}” (hasta 8) */
function normalizeSubstops(rows) {
  const out = [];
  let countPerTour = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const act = (r.activity || "").toLowerCase();
    const isTour =
      act.startsWith("excursión") || act.includes("tour") ||
      act.includes("costa sur") || act.includes("círculo dorado") ||
      act.includes("península") || act.includes("reykjanes") ||
      act.includes("blue lagoon");

    if (isTour && r.to) {
      const parent = (r.activity || "").replace(/\s—.*$/, "").replace(/\s+$/,"");
      const stop = (r.to || r.activity || "").replace(/^visita (a |al )?/i, "").trim();
      const finalAct = parent.match(/—/)
        ? parent // si ya viene con “— …” lo respetamos
        : `Excursión a ${parent.replace(/^Excursión (a|al)\s*/i,"").trim()} — ${stop}`;
      out.push({ ...r, activity: finalAct });
      countPerTour++;
      if (countPerTour >= 8) countPerTour = 0; // límite de subparadas
      continue;
    }
    // reset contador cuando no estamos en tour
    countPerTour = 0;
    out.push(r);
  }
  return out;
}

function ensureAuroras(parsed) {
  const dest =
    (parsed?.destination || parsed?.Destination || parsed?.city || parsed?.name || "").toString();
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

  let base = normalizeSubstops(coerceTransport(rows)).map(r => ({
    ...r,
    notes: scrubNotes(r.notes),
  }));

  if (!isAuroraPlace) {
    base.sort((a, b) => (a.day - b.day) || (a.start || "").localeCompare(b.start || ""));
    return normalizeShape(parsed, base);
  }

  // Eliminar/inyectar auroras por paridad
  base = base.filter(r => !isAuroraRow(r));
  const targetCount = auroraNightsByLength(totalDays);
  const targetDays = planAuroraDays(totalDays, targetCount);

  for (const d of targetDays) {
    base.push({
      day: d, start: "18:00", end: "01:00",
      activity: "Caza de auroras boreales",
      from: "Hotel", to: "Puntos de observación (variable)",
      transport: "Vehículo alquilado o Tour guiado",
      duration: "~7h", notes: AURORA_NOTE_SHORT
    });
  }

  base.sort((a, b) => (a.day - b.day) || (a.start || "").localeCompare(b.start || ""));
  return normalizeShape(parsed, base);
}

function normalizeShape(parsed, rowsFixed) {
  if (Array.isArray(parsed?.rows)) return { ...parsed, rows: rowsFixed };
  if (Array.isArray(parsed?.destinations)) {
    const name = parsed.destinations?.[0]?.name || parsed.destination || "Destino";
    return { destination: name, rows: rowsFixed, followup: parsed.followup || "" };
  }
  return { destination: parsed?.destination || "Destino", rows: rowsFixed, followup: parsed?.followup || "" };
}

// ==============================
// Prompt (planner) reforzado — conocimiento turístico global
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes de ITravelByMyOwn.
Usa tu conocimiento turístico global (distancias reales, tiempos habituales de conducción, logística de tours)
para construir itinerarios verídicos y listos para usar.

📌 FORMATO ÚNICO (JSON)
{"destination":"City","rows":[{...}],"followup":"texto breve"}

⚙️ REGLAS
- Devuelve al menos 1 actividad en "rows".
- Cero texto fuera del JSON. Máx. 20 actividades/día. Horas realistas (08:30–19:00 si no hay otras).
- No incluyas "seed" ni campos vacíos.

🧭 ACTIVIDAD
{
  "day": 1, "start": "08:30", "end": "10:30",
  "activity": "Nombre claro (permite 'Excursión a {Ruta} — {Parada}')",
  "from": "Origen", "to": "Destino",
  "transport": "A pie, Bus, Vehículo alquilado o Tour guiado, etc.",
  "duration": "2h", "notes": "Breve y motivadora"
}

🚗 TIEMPOS Y REGRESOS (OBLIGATORIO)
- Usa tus conocimientos turísticos globales para los traslados (no inventes rangos genéricos).
- Para day-trips desde Reykjavík, referencias habituales:
  • Círculo Dorado → Reykjavík ≈ 1h30m
  • Costa Sur (Vík/Reynisfjara) → Reykjavík ≈ 2h30m–2h45m
  • Snæfellsnes (Arnarstapi/Djúpalónssandur) → Reykjavík ≈ 2h15m–2h45m
  • Reykjanes/Blue Lagoon → Reykjavík ≈ 45m–1h
- Si el destino carece de red pública eficiente, usa "Vehículo alquilado o Tour guiado".

🧩 DESTINO–SUBPARADAS
- Modela tours de 1 día como filas: “Excursión a {Ruta} — {Parada}”, hasta 8 subparadas.

🌌 AURORAS (si aplica)
- Noches alternas por paridad (par→1,3,5… / impar→2,4,6…), nunca el último día. 18:00–01:00.
- No escribas frases como “valid: ventana nocturna auroral (sujeto a clima)”.
`.trim();

// ==============================
// Llamadas al modelo
// ==============================
async function callPlanner(messages, temperature = 0.35, prompt = SYSTEM_PROMPT) {
  const textInput = [{ role: "system", content: prompt }, ...messages]
    .map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");

  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    response_format: { type: "json_object" },
    input: textInput,
    max_output_tokens: 3200,
  });

  const text =
    resp?.output_text?.trim() ||
    resp?.output?.[0]?.content?.[0]?.text?.trim() ||
    "";

  return text;
}

async function callInfo(messages, temperature = 0.4) {
  const textInput = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    input: textInput,
    max_output_tokens: 3200,
  });
  return resp?.output_text?.trim() ||
         resp?.output?.[0]?.content?.[0]?.text?.trim() ||
         "";
}

// ==============================
// Handler
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = req.body;
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    // INFO CHAT — texto libre
    if (mode === "info") {
      const raw = await callInfo(clientMessages);
      return res.status(200).json({ text: raw || "⚠️ No se obtuvo respuesta." });
    }

    // PLANNER — JSON estricto con reintentos
    let raw = await callPlanner(clientMessages, 0.35, SYSTEM_PROMPT);
    let parsed = cleanToJSONPlus(raw);

    if (!parsed || (!parsed.rows && !parsed.destinations)) {
      const strict = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve SOLO un objeto JSON con al menos 1 fila en "rows". Sin texto adicional.`;
      raw = await callPlanner(clientMessages, 0.25, strict);
      parsed = cleanToJSONPlus(raw);
    }

    if (!parsed || (!parsed.rows && !parsed.destinations)) {
      const ultra = SYSTEM_PROMPT + `
Ejemplo mínimo estrictamente válido:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
      raw = await callPlanner(clientMessages, 0.15, ultra);
      parsed = cleanToJSONPlus(raw);
    }

    if (!parsed) parsed = fallbackJSON();

    // Post-proceso y normalización
    const finalJSON = ensureAuroras(parsed);
    return res.status(200).json({ text: JSON.stringify(finalJSON) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
