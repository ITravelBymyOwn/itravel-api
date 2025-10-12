// /api/chat.js — CORRECCIÓN v28 (Fuerza Máxima)

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
  // Se asegura que el mensaje del usuario sea el último (si no viene en messages)
  if(prev.length === 0 || prev[prev.length - 1].content !== userText){
      return [...prev, { role: "user", content: userText }];
  }
  return prev;
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
function fallbackJSON(message) {
  return {
    meta: {
      city: "Error",
      baseDate: new Date().toLocaleDateString("es-ES"),
      hotel: "No generado",
    },
    followup: message || "Error grave al generar itinerario. Revisa el log de Vercel.",
    _no_itinerary_rows: true,
  };
}

// ==============================
// Prompt de sistema BASE
// ==============================
const SYSTEM_PROMPT_BASE = `
Eres el planificador de viajes inteligente de ITravelByMyOwn.
Tu **ÚNICA** tarea es devolver un **JSON VÁLIDO** en uno de los siguientes formatos.
**NO incluyas NADA de texto o formato (ej. \`\`\`json) fuera del objeto JSON final.**
`.trim();

// ==============================
// Formatos (para el prompt de Retry)
// ==============================
const FORMAT_ROWS = `
**FORMATO OBLIGATORIO (Para Generación/Edición):**
B) {"destination":"City","rows":[{"day":1,"start":"HH:MM","end":"HH:MM","activity":"Texto","from":"","to":"","transport":"","duration":"","notes":""}],"followup":"Texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"Texto breve"}
`.trim();

const FORMAT_META = `
**FORMATO OPCIONAL (Solo para recopilar datos de Hotel):**
A) {"meta":{"city":"Nombre","baseDate":"DD/MM/YYYY","start":["HH:MM"],"end":"HH:MM","hotel":"Texto"},"followup":"Texto breve"}
`.trim();

// ==============================
// Petición al modelo
// ==============================
async function completeJSON(messages, options = {}) {
  const model = options.model || "gpt-4o-mini"; 
  const temperature = options.temperature ?? 0.4;
  const systemContent = options.systemContent || SYSTEM_PROMPT_BASE + "\n" + FORMAT_ROWS + "\n" + FORMAT_META;

  const msgs = [
    { role: "system", content: systemContent },
    // Filtro para asegurar que solo haya mensajes válidos
    ...messages.filter(m => m && m.role && m.content != null), 
  ];
  
  console.log("📝 MENSAJES ENVIADOS:", JSON.stringify(msgs, null, 2));

  const resp = await client.chat.completions.create({
    model,
    temperature,
    top_p: 0.9,
    messages: msgs,
    response_format: { type: "json_object" },
    max_tokens: 2500,
  });

  const raw = resp.choices?.[0]?.message?.content?.trim() || "";
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

    // 1. Primer intento
    let raw = await completeJSON(clientMessages, { model: body?.model || "gpt-4o-mini" });
    let parsed = cleanToJSON(raw);

    // 2. Comprobar si se obtuvo un itinerario (rows/destinations)
    const hasItineraryRows = parsed && (parsed.rows || parsed.destinations);
    const isInitialRequest = clientMessages.some(m => m.content.includes("INICIO DE PLANIFICACIÓN"));
    
    // 3. Segundo intento AGRESIVO: Si es la solicitud inicial o de edición y falló el formato B/C.
    if (!hasItineraryRows) {
        
      const strictSystemPrompt = SYSTEM_PROMPT_BASE + `
**INSTRUCCIÓN CRÍTICA:**
DEBES devolver el itinerario en formato B o C. El usuario espera una tabla de actividades.
NO uses el formato A ("meta"). NO DEBÉS preguntarle al usuario. 
TU ÚNICA TAREA ES DEVOLVER EL JSON CON 'rows'.

${FORMAT_ROWS}
`.trim();

      // Forzamos la baja temperatura para un output estructurado
      raw = await completeJSON(clientMessages, { 
          model: body?.model || "gpt-4o-mini", 
          temperature: 0.1,
          systemContent: strictSystemPrompt 
      });
      parsed = cleanToJSON(raw);
    }

    if (!parsed) parsed = fallbackJSON("El agente no pudo generar un JSON válido de itinerario, incluso después de un reintento estricto.");

    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (error) {
    console.error("❌ Error en /api/chat.js:", error);
    return res.status(500).json({
      error: "Error interno del servidor. Verifica la configuración del modelo o tu API Key.",
    });
  }
}
