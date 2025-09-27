// /api/chat.js
export default async function handler(req, res) {
  // === CORS para Webflow ===
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  try {
    // === 1) Normalizamos entrada ===
    const { text, input, messages } = req.body || {};
    let prompt = text || input || "";

    if (!prompt && Array.isArray(messages) && messages.length > 0) {
      const lastUserMsg =
        [...messages].reverse().find((m) => m.role === "user")?.content || "";

      const history = messages
        .map((m) => {
          const role = m.role === "user" ? "Usuario" : "Asistente";
          return `${role}: ${m.content}`;
        })
        .join("\n");

      // Rol del sistema robusto
      const systemRole = `
Eres "ITravelByMyOwn", un asistente de viajes experto, flexible y conversacional.

PRINCIPIOS:
- Si el usuario no indica hora de inicio, pregúntala antes de dar un itinerario detallado.
- Mantén contexto con el historial y ajusta si el usuario cambia condiciones.
- Cuando no tengas datos exactos, indica que es aproximado.
- A futuro podrás conectarte a APIs externas (Google Maps, clima, transporte); simula con estimaciones claras.

FORMATO DE RESPUESTA:
1) Markdown conversacional (con títulos, checkmarks, bullets, traslados ⏱️).
2) Un bloque JSON estructurado con este esquema:
{
  "itinerario": [
    { "hora": "09:00", "actividad": "Visita al Louvre", "transporte": "Metro", "notas": "Comprar tickets online" }
  ],
  "transporte": [
    {
      "segmento": "París → Versalles",
      "opciones": [
        { "tipo": "tren", "duracion_min": 40, "precio": "€5" },
        { "tipo": "bus", "duracion_min": 60, "precio": "€3" }
      ],
      "recomendacion": "tren"
    }
  ]
}
3) Una tabla en HTML simple con el itinerario.
      `.trim();

      prompt = `
${systemRole}

HISTORIAL RECIENTE:
${history}

INSTRUCCIÓN ACTUAL:
${lastUserMsg}

Entrega siempre Markdown + JSON + Tabla HTML.
      `.trim();
    }

    if (!prompt) {
      return res
        .status(400)
        .json({ error: "Falta el parámetro 'text' o 'input' o 'messages'" });
    }

    // === 2) Llamada a OpenAI Responses API ===
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: prompt,
        temperature: 0.7,
        max_output_tokens: 1600,
      }),
    });

    const data = await response.json();

    // === 3) Extraer texto ===
    let reply = "(Sin respuesta del modelo)";
    if (data?.output && Array.isArray(data.output) && data.output.length > 0) {
      const content = data.output[0]?.content;
      if (Array.isArray(content) && content.length > 0) {
        reply = content[0]?.text || reply;
      }
    }
    if (reply === "(Sin respuesta del modelo)" && typeof data?.output_text === "string") {
      reply = data.output_text;
    }
    if (data?.error && data.error.message) {
      reply = `⚠️ Error del modelo: ${data.error.message}`;
    }

    // === 4) Respuesta ===
    return res.status(200).json({
      success: true,
      text: reply, // Markdown + JSON + Tabla HTML
      raw: data,   // Debug
    });
  } catch (error) {
    console.error("Error en /api/chat:", error);
    return res.status(500).json({
      error: "Error interno del servidor",
      detail: error.message,
    });
  }
}

