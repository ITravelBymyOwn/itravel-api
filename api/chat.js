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

    const { input, history } = req.body || {};
    const userText = input || "";
    const prevMessages = Array.isArray(history)
      ? history
      : [];

    // === SYSTEM PROMPT ===
    const systemPrompt = `
Eres el planificador de viajes inteligente de la plataforma ITravelByMyOwn.
Tu propósito es entender el lenguaje natural, incluso cuando el usuario no sigue un formato específico.

🎯 FUNCIONES PRINCIPALES:
1. Extraer o inferir información de meta:
   - Ciudad
   - Fecha de inicio
   - Horas de inicio y fin (una o varias)
   - Hotel, zona, dirección o coordenadas
   Si no se proporcionan, asume valores predeterminados:
   {"baseDate": "hoy", "start": ["08:30"], "end": "19:00", "hotel": ""}

2. Generar o actualizar itinerarios:
   - Devuelve actividades optimizadas, con transporte y duración estimada.
   - Si el usuario dice "no lo sé" o "ajústalo tú", genera una propuesta base.
   - Cada itinerario debe tener días consecutivos desde baseDate.

3. Mantén el tono cálido, profesional y humano. 
   - No pidas formatos.
   - Nunca detengas el flujo: si algo falta, supón o estima.

4. Responde SIEMPRE en JSON válido y sin texto adicional.

🎨 FORMATOS VÁLIDOS DE RESPUESTA (elige el que aplique):
A) {"meta":{"city":"Nombre","baseDate":"DD/MM/YYYY","start":["HH:MM"],"end":"HH:MM","hotel":"Texto"},"followup":"Texto breve"}
B) {"destination":"City","rows":[{"day":1,"start":"HH:MM","end":"HH:MM","activity":"Texto","from":"","to":"","transport":"","duration":"","notes":""}],"followup":"Texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"Texto breve"}
`.trim();

    // === CONSTRUCCIÓN DE MENSAJES ===
    const messages = [
      { role: "system", content: systemPrompt },
      ...prevMessages,
      { role: "user", content: userText },
    ];

    // === LLAMADA AL MODELO ===
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.5,
      messages,
    });

    const raw = response.choices[0]?.message?.content?.trim() || "";

    // === LIMPIEZA Y VALIDACIÓN DE JSON ===
    let clean = raw;
    if (/```json/i.test(raw)) {
      clean = raw.replace(/```json|```/gi, "").trim();
    } else if (raw.startsWith("```") && raw.endsWith("```")) {
      clean = raw.slice(3, -3).trim();
    }

    // Si no es JSON válido, crea uno por defecto para mantener flujo
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      parsed = {
        meta: {
          city: "Desconocido",
          baseDate: new Date().toLocaleDateString("es-ES"),
          start: ["08:30"],
          end: "19:00",
          hotel: "",
        },
        followup:
          "He generado una propuesta base para continuar. Puedes ajustar los horarios o actividades cuando quieras.",
      };
    }

    res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (error) {
    console.error("Error en /api/chat.js:", error);
    res.status(500).json({
      error: "Error interno del servidor. Verifica la configuración del modelo o tu API Key.",
    });
  }
}
