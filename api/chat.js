// /api/chat.js

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { input, messages, systemPrompt } = req.body || {};

    if (!input && !messages) {
      return res.status(400).json({ error: "No input provided" });
    }

    // Construimos el payload de "input": puede ser string o array de mensajes
    const payloadInput = Array.isArray(messages) && messages.length
      ? [
          { role: "system", content: systemPrompt || "Eres un asistente de viajes." },
          ...messages,
        ]
      : (typeof input === "string" ? input : JSON.stringify(input));

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5-nano",
        input: payloadInput,
        max_output_tokens: 500,
      }),
    });

    const data = await resp.json();

    // Log de diagnóstico (se ve en Vercel → Logs)
    console.log("DEBUG OpenAI response:", JSON.stringify(data));

    const text = extractText(data);

    if (!text) {
      // Devolvemos el crudo para depurar, pero con un mensaje claro
      return res
        .status(200)
        .json({ text: "(Sin respuesta del modelo)", raw: data });
    }

    return res.status(200).json({ text });
  } catch (err) {
    console.error("Handler error:", err);
    return res
      .status(500)
      .json({ error: "Server error", detail: String(err?.message || err) });
  }
}

/**
 * Extrae el texto de todas las formas posibles que puede devolver la Responses API.
 */
function extractText(data) {
  if (!data) return null;

  // 1) Campo de conveniencia habitual
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  // 2) Array "output" → items type:"message" → content[] con type:"output_text"|"text"
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item?.type === "message" && Array.isArray(item.content)) {
        const chunk = item.content.find(
          (c) => (c.type === "output_text" || c.type === "text") && c.text
        );
        if (chunk?.text) return chunk.text;
      }
    }
  }

  // 3) Algunos payloads traen "content" en la raíz
  if (Array.isArray(data.content)) {
    const chunk = data.content.find(
      (c) => (c.type === "output_text" || c.type === "text") && c.text
    );
    if (chunk?.text) return chunk.text;
  }

  // 4) Compatibilidad con Chat/Completions antiguos (por si acaso)
  if (Array.isArray(data.choices)) {
    const parts = data.choices
      .map((c) => c.message?.content || c.text)
      .filter(Boolean);
    if (parts.length) return parts.join("\n");
  }

  return null;
}

