// /api/chat.js
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  setCORS(res);

  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { input } = req.body || {};
    if (!input || typeof input !== "string") {
      return res.status(400).json({ error: "No input provided" });
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini-2025-04-14",
        input,
        temperature: 0.7,
        max_output_tokens: 1200, // más margen que antes
        store: false,
      }),
    });

    const data = await response.json();

    // Text robusto: cubre tanto output_text como estructuras por "content"
    let text = data.output_text || "";

    if (!text && Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item?.type === "message" && Array.isArray(item.content)) {
          const piece = item.content
            .map(c => (typeof c.text === "string" ? c.text : ""))
            .filter(Boolean)
            .join("\n");
          if (piece) { text = piece; break; }
        }
        if (item?.type === "output_text" && typeof item.text === "string") {
          text = item.text; break;
        }
        if (item?.type === "reasoning" && Array.isArray(item.summary) && item.summary.length) {
          text = item.summary.join("\n"); break;
        }
      }
    }

    // Si el modelo se quedó corto por límite de tokens, avisa
    if (data?.status === "incomplete" && data?.incomplete_details?.reason === "max_output_tokens") {
      text = (text ? text + "\n\n" : "") + "⚠️ Respuesta truncada por límite de tokens.";
    }

    return res.status(200).json({
      text: text || "(Sin respuesta del modelo)",
      // Para depurar, comenta la línea de abajo si no quieres devolver el raw:
      // raw: data,
    });

  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "Server error", detail: String(err?.message || err) });
  }
}
