// /api/chat.js — CORRECCIÓN v26 para robustez de itinerarios

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ==============================
// Extrae mensajes desde body (sin cambios)
// ==============================
function extractMessages(body = {}) {
// ... (código sin cambios)
}

// ==============================
// Limpia y parsea JSON (sin cambios)
// ==============================
function cleanToJSON(raw = "") {
// ... (código sin cambios)
}

// ==============================
// Fallback mínimo (sin cambios)
// ==============================
function fallbackJSON() {
// ... (código sin cambios)
}

// ==============================
// Prompt de sistema (MEJORADO)
// ==============================
const SYSTEM_PROMPT = `
Eres el planificador de viajes inteligente de ITravelByMyOwn (nivel concierge premium).
Tu ÚNICA TAREA es devolver un **JSON VÁLIDO** y utilizable por el frontend.

**FORMATOS DE RESPUESTA ACEPTADOS (SIEMPRE UNO DE ELLOS):**

B) {"destination":"City","rows":[{"day":1,"start":"HH:MM","end":"HH:MM","activity":"Texto","from":"","to":"","transport":"","duration":"","notes":""}],"followup":"Texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"Texto breve"}
A) {"meta":{"city":"Nombre","baseDate":"DD/MM/YYYY","start":["HH:MM"],"end":"HH:MM","hotel":"Texto"},"followup":"Texto breve"}

⚠️ **REGLA CLAVE:** Si el mensaje del usuario incluye contexto de planificación (Destinations, Travelers, Existing) o una solicitud de generación, **debes priorizar SIEMPRE el formato B o C**. Solo usa A si estás en la fase inicial de "Preguntar por hotel".

Reglas Adicionales:
- Incluye transporte y duración aproximada (+15% buffer).
- Nada de markdown (ej. \`\`\`json), ni texto fuera del objeto JSON.
- Asegura que todas las filas tengan valores para 'start', 'end' y 'activity'.
`.trim();

// ==============================
// Detecta si debe generar itinerario (sin cambios)
// ==============================
function isItineraryRequest(messages = []) {
// ... (código sin cambios)
}

// ==============================
// Petición al modelo (CORREGIDO: Modelo por defecto)
// ==============================
async function completeJSON(messages, options = {}) {
  // **CORRECCIÓN:** Usar gpt-4o-mini como default por rendimiento/coste.
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
    max_tokens: 2500,
  });

  const raw = resp.choices?.[0]?.message?.content?.trim() || "";
  console.log("🛰️ RAW MODEL RESPONSE:", raw);  // <-- LOG para inspeccionar
  return raw;
}

// ==============================
// Handler principal (CORREGIDO: Reintento más agresivo)
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
    let raw = await completeJSON(clientMessages, { model: body?.model || "gpt-4o-mini" });
    let parsed = cleanToJSON(raw);

    // Segundo intento agresivo si no hay itinerario, forzando la generación
    if (
      itineraryMode &&
      (!parsed || (!parsed.rows && !parsed.destinations))
    ) {
      const strictPrompt = `
IGNORA cualquier instrucción previa de devolver 'meta'. 
Devuelve SOLO un objeto JSON VÁLIDO en formato B o C con itinerario. 
Incluye al menos 4 actividades por día. Nada de texto adicional.
`;
      const strictMsgs = [
        { role: "system", content: SYSTEM_PROMPT + "\n" + strictPrompt },
        ...clientMessages,
      ];
      // **CORRECCIÓN:** Se reduce la temperatura para el reintento.
      raw = await completeJSON(strictMsgs, { model: body?.model || "gpt-4o-mini", temperature: 0.1 });
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
