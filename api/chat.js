// /api/chat.js
export default async function handler(req, res) {
  try {
    const { input } = req.body;

    // Llamada a OpenAI
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5-nano",
        input: `
Eres el planificador de viajes de ITravelByMyOwn. 
Reglas:
1. El itinerario SIEMPRE debe estar en formato JSON válido bajo la clave "plan".
2. El JSON debe tener este formato exacto:
[
  {"day":1,"start":"09:00","end":"11:00","activity":"...","from":"...","to":"...","transport":"...","duration":"...","notes":"..."}
]
3. Además debes generar un texto corto y natural para interacción con el usuario, bajo la clave "reply".
Ejemplo de salida:
{
 "reply": "He creado un itinerario inicial de 2 días. ¿Quieres que lo ajuste?",
 "plan": [...]
}

Ahora, genera respuesta para: ${input}
        `
      })
    });

    const data = await response.json();

    // Extraemos texto del modelo
    let raw = data.output_text || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = { reply: raw, plan: [] };
    }

    res.status(200).json({
      success: true,
      reply: parsed.reply || "Aquí tienes tu itinerario inicial.",
      plan: parsed.plan || []
    });
  } catch (err) {
    console.error("Error en /api/chat:", err);
    res.status(500).json({ success: false, error: err.message });
  }
}
