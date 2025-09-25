// /api/chat.js
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { input } = req.body;

    if (!input) {
      return res.status(400).json({ error: "No input provided" });
    }

    // Llamada a OpenAI con el endpoint Responses
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5-mini",   // Usa un modelo estable
        input: input,
      }),
    });

    const data = await response.json();

    console.log("DEBUG OpenAI response:", data);

    // Manejo de errores en caso de que OpenAI devuelva algo raro
    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    // ✅ La nueva API devuelve `output_text` directamente
    const output = data.output_text || "No response from model";

    return res.status(200).json({ text: output });
  } catch (error) {
    console.error("Server error:", error);
    return res.status(500).json({ error: "Server error", detail: error.message });
  }
}

