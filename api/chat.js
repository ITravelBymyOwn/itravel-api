// /api/chat.js — versión v25 con logging, prompt simplificado y reintento agresivo
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ==============================
// Extrae mensajes desde body
// ==============================
function extractMessages(body = {}) {
  const { messages, input, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;

  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";
  return [...prev, { role: "user", content: userText }];
}

// ==============================
// Limpia y parsea JSON
// ==============================
function cleanToJSON(raw = "") {
  let s = (raw || "").trim();
  if (!s) return null;

  if (/```json/i.test(s)) s = s.replace(/```json|```/gi, "").trim();
  else if (s.startsWith("```") && s.endsWith("```")) s = s.slice(3, -3).trim();

  try { return JSON.parse(s); } catch (_) {}

  const m = s.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (m) {
    try { return JSON.parse(m[1]); } catch (_) {}
  }

  return null;
}

// ==============================
// Fallback mínimo
// ==============================
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
    _no_itinerary_rows: true,
  };
}

// ==============================
// Prompt de sistema simplificado
// ==============================
const SYSTEM_PROMPT = `
Eres el planificador de viajes inteligente de ITravelByMyOwn (nivel concierge premium),
con la misma capacidad que ChatGPT para generar itinerarios reales.

Siempre responde con **JSON válido** en uno de estos formatos:

B) {"destination":"City","rows":[{"day":1,"start":"HH:MM","end":"HH:MM","activity":"Texto","from":"","to":"","transport":"","duration":"","notes":""}],"followup":"Texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"Texto breve"}
A) {"meta":{"city":"Nombre","baseDate":"DD/MM/YYYY","start":["HH:MM"],"end":"HH:MM","hotel":"Texto"},"followup":"Texto breve"}

⚠️ Prioriza SIEMPRE B o C si el usuario ha indicado destino(s), fechas u horarios.
Usa A solo si no hay información suficiente.

Reglas:
- Si hay horarios → respétalos exactamente.
- Si no hay horarios → usa 08:30–19:00.
- Genera itinerarios consecutivos desde baseDate.
- Incluye transporte y duración aproximada (+15% buffer).
- Nada de markdown, ni texto fuera del JSON.
`.trim();

// ==============================
// Detecta si debe generar itinerario
// ==============================
function isItineraryRequest(messages = []) {
  if (!messages.length) return false;
  const last = messages[messages.length - 1].content?.toLowerCase() || "";
  return (
    last.includes("itinerario") ||
    last.includes("rows") ||
    last.includes("destination") ||
    last.includes("generar") ||
    last.includes("plan")
  );
}

// ==============================
// Petición al modelo
// ==============================
async function completeJSON(messages, options = {}) {
  const model = options.model || "gpt-4o"; // se puede volver a gpt-4o-mini
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
    max_tokens: 2500,
  });

  const raw = resp.choices?.[0]?.message?.content?.trim() || "";
  console.log("🛰️ RAW MODEL RESPONSE:", raw);  // <-- LOG para inspeccionar
  return raw;
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
    const clientMessages = extractMessages(body);
    const itineraryMode = isItineraryRequest(clientMessages);

    // Primer intento
    let raw = await completeJSON(clientMessages, { model: body?.model || "gpt-4o" });
    let parsed = cleanToJSON(raw);

    // Segundo intento agresivo si no hay itinerario
    if (
      itineraryMode &&
      (!parsed || (!parsed.rows && !parsed.destinations))
    ) {
      const strictPrompt = `
Devuelve SOLO un objeto JSON válido en formato B o C con itinerario. 
Nada de meta ni texto adicional. Incluye actividades realistas para cada día.
`;
      const strictMsgs = [
        { role: "system", content: SYSTEM_PROMPT + "\n" + strictPrompt },
        ...clientMessages,
      ];
      raw = await completeJSON(strictMsgs, { model: body?.model || "gpt-4o", temperature: 0.3 });
      parsed = cleanToJSON(raw);
    }

    if (!parsed) parsed = fallbackJSON();

    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (error) {
    console.error("❌ Error en /api/chat.js:", error);
    return res.status(500).json({
      error:
        "Error interno del servidor. Verifica la configuración del modelo o tu API Key.",
    });
  }
}
