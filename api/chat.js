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
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({
        error: "Falta el parámetro 'messages' (array de historial)",
      });
    }

    // Inyectamos un system prompt robusto al inicio
    const systemPrompt = {
      role: "system",
      content:
        "Eres un asistente de viajes experto, interactivo y flexible. " +
        "Puedes crear itinerarios personalizados con horarios, tiempos estimados, distancias y checklist de actividades. " +
        "Respondes preguntas sobre transporte (avión, tren, metro, bus, auto), hospedaje, clima, cultura, seguridad y gastronomía. " +
        "Te adaptas a diferentes perfiles: viajeros solos, familias con niños, adultos mayores o personas con movilidad reducida. " +
        "Sugieres siempre opciones prácticas: baños, restaurantes, gasolineras, paradas estratégicas y rutas óptimas. " +
        "En el futuro podrás integrar datos en vivo (Google Maps, clima, APIs de transporte). " +
        "Responde siempre en HTML estructurado, con títulos, subtítulos, listas con ✔️ y pasos numerados. " +
        "Evita saludos innecesarios, entrega directamente la información clara y ordenada.",
    };

    // Reemplazar/inyectar system en caso de que no venga del cliente
    const fullMessages =
      messages[0]?.role === "system"
        ? messages
        : [systemPrompt, ...messages];

    // Llamada al API de OpenAI
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: fullMessages,
        max_output_tokens: 1500,
      }),
    });

    const data = await response.json();
    console.log("OpenAI raw response:", data);

    let reply = "(Sin respuesta del modelo)";
    if (data?.output?.[0]?.content?.[0]?.text) {
      reply = data.output[0].content[0].text;
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

