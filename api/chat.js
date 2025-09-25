// /api/chat.js

export default async function handler(req, res) {
  // Habilitar CORS para Webflow
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
    // Soportar tanto "text" como "input" en el body
    const { text, input } = req.body;
    const prompt = text || input;

    if (!prompt) {
      return res.status(400).json({ error: "Falta el parámetro 'text' o 'input'" });
    }

    // Llamada al API de OpenAI
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: `${prompt}\n\nPor favor responde en formato checklist estructurado, con viñetas claras y subtítulos (Mañana, Tarde, Noche). Usa saltos de línea para que sea fácil de leer.`,
        max_output_tokens: 1000,
      }),
    });

    const data = await response.json();

    // Log en consola Vercel
    console.log("OpenAI raw response:", data);

    // Extraer respuesta de forma segura
    let reply = "(Sin respuesta del modelo)";
    if (data?.output && Array.isArray(data.output) && data.output.length > 0) {
      const content = data.output[0]?.content;
      if (Array.isArray(content) && content.length > 0) {
        reply = content[0]?.text || reply;
      }
    }

    // Transformar respuesta a formato HTML básico (checklist bonito)
    const formattedReply = reply
      .replace(/^###\s*(.*$)/gim, "<h3>$1</h3>")       // Títulos
      .replace(/^##\s*(.*$)/gim, "<h2>$1</h2>")
      .replace(/^#\s*(.*$)/gim, "<h1>$1</h1>")
      .replace(/^\-\s(.*$)/gim, "✅ $1")                // Viñetas tipo checklist
      .replace(/\*\*(.*?)\*\*/gim, "<strong>$1</strong>") // Negritas
      .replace(/\n/g, "<br>");                         // Saltos de línea

    return res.status(200).json({ text: formattedReply, raw: data });
  } catch (error) {
    console.error("Error en /api/chat:", error);
    return res.status(500).json({
      error: "Error interno del servidor",
      detail: error.message,
    });
  }
}

