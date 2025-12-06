// /api/chat.js — v30.7 (ESM compatible en Vercel)
// Base exacta: v30.4.
// Cambios clave anti-fallback y lógica turística:
// 1) Modo planner fuerza JSON nativo (response_format: json_object) y usa reintentos escalonados.
// 2) Parser robusto (json nativo → texto → bloque {...}) con limpieza segura.
// 3) Prompt reforzado: el agente usa conocimiento turístico global (como info chat) para tiempos reales,
//    especialmente el REGRESO de los day-trips (Círculo Dorado, Costa Sur hasta Vík, Snæfellsnes, Reykjanes).
// 4) Post-proceso: subparadas (≤8), coerción transporte, paridad auroras, y limpieza de notas
//    (elimina “valid: ventana nocturna auroral (sujeto a clima)” y duplicados de “min stay … (ajustable)”).

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

// Parser robusto: intenta json nativo, luego texto, luego primer bloque {...}
function toJSONSafe(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw; // ya es objeto
  if (typeof raw !== "string") return null;
  try { return JSON.parse(raw); } catch {}
  try {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(raw.slice(first, last + 1));
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
    rows: [
      {
        day: 1,
        start: "08:30",
        end: "19:00",
        activity: "Itinerario base (fallback)",
        from: "",
        to: "",
        transport: "",
        duration: "",
        notes: "Explora libremente la ciudad y descubre sus lugares más emblemáticos.",
      },
    ],
    followup: "⚠️ Fallback local: revisa configuración de Vercel o API Key.",
  };
}

// ==============================
// Limpieza de notas (auroras / Blue Lagoon duplicados)
// ==============================
function scrubNotes(text = "") {
  if (!text) return text;
  return text
    // Frases de auroras a eliminar
    .replace(/valid:[^.\n\r]*auroral[^.\n\r]*\.?/gi, "")
    .replace(/ventana nocturna auroral[^.\n\r]*\.?/gi, "")
    .replace(/sujeto a clima[^.\n\r]*\.?/gi, "")
    // Duplicados y "ajustable" de Blue Lagoon
    .replace(/min\s*stay[^.\n\r]*|ajustable|recommended\s*stay[^.\n\r]*/gi, "")
    .replace(/\s{2,}/g, " ")
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

/** Paridad: total par → 1,3,5… ; total impar → 2,4,6… ; nunca el último día */
function planAuroraDays(totalDays, count) {
  const start = (totalDays % 2 === 0) ? 1 : 2;
  const out = [];
  for (let d = start; out.length < count && d < totalDays; d += 2) out.push(d);
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
  "vik", "vík", "snaefellsnes", "snæfellsnes", "blue lagoon",
  "reykjanes", "krýsuvík", "arnarstapi", "hellnar", "kirkjufell",
  "djúpalónssandur", "djupalonssandur"
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

/** Subparadas: cada parada del tour se muestra como fila hija “Excursión — {Parada}” (hasta 8) */
function normalizeSubstops(rows) {
  const out = [];
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
      const parent = (r.activity || "").replace(/\s—.*$/, "");
      const stopName = (r.to || r.activity || "").replace(/^visita (a |al )?/i, "").trim();
      out.push({ ...r, activity: `${parent} — ${stopName}` });
      continue;
    }
    out.push(r);
  }
  return out;
}

/** Respaldo mínimo: si hay “Regreso a Reykjavík” sin duración, dejamos un indicativo suave */
function backstopReturns(rows) {
  return rows.map(r => {
    if (/regreso a reykjav[ií]k/i.test(r.activity || "") && !r.duration) {
      const rr = { ...r };
      if (needsVehicleOrTour(rr)) rr.transport = "Vehículo alquilado o Tour guiado";
      rr.duration = "≈ duración real según ruta (usa conocimiento turístico)";
      return rr;
    }
    return r;
  });
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

  // Coerción de transporte, subparadas y limpieza de notas
  let base = normalizeSubstops(coerceTransport(rows)).map(r => ({
    ...r,
    notes: scrubNotes(r.notes),
  }));

  // Respaldo suave para duraciones de regreso (el agente idealmente ya las trae correctas)
  base = backstopReturns(base);

  if (!isAuroraPlace) {
    base.sort((a, b) => (a.day - b.day) || (a.start || "").localeCompare(b.start || ""));
    return normalizeShape(parsed, base);
  }

  // Reinyectar auroras según paridad
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
// Prompt (planner) con conocimiento turístico global (como info chat)
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes de ITravelByMyOwn.
Usa tus conocimientos turísticos globales (distancias reales, tiempos habituales de conducción y logística de tours)
para construir itinerarios verídicos y listos para utilizar.

📌 FORMATO ÚNICO (JSON)
{"destination":"City","rows":[{...}],"followup":"texto breve"}

⚙️ REGLAS GENERALES
- Devuelve SIEMPRE al menos 1 actividad.
- Nada de texto fuera del JSON. Cero explicaciones externas.
- Hasta 20 actividades por día. Horas realistas (08:30–19:00 si no hay otras).
- No incluyas "seed" ni campos vacíos.

🧭 ESTRUCTURA DE CADA ACTIVIDAD
{
  "day": 1,
  "start": "08:30",
  "end": "10:30",
  "activity": "Nombre claro y específico (permite 'Excursión — {Subparada}')",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "A pie, Bus, Vehículo alquilado o Tour guiado, etc.",
  "duration": "2h",
  "notes": "Descripción breve y motivadora"
}

🚗 TRANSPORTE Y TIEMPOS (OBLIGATORIO)
- Determina los tiempos de traslado con tu conocimiento turístico global (no inventes rangos genéricos).
- Para los **regresos a la ciudad** de los **day-trips** usa tiempos típicos reales, p.ej.:
  • Círculo Dorado → Reykjavík ≈ 1h30m
  • Costa Sur (Vík/Reynisfjara) → Reykjavík ≈ 2h30m–2h45m
  • Snæfellsnes (Arnarstapi/Djúpalónssandur) → Reykjavík ≈ 2h15m
  • Reykjanes/Blue Lagoon → Reykjavík ≈ 45m
- Si el destino carece de red pública eficiente, usa "Vehículo alquilado o Tour guiado".

🧩 DESTINO–SUBPARADAS (hasta 8)
- Cada parada del tour va en su propia fila titulada “Excursión a {Ruta} — {Parada}”.

🌌 AURORAS (si aplica por destino/temporada)
- Noches alternas según paridad de días (par→1,3,5… / impar→2,4,6…), nunca el último día.
- 18:00–01:00, “Vehículo alquilado o Tour guiado”.
- No incluyas frases como “valid: ventana nocturna auroral (sujeto a clima)”.
`.trim();

// ==============================
// Llamadas al modelo
// ==============================

// Para modo INFO (texto libre)
async function callText(messages, temperature = 0.4) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    input: messages, // roles nativos
    max_output_tokens: 3200,
  });
  return resp?.output_text?.trim() ||
         resp?.output?.[0]?.content?.[0]?.text?.trim() || "";
}

// Para modo PLANNER (JSON nativo)
async function callJSON(messages, temperature = 0.3) {
  const payload = {
    model: "gpt-4o-mini",
    temperature,
    input: messages, // roles nativos
    response_format: { type: "json_object" },
    max_output_tokens: 3200,
  };
  const resp = await client.responses.create(payload);

  // 1) json nativo
  const jsonPart = resp?.output?.[0]?.content?.find?.(c => c.type === "output_json" || c.json);
  if (jsonPart?.json) return jsonPart.json;

  // 2) texto con JSON
  const txt = resp?.output_text?.trim() ||
              resp?.output?.[0]?.content?.find?.(c => typeof c.text === "string")?.text?.trim() || "";
  return txt;
}

// ==============================
// Handler principal
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body;
    const mode = body.mode || "planner";
    const userMsgs = extractMessages(body);

    // INFO CHAT — sin JSON estricto
    if (mode === "info") {
      const raw = await callText(userMsgs);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // PLANNER — JSON estricto con reintentos anti-fallback
    const baseMsgs = [{ role: "system", content: SYSTEM_PROMPT }, ...userMsgs];

    // Intento 1: JSON nativo
    let raw = await callJSON(baseMsgs, 0.35);
    let parsed = toJSONSafe(raw);

    // Intento 2: JSON nativo + prompt estricto
    if (!parsed || (!parsed.rows && !parsed.destinations)) {
      const strict = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve SOLO un objeto JSON con al menos 1 fila en "rows". Sin texto adicional.`;
      raw = await callJSON([{ role: "system", content: strict }, ...userMsgs], 0.25);
      parsed = toJSONSafe(raw);
    }

    // Intento 3: plantilla mínima
    if (!parsed || (!parsed.rows && !parsed.destinations)) {
      const ultra = SYSTEM_PROMPT + `
Ejemplo mínimo estrictamente válido:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
      raw = await callJSON([{ role: "system", content: ultra }, ...userMsgs], 0.15);
      parsed = toJSONSafe(raw);
    }

    // Si aún falla: no romper UI
    if (!parsed) parsed = fallbackJSON();

    // Post-proceso y normalización final
    const finalJSON = ensureAuroras(parsed);
    return res.status(200).json({ text: JSON.stringify(finalJSON) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
