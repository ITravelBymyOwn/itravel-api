// /api/chat.js — versión flexible con interpretación natural
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
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: `
Eres el asistente inteligente de la plataforma ITravelByMyOwn.
Tu especialidad es interpretar lenguaje humano natural para generar o actualizar itinerarios de viaje.
Debes comprender frases informales como:
- "Llegaré el 20 de octubre del 2025 a las 7:30 am y me hospedaré cerca de la Sagrada Familia"
- "20/10/2025, 7, 8, 8 y media am, finalizando todos los días a las 7 de la noche, me quedaré en el Hotel Catalonia Ramblas"
- "Empiezo el 21/10/25 a las 9 am y termino a las 6 pm, dormiré en Eixample"

Tu tarea principal es **extraer información clave (meta)** para construir itinerarios:
Devuelve siempre JSON válido (sin texto adicional), con este formato exacto:
{
  "meta": {
    "city": "Nombre de la ciudad (en texto claro)",
    "baseDate": "DD/MM/YYYY",
    "start": ["HH:MM", ...] o "HH:MM",
    "end": "HH:MM",
    "hotel": "nombre o zona del alojamiento"
  },
  "followup": "mensaje breve si es necesario"
}

### Reglas de interpretación:
- Acepta tanto fechas numéricas ("20/10/2025") como textuales ("20 de octubre del 2025").
- Si se mencionan varias horas de inicio (7, 8, 8 y media), devuélvelas todas en formato ["07:00","08:00","08:30"].
- Si se omite “am/pm”, asume **mañana (am)** salvo que el texto diga “noche/tarde”.
- Si dice “finalizando todos los días a las 7 de la noche”, interpreta end = "19:00".
- Si se menciona “me hospedaré cerca de...” o “en el Hotel...”, extrae el texto como "hotel".
- Nunca inventes datos que no se mencionen; deja valores nulos si no existen.
- Nunca devuelvas texto fuera del JSON.

Ejemplo:
Entrada: "20 de octubre del 2025, 7:30 am, 8 y 8:30, finalizando todos los días a las 7 pm, me hospedaré en Hotel Catalonia Ramblas."
Salida:
{
  "meta": {
    "city": "Barcelona",
    "baseDate": "20/10/2025",
    "start": ["07:30","08:00","08:30"],
    "end": "19:00",
    "hotel": "Hotel Catalonia Ramblas"
  }
}
          `
        },
        ...messages,
      ],
    });

    const content = response.choices[0]?.message?.content?.trim() || "";
    res.status(200).json({ reply: content });
  } catch (error) {
    console.error("Error en /api/chat.js:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
}
