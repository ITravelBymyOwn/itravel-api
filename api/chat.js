// /api/chat.js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function extractMessages(body = {}) {
  const { messages, input, history } = body;

  // Si ya viene como messages[], úsalo tal cual
  if (Array.isArray(messages) && messages.length) {
    return messages;
  }

  // Compat: input + history[]
  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";

  return [...prev, { role: "user", content: userText }];
}

function cleanToJSON(raw = "") {
  let s = (raw || "").trim();
  if (!s) return null;

  // Bloques de ```json ... ```
  if (/```json/i.test(s)) {
    s = s.replace(/```json|```/gi, "").trim();
  } else if (s.startsWith("```") && s.endsWith("```")) {
    s = s.slice(3, -3).trim();
  }

  // Intento directo
  try { return JSON.parse(s); } catch(_) {}

  // Extrae primer objeto/array JSON dentro del texto
  const m = s.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (m) {
    try { return JSON.parse(m[1]); } catch(_) {}
  }

  return null;
}

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
      "He generado una propuesta base para continuar. Puedes ajustar actividades cuando quieras (horario 08:30–19:00).",
  };
}

const SYSTEM_PROMPT = `
Eres el planificador de viajes inteligente de ITravelByMyOwn (nivel concierge premium).
Tu misión: entender lenguaje natural y devolver SIEMPRE **JSON válido** (sin texto extra), siguiendo uno de estos formatos:

A) {"meta":{"city":"Nombre","baseDate":"DD/MM/YYYY","start":["HH:MM"],"end":"HH:MM","hotel":"Texto"},"followup":"Texto breve"}
B) {"destination":"City","rows":[{"day":1,"start":"HH:MM","end":"HH:MM","activity":"Texto","from":"","to":"","transport":"","duration":"","notes":""}],"followup":"Texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"Texto breve"}

Reglas:
- Si faltan datos de meta, asígnalos por defecto: baseDate = hoy, start = ["08:30"], end = "19:00", hotel="".
- Genera o ajusta itinerarios por **días consecutivos** desde baseDate. Llena huecos y evita duplicados.
- Incluye traslados realistas (transport, duration con buffer ~15%).
- Optimiza rutas y orden de actividades. Prioriza IMPERDIBLES emblemáticos e históricos; agrega sugerencias cercanas si hay tiempo.
- Respeta horario 08:30–19:00.
- Nada de markdown. SOLO JSON.
`.trim();

async function completeJSON(messages, options = {}) {
  const model = options.model || "gpt-4o-mini";
  const temperature = options.temperature ?? 0.4;

  // Asegura que el primer mensaje sea system
  const msgs = [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages.filter(m => m && m.role && m.content != null),
  ];

  const resp = await client.chat.completions.create({
    model,
    temperature,
    top_p: 0.9,
    messages: msgs,
    // Fuerza JSON puro
    response_format: { type: "json_object" },
    max_tokens: 1400,
  });

  const raw = resp.choices?.[0]?.message?.content?.trim() || "";
  return raw;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = await req.body;
    const clientMessages = extractMessages(body);

    // Primer intento
    let raw = await completeJSON(clientMessages, { model: body?.model || "gpt-4o-mini" });
    let parsed = cleanToJSON(raw);

    // Reintento estricto si no parsea
    if (!parsed) {
      const strictMsgs = [
        { role: "system", content: SYSTEM_PROMPT + "\nDevuelve SOLO un objeto JSON válido (A/B/C). Nada de texto adicional." },
        ...clientMessages,
      ];
      raw = await completeJSON(strictMsgs, { model: body?.model || "gpt-4o-mini", temperature: 0.3 });
      parsed = cleanToJSON(raw);
    }

    // Fallback definitivo
    if (!parsed) parsed = fallbackJSON();

    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (error) {
    console.error("Error en /api/chat.js:", error);
    return res.status(500).json({
      error: "Error interno del servidor. Verifica la configuración del modelo o tu API Key.",
    });
  }
}
