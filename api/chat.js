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

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5-nano",
        input: input,
      }),
    });

    const data = await response.json();

    if (data.error) {
      return res.status(500).json({ error: "OpenAI error", detail: data.error });
    }

    // En Responses API la salida viene en output_text
    const text = data.output_text || "(Sin respuesta)";
    return res.status(200).json({ text });
  } catch (error) {
    return res.status(500).json({ error: "Server error", detail: error.message });
  }
}
