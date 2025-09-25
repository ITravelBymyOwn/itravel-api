export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { messages } = req.body;

    const systemPrompt = `
    Eres un asistente especializado en crear itinerarios de viaje personalizados.
    Responde siempre en el mismo idioma que use el usuario.
    `;

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5-nano",
        input: [
          { role: "system", content: systemPrompt },
          ...messages,
        ],
        store: false,
      }),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      return res.status(resp.status).json({
        error: "OpenAI error",
        detail: txt,
      });
    }

    const data = await resp.json();

    // ✅ Corrección: extraemos la respuesta con la nueva estructura
    const text = data.output?.[0]?.content?.[0]?.text || "(Sin respuesta)";

    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      detail: err.message,
    });
  }
}

