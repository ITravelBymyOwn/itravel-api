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
        model: "gpt-5-mini", // usa mini en vez de nano (más estable)
        input: input,
      }),
    });

    const data = await response.json();
    console.log("DEBUG OpenAI response:", JSON.stringify(data, null, 2));

    // Verifica si existe output[0].content[0].text
    let text = "No response from model";
    if (
      data.output &&
      data.output[0] &&
      data.output[0].content &&
      data.output[0].content[0] &&
      data.output[0].content[0].text
    ) {
      text = data.output[0].content[0].text;
    }

    return res.status(200).json({ text });
  } catch (error) {
    console.error("Handler error:", error);
    return res.status(500).json({
      error: "Server error",
      detail: error.message,
    });
  }
}

