// /api/chat.js

export default async function handler(req, res) {
  // CORS
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
    const { text, input } = req.body;
    const prompt = text || input;

    if (!prompt) {
      return res.status(400).json({ error: "Falta el parámetro 'text' o 'input'" });
    }

    // Pedimos al modelo que genere directamente HTML limpio y estructurado
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: `
          Responde a la siguiente petición con un itinerario o plan,
          pero genera la salida en HTML limpio, con este formato:

          - Usa <h3> para los títulos de días (Día 1, Día 2, etc).
          - Usa <ul><li> para listar actividades con horarios.
          - Usa <strong> para resaltar los nombres de lugares o actividades.
          - Mantén el estilo tipo checklist detallado, fácil de leer.

          Petición del usuario:
          ${prompt}
        `,
        max_output_tokens: 1200,
      }),
    });

    const data = await response.json();

    let reply = "(Sin respuesta del modelo)";
    if (data?.output && Array.isArray(data.output) && data.output.length > 0) {
      const content = data.output[0]?.content;
      if (Array.isArray(content) && content.length > 0) {
        reply = content[0]?.text || reply;
      }
    }

    return res.status(200).json({ html: reply });
  } catch (error) {
    console.error("Error en /api/chat:", error);
    return res.status(500).json({
      error: "Error interno del servidor",
      detail: error.message,
    });
  }
}

