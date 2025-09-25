// /api/chat.js

export default async function handler(req, res) {
  // Habilitar CORS para que funcione desde Webflow u otros orígenes
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
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Falta el parámetro 'text'" });
    }

    // Llamada a OpenAI
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, // asegúrate de tener esta env var en Vercel
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: text,
        max_output_tokens: 1000,
      }),
    });

    const data = await response.json();

    // Depuración: log en consola de Vercel
    console.log("OpenAI raw response:", data);

    // Extraer respuesta de forma segura
    let reply = "(Sin respuesta del modelo)";
    if (data?.output && Array.isArray(data.output) && data.output.length > 0) {
      const content = data.output[0]?.content;
      if (Array.isArray(content) && content.length > 0) {
        reply = content[0]?.text || reply;
      }
    }

    return res.status(200).json({ text: reply, raw: data });
  } catch (error) {
    console.error("Error en /api/chat:", error);
    return res.status(500).json({
      error: "Error interno del servidor",
      detail: error.message,
    });
  }
}

