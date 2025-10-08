// /api/chat.js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Invalid request format" });
    }

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content: `Eres el planificador de viajes inteligente de la plataforma ITravelByMyOwn.
          Tu objetivo es crear un itinerario personalizado, estructurado y claro.
          - Primero verifica si el usuario ha indicado: destino, días de estancia y orden de visita.
          - Si falta alguno, pregunta solo por lo que falta (no repitas todo).
          - Una vez tengas esos datos, genera el itinerario en formato checklist estructurado, con:
            ✅ Día X: [Título]
            - Actividades con horarios aproximados
            - Recomendaciones (restaurantes, descanso, transporte, etc.)
          - Siempre responde en español, salvo que el usuario hable en otro idioma.
          - Mantén tono empático, viajero y profesional.
          - Si el usuario menciona varias ciudades, confirma el orden antes de continuar.
          - Cuando termines una ciudad, pregunta si desea añadir otra o exportar a PDF.`
        },
        ...messages,
      ],
    });

    const content = response.choices[0]?.message?.content?.trim() || "No se pudo generar respuesta.";
    res.status(200).json({ reply: content });
  } catch (error) {
    console.error("Error en /api/chat.js:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
}
