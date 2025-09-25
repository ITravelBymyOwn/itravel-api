// api/chat.js
export default async function handler(req, res) {
  try {
    // CORS básico para poder llamar desde Webflow
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.status(200).end();

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const apiKey = process.env.OPENAI_API_KEY; // <- tu clave estará segura en Vercel
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    // Cuerpo: { messages: [{ role: "user"|"assistant"|"system", content: "texto" }] }
    // Si vienes solo con texto plano, lo convierto a messages:
    let messages = [];
    try {
      const body = req.body || {};
      if (body.messages && Array.isArray(body.messages)) {
        messages = body.messages;
      } else if (body.text) {
        messages = [{ role: "user", content: String(body.text).slice(0, 2000) }];
      }
    } catch (_) {
      messages = [];
    }

    const systemPrompt = `
Eres un planificador de viajes para ITravelByMyOwn.
Pide los datos faltantes de forma breve. Devuelve itinerarios por día (Día 1, Día 2...),
incluye tiempos aproximados de traslado, recomendaciones de transporte (metro/bus/auto),
rutas lógicas, notas de accesibilidad, opciones con niños o adultos mayores.
Si piden metro: indica línea, paradas y salida. No inventes precios en tiempo real.
Responde en el idioma del usuario.
    `.trim();

    // Llamada a OpenAI Responses API (modelo liviano para MVP)
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5-nano",
        input: [
          { role: "system", content: systemPrompt },
          ...messages
        ],
        store: false
      })
    });

    if (!resp.ok) {
      const txt = await resp.text();
      return res.status(resp.status).json({ error: "OpenAI error", detail: txt });
    }

    const data = await resp.json();
    const text = data.output_text || "(Sin respuesta)";
    return res.status(200).json({ text });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
