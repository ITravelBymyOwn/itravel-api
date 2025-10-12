// /api/chat.js — v27 (Structured Output + triple reintento sobre v26)
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ==============================
// Extrae mensajes desde body (sin cambios)
// ==============================
function extractMessages(body = {}) {
  const { messages, input, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;
  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";
  return [...prev, { role: "user", content: userText }];
}

// ==============================
// Limpia y parsea JSON (sin cambios)
// ==============================
function cleanToJSON(raw = "") {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    const m1 = raw.match(/```json\s*([\s\S]*?)```/i) || raw.match(/```([\s\S]*?)```/i);
    if (m1 && m1[1]) {
      try {
        return JSON.parse(m1[1]);
      } catch {}
    }
    const m2 = raw.match(/<json>\s*([\s\S]*?)\s*<\/json>/i);
    if (m2 && m2[1]) {
      try {
        return JSON.parse(m2[1]);
      } catch {}
    }
    try {
      const cleaned = raw.replace(/^[^\{]+/, "").replace(/[^\}]+$/, "");
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }
}

// ==============================
// Fallback mínimo (sin cambios)
// ==============================
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
        notes: "",
      },
    ],
    followup: "Hubo un error al generar el itinerario. Ajusta y vuelve a intentar.",
  };
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

⚠️ **REGLA CLAVE:** Si el mensaje incluye contexto de planificación o una solicitud de generación, **debes priorizar SIEMPRE el formato B o C**. Solo usa A si estás en la fase de "preguntar por hotel".

Reglas adicionales:
- Incluye transporte y duración (+15% buffer).
- Nada de markdown ni texto fuera del JSON.
- Asegura que todas las filas tengan start, end y activity.
`.trim();

// ==============================
// Detecta si debe generar itinerario (sin cambios)
// ==============================
function isItineraryRequest(messages = []) {
  const joined = messages.map(m => m.content || "").join(" ").toLowerCase();
  return joined.includes("destination") || joined.includes("itinerary") || joined.includes("itinerario");
}

// ==============================
// Definición de esquema estricto para Structured Output
// ==============================
const Row = {
  type: "object",
  required: ["day", "start", "end", "activity"],
  properties: {
    day: { type: "integer", minimum: 1 },
    start: { type: "string" },
    end: { type: "string" },
    activity: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    transport: { type: "string" },
    duration: { type: "string" },
    notes: { type: "string" },
  },
  additionalProperties: false,
};

const SingleCity = {
  type: "object",
  required: ["destination", "rows"],
  properties: {
    destination: { type: "string" },
    rows: { type: "array", items: Row, minItems: 1 },
    followup: { type: "string" },
  },
  additionalProperties: false,
};

const MultiCity = {
  type: "object",
  required: ["destinations"],
  properties: {
    destinations: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["name", "rows"],
        properties: {
          name: { type: "string" },
          rows: { type: "array", items: Row, minItems: 1 },
        },
      },
    },
    followup: { type: "string" },
  },
  additionalProperties: false,
};

const ItinerarySchema = {
  name: "itinerary_response",
  schema: {
    type: "object",
    anyOf: [SingleCity, MultiCity],
    additionalProperties: false,
  },
  strict: true,
};

// ==============================
// Petición al modelo (CAMBIADA)
// ==============================
async function completeJSON(messages, options = {}) {
  const model = options.model || "gpt-4o-mini";
  const temperature = options.temperature ?? 0.4;

  const resp = await client.responses.create({
    model,
    temperature,
    response_format: {
      type: "json_schema",
      json_schema: ItinerarySchema,
    },
    input: messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
    max_output_tokens: 2200,
  });

  const raw = resp?.output_text?.trim() || "";
  console.log("🛰️ RAW STRUCTURED RESPONSE:", raw);
  return raw;
}

// ==============================
// Handler principal (REINTENTO TRIPLE)
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body;
    const clientMessages = extractMessages(body);
    const itineraryMode = isItineraryRequest(clientMessages);
    const model = body?.model || "gpt-4o-mini";

    // 1) Primer intento normal
    let raw = await completeJSON([{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages], { model });
    let parsed = cleanToJSON(raw);

    // 2) Segundo intento si no hay rows
    const hasRows = parsed && (parsed.rows || parsed.destinations);
    if (itineraryMode && !hasRows) {
      const strictPrompt = `
OBLIGATORIO: Devuelve al menos 1 fila en "rows". 
Prohibido devolver solo meta. 
Nada de texto adicional.
`;
      const strictMsgs = [
        { role: "system", content: SYSTEM_PROMPT + "\n" + strictPrompt },
        ...clientMessages,
      ];
      raw = await completeJSON(strictMsgs, { model, temperature: 0.25 });
      parsed = cleanToJSON(raw);
    }

    // 3) Tercer intento ultra estricto
    const stillNoRows = !parsed || (!parsed.rows && !parsed.destinations);
    if (itineraryMode && stillNoRows) {
      const ultraPrompt = `
Ejemplo válido:
{"destination":"City","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":""}]}
OBLIGATORIO: Entrega algo así para la ciudad correspondiente.
`;
      const ultraMsgs = [
        { role: "system", content: SYSTEM_PROMPT + "\n" + ultraPrompt },
        ...clientMessages,
      ];
      raw = await completeJSON(ultraMsgs, { model, temperature: 0.1 });
      parsed = cleanToJSON(raw);
    }

    if (!parsed) parsed = fallbackJSON();

    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (error) {
    console.error("❌ Error en /api/chat.js:", error);
    return res.status(500).json({
      error: "Error interno del servidor. Verifica la configuración del modelo o tu API Key.",
    });
  }
}
