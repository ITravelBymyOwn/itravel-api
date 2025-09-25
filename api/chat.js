// /api/chat.js
export default async function handler(req, res) {
  // CORS para Webflow
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
    // === 1) Normalizamos entrada: text / input / messages ===
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

      const systemRole = `
Eres "ITravelByMyOwn", un asistente de viajes experto, conciso, proactivo y amigable. 
Tu misión es crear y ajustar itinerarios claros, accionables y fáciles de leer en móvil.

REGLAS:
- Siempre responde con formato checklist ✅ y secciones **Día, Mañana, Tarde, Noche**.
- Usa negritas para títulos y ⏱️ para traslados con tiempos aproximados.
- Si el usuario **NO especifica horas de inicio**, **no inventes horarios**:
  → primero pregunta: "¿A qué hora deseas comenzar el recorrido cada día?".
- Si el usuario da horas, organízalas de manera lógica y consistente.
- Añade al final una sección **Opciones y Ajustes** con 2–3 alternativas.
- Cuando el usuario cambie tema, sigue el nuevo hilo con coherencia.
- Prepárate para integrar datos externos (Google Maps, clima, transporte).
      `.trim();

      prompt = `
${systemRole}

HISTORIAL RECIENTE:
${history}

INSTRUCCIÓN ACTUAL (del usuario):
${lastUserMsg}

Entrega la respuesta en formato estructurado y checklist limpio, siguiendo las reglas.
      `.trim();
    }

    if (!prompt) {
      return res
        .status(400)
        .json({ error: "Falta el parámetro 'text' o 'input' o 'messages'" });
    }

    // === 2) Llamada al API de OpenAI (Responses) ===
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
        max_output_tokens: 1200,
      }),
    });

    const data = await response.json();

    // === 3) Extraemos texto de forma robusta ===
    let reply = "(Sin respuesta del modelo)";
    if (data?.output && Array.isArray(data.output) && data.output.length > 0) {
      const content = data.output[0]?.content;
      if (Array.isArray(content) && content.length > 0) {
        reply = content[0]?.text || reply;
      }
    }
    if (
      reply === "(Sin respuesta del modelo)" &&
      typeof data?.output_text === "string"
    ) {
      reply = data.output_text;
    }
    if (data?.error && data.error.message) {
      reply = `⚠️ Error del modelo: ${data.error.message}`;
    }

    // === 4) Respuesta al frontend ===
    return res.status(200).json({ text: reply, raw: data });
  } catch (error) {
    console.error("Error en /api/chat:", error);
    return res.status(500).json({
      error: "Error interno del servidor",
      detail: error.message,
    });
  }
}

