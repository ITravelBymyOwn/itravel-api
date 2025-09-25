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

    // 📌 Ruta correcta para extraer el texto
    let output = "No response from model";
    if (data.output && data.output.length > 0) {
      const firstMsg = data.output[0];
      if (firstMsg.content && firstMsg.content.length > 0) {
        output = firstMsg.content[0].text;
      }
    }

    return res.status(200).json({ text: output });
  } catch (error) {
    console.error("Server error:", error);
    return res
      .status(500)
      .json({ error: "Server error", detail: error.message });
  }
}

