// /api/chat.js — versión revisada para priorizar itinerarios (v2)
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Extrae mensajes desde body (compat input+history o messages[])
function extractMessages(body = {}) {
  const { messages, input, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;

  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";
  return [...prev, { role: "user", content: userText }];
}

// Intenta limpiar y parsear a JSON
function cleanToJSON(raw = "") {
  let s = (raw || "").trim();
  if (!s) return null;

  // Quitar bloques de ```json ... ```
  if (/```json/i.test(s)) s = s.replace(/```json|```/gi, "").trim();
  else if (s.startsWith("```") && s.endsWith("```")) s = s.slice(3, -3).trim();

  // Intento directo
  try { return JSON.parse(s); } catch (_) {}

  // Extraer primer bloque { ... } o [ ... ]
  const m = s.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (m) {
    try { return JSON.parse(m[1]); } catch (_) {}
  }

  return null;
}

// Fallback mínimo en caso de fallo total
function fallbackJSON() {
  return {
    meta: {
      city: "Desconocido",
      baseDate: new Date().toLocaleDateString("es-ES"),
      start: ["08:30"],
      end: "19:00",
      hotel: "",
    },
    followup:
      "No se recibió información de itinerario, se devolvió estructura base (meta).",
    _no_itinerary_rows: true
  };
}

// Prompt base
const SYSTEM_PROMPT = `
Eres el planificador de viajes inteligente de ITravelByMyOwn (nivel concierge premium).
Tu misión: entender lenguaje natural y devolver SIEMPRE **JSON válido** (sin texto extra), siguiendo uno de estos formatos:

B) {"destination":"City","rows":[{"day":1,"start":"HH:MM","end":"HH:MM","activity":"Texto","from":"","to":"","transport":"","duration":"","notes":""}],"followup":"Texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"Texto breve"}
A) {"meta":{"city":"Nombre","baseDate":"DD/MM/YYYY","start":["HH:MM"],"end":"HH:MM","hotel":"Texto"},"followup":"Texto breve"}

⚠️ Prioriza SIEMPRE B o C si el usuario ha indicado destino(s), fechas u horarios, o ha solicitado generar o actualizar itinerarios.
Usa A SOLO cuando:
- El usuario aún no ha dado hotel/baseDate o
- Falta información clave y tu única opción es devolver meta.

Reglas:
- Si faltan datos de meta, asígnalos por defecto: baseDate = hoy, start = ["08:30"], end = "19:00", hotel="".
- Genera o ajusta itinerarios por días consecutivos desde baseDate. Llena huecos y evita duplicados.
- Incluye traslados realistas (transport, duration con buffer ~15%).
- Optimiza rutas y orden de actividades. Prioriza IMPERDIBLES emblemáticos e históricos; agrega sugerencias cercanas si hay tiempo.
- Respeta horario 08:30–19:00.
- Nada de markdown. SOLO JSON.
`.trim();

// Detecta si el último mensaje tiene señales claras de que se pidió un itinerario
function isItineraryRequest(messages = []) {
  if (!messages.length) return false;
  const last = messages[messages.length - 1].content?.toLowerCase() || "";
  return (
    last.includes("devuelve formato b") ||
    last.includes("destination") ||
    last.includes("perday") ||
    last.includes("itinerario") ||
    last.includes("rows")
  );
}

async function completeJSON(messages, options = {}) {
  const model = options.model || "gpt-4o-mini";
  const temperature = options.temperature ?? 0.4;

  const msgs = [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages.filter(m => m && m.role && m.content != null),
  ];

  const resp = await client.chat.completions.create({
    model,
    temperature,
    top_p: 0.9,
    messages: msgs,
    response_format: { type: "json_object" },
    max_tokens: 2200,
  });

  return resp.choices?.[0]?.message?.content?.trim() || "";
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body;
    const clientMessages = extractMessages(body);

    const itineraryMode = isItineraryRequest(clientMessages);

    // Primer intento
    let raw = await completeJSON(clientMessages, { model: body?.model || "gpt-4o-mini" });
    let parsed = cleanToJSON(raw);

    // Si es itinerario y no se obtuvo rows → segundo intento forzado
    if (itineraryMode && (!parsed || (!parsed.rows && !parsed.destinations))) {
      const strictMsgs = [
        { role: "system", content: SYSTEM_PROMPT + "\n🛑 Devuelve SOLO un objeto JSON válido en formato B o C con itinerario. Nada de meta si ya hay datos suficientes." },
        ...clientMessages,
      ];
      raw = await completeJSON(strictMsgs, { model: body?.model || "gpt-4o-mini", temperature: 0.3 });
      parsed = cleanToJSON(raw);
    }

    if (!parsed) parsed = fallbackJSON();

    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (error) {
    console.error("Error en /api/chat.js:", error);
    return res.status(500).json({
      error: "Error interno del servidor. Verifica la configuración del modelo o tu API Key.",
    });
  }
}
