// /api/chat.js — v30.0 (ESM compatible en Vercel) — Simplificado con reglas de Auroras + Sub-paradas
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

function cleanToJSON(raw = "") {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    try {
      const cleaned = raw.replace(/^[^\{]+/, "").replace(/[^\}]+$/, "");
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }
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
// Prompt base — REGLAS CLAVE
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido** (sin texto fuera del JSON).

📌 FORMATOS VÁLIDOS
{"destination":"City","rows":[{...}],"followup":"texto breve"}
{"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

🧭 ESTRUCTURA DE CADA ACTIVIDAD (OBLIGATORIA)
{
  "day": 1,
  "start": "08:30",
  "end": "10:30",
  "activity": "Nombre claro y específico",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "Transporte realista (A pie, Metro, Tren, Taxi, Transporte público, Tour guiado o Vehículo propio, etc.)",
  "duration": "2h",
  "notes": "Nota breve y motivadora (máx. 2 líneas)"
}

🚫 LÍMITES
- Máx. 20 actividades por día.
- Horario global 08:00–01:00 (permitido cruzar de día con "_crossDay": true).
- Sin solapes; distribuye buffers ≥15 min.

🧭 DESTINO – SUB-PARADAS (universal)
- Si la actividad es tour/excursión/ruta/día completo fuera del entorno urbano, **DESGLOSA** en 3–8 sub-paradas (ideal 5–6) con horas crecientes y traslados 15–45 min.
- Estructura: Salida desde <Ciudad base> (30–60m) → 3–6 sub-paradas (45–120m c/u) → Pausa gastronómica (60–90m) → **"Regreso a <Ciudad>"** (1–3h).
- Transporte:
  • Entre puntos fuera de ciudad: "Tour guiado o Vehículo propio".
  • Dentro de cada sitio: "A pie" (o urbano).
  • Tras "Regreso a <Ciudad>", usa medios urbanos y **NO** heredes el foráneo.
- Duración total del bloque 8–11h. Si queda corto, añade "Tiempo libre" motivador.

🌌 AURORAS / NOCTURNAS (si la ciudad y temporada aplican: latitudes altas ≈≥60°N y SEP–MAR)
- Ventana fija: 18:00–01:00 (cruza día) con "_crossDay": true y "duration": "Depende del tour".
- Nota estandarizada (primera oración sin negrita; el resto en **negrita**):
  Noche especial de caza de auroras. **Con cielos despejados y paciencia, podrás presenciar un espectáculo natural inolvidable. La hora de regreso al hotel dependerá del tour de auroras que se tome. Puedes optar por tour guiado o movilización por tu cuenta (es probable que debas conducir con nieve y de noche, investiga acerca de la seguridad en la época de tu visita).**
- Distribución determinística por estancia (sin noches consecutivas, evitar la última noche):
  • 1–5 días → días 1,3
  • 1–7 días → 1,3,5
  • 1–10 días → 1,3,5,7
  • 1–15 días → 1,3,5,7,9,11
- Si habrá auroras esa noche, asegúrate de que **"Regreso a <Ciudad>"** termine ≤18:00–18:30.
- Si la última actividad es aurora/nocturna extendida, **NO** añadas "Regreso a hotel".

📝 EDICIÓN INTELIGENTE
- Si el usuario pide agregar/quitar/ajustar, devuelve el JSON completo actualizado (misma estructura).
`.trim();

// ==============================
// Llamada al modelo
// ==============================
async function callStructured(messages, temperature = 0.4) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    input: messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
    max_output_tokens: 2200,
  });
  const text =
    resp?.output_text?.trim() ||
    resp?.output?.[0]?.content?.[0]?.text?.trim() ||
    "";
  return text;
}

// ==============================
// Exportación ESM
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body;
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    // MODO INFO CHAT — texto libre
    if (mode === "info") {
      const raw = await callStructured(clientMessages);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // MODO PLANNER
    let raw = await callStructured([{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages]);
    let parsed = cleanToJSON(raw);

    const hasRows = parsed && (parsed.rows || parsed.destinations);
    if (!hasRows) {
      const strictPrompt = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve al menos 1 fila en "rows". Nada de meta.`;
      raw = await callStructured([{ role: "system", content: strictPrompt }, ...clientMessages], 0.25);
      parsed = cleanToJSON(raw);
    }

    const stillNoRows = !parsed || (!parsed.rows && !parsed.destinations);
    if (stillNoRows) {
      const ultraPrompt = SYSTEM_PROMPT + `
Ejemplo válido:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
      raw = await callStructured([{ role: "system", content: ultraPrompt }, ...clientMessages], 0.1);
      parsed = cleanToJSON(raw);
    }

    if (!parsed) parsed = fallbackJSON();
    return res.status(200).json({ text: JSON.stringify(parsed) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
