// /api/chat.js
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Acepta body como string o JSON
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const input =
      typeof body.input === "string" && body.input.trim()
        ? body.input.trim()
        : "";

    if (!input) {
      return res.status(400).json({ error: "No input provided" });
    }

    // Mensajes que enviamos al modelo
    const payloadInput = [
      {
        role: "system",
        content:
          "Eres un planificador de viajes. Responde SIEMPRE en el mismo idioma del usuario. Da itinerarios claros y accionables. No expliques tu razonamiento.",
      },
      { role: "user", content: input },
    ];

    // Llamada a OpenAI Responses API con más tokens + modelo que devuelve texto
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",       // Mejor para texto directo
        input: payloadInput,
        max_output_tokens: 2000,     // Subimos el límite
        temperature: 0.7,
        store: false,
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      return res.status(resp.status).json({ error: "OpenAI error", detail: data });
    }

    const text =
      extractTextFromResponses(data)?.trim() ||
      data.output_text?.trim() ||
      "(Sin respuesta del modelo)";

    // Si el modelo quedó incompleto por tokens, avisa en el texto
    if (
      data?.status === "incomplete" &&
      data?.incomplete_details?.reason === "max_output_tokens"
    ) {
      return res.status(200).json({
        text: `${text}\n\n(Nota: la respuesta fue truncada por límite de tokens. Si necesitas más detalle, te doy una versión extendida.)`,
        raw: data,
      });
    }

    return res.status(200).json({ text, raw: data });
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      detail: err?.message || String(err),
    });
  }
}

/** ----- Helpers para extraer texto de diferentes formas de respuesta ----- */
function extractTextFromResponses(data) {
  if (!data) return "";

  // Caso simple
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }

  // Formatos nuevos: data.output = [...items]
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      // Mensaje con contenido
      if (item?.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          const v = deepGetText(c);
          if (v) return v;
        }
      }
      // A veces reasoning o otras partes traen texto
      const v = deepGetText(item);
      if (v) return v;
    }
  }

  // Fallback: buscar texto en cualquier parte
  return deepGetText(data);
}

function deepGetText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;

  // { text: "..." } o { text: { value: "..." } }
  if (typeof node.text === "string") return node.text;
  if (node.text && typeof node.text.value === "string") return node.text.value;

  // content: [...]
  if (Array.isArray(node.content)) {
    for (const c of node.content) {
      const v = deepGetText(c);
      if (v) return v;
    }
  }

  // summary: [...]
  if (Array.isArray(node.summary)) {
    const v = node.summary.join("\n").trim();
    if (v) return v;
  }

  // value
  if (typeof node.value === "string") return node.value;

  return "";
}

