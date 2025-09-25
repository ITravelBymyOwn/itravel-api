// /api/chat.js
export default async function handler(req, res) {
  // CORS para Webflow
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
    // === 1) Normalizamos entrada: text / input / messages ===
    const { text, input, messages } = req.body || {};
    let prompt = text || input || "";

    if (!prompt && Array.isArray(messages) && messages.length > 0) {
      const lastUserMsg =
        [...messages].reverse().find((m) => m.role === "user")?.content || "";

      const history = messages
        .map((m) => {
          const role = m.role === "user" ? "Usuario" : "Asistente";
          return `${role}: ${m.content}`;
        })
        .join("\n");

      // Rol del sistema robusto
      const systemRole = `
Eres "ITravelByMyOwn", un asistente de viajes experto, flexible y conversacional.
Tu comportamiento debe imitar al chat de OpenAI (ChatGPT) con memoria e interacción dinámica.

PRINCIPIOS:
- Si el usuario no indica la hora de inicio, pregúntala antes de dar un itinerario detallado.
- Si luego da una hora específica o pide cambios, AJUSTA el itinerario en consecuencia.
- Mantén contexto y coherencia: recuerda lo que se habló en el historial.
- Si cambia de tema, sigue el nuevo hilo sin perder naturalidad.
- A futuro podrás consultar datos externos (Google Maps, clima, transporte). Simula esa integración con estimaciones claras.
- Cuando no tengas datos exactos, indica que es aproximado.

FORMATO DE RESPUESTA (Markdown simple, claro y accionable):
- **Título corto** del plan.
- Para itinerarios:
  ---
  **Día X**  
  **Mañana**
  ✅ Punto clave 1 – breve descripción  
  ✅ Punto clave 2 – breve descripción  
  ⏱️ Traslado (~tiempo estimado)
  **Tarde**
  ✅ ...
  **Noche**
  ✅ ...
  ---
- Usa checkmarks ✅, negritas, bullets, y marca traslados ⏱️.
- Si faltan datos clave (ej. hora de inicio, ritmo, transporte), **pregunta antes de asumir**.
- Termina con sección **Opciones y Ajustes** con 2–3 alternativas.

Objetivo: respuestas claras, estructuradas, fáciles de seguir en móvil.
      `.trim();

      // Prompt final
      prompt = `
${systemRole}

HISTORIAL RECIENTE:
${history}

INSTRUCCIÓN ACTUAL (del usuario):
${lastUserMsg}

Entrega una respuesta bien estructurada, interactiva y siguiendo el formato pedido.
      `.trim();
    }

    if (!prompt) {
      return res
        .status(400)
        .json({ error: "Falta el parámetro 'text' o 'input' o 'messages'" });
    }

    // === 2) Llamada a OpenAI Responses API ===
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: prompt,
        temperature: 0.8, // un poco más creativo/flexible
        max_output_tokens: 1400, // más espacio para itinerarios largos
      }),
    });

    const data = await response.json();

    // === 3) Extraer texto de forma robusta ===
    let reply = "(Sin respuesta del modelo)";
    if (data?.output && Array.isArray(data.output) && data.output.length > 0) {
      const content = data.output[0]?.content;
      if (Array.isArray(content) && content.length > 0) {
        reply = content[0]?.text || reply;
      }
    }
    if (reply === "(Sin respuesta del modelo)" && typeof data?.output_text === "string") {
      reply = data.output_text;
    }
    if (data?.error && data.error.message) {
      reply = `⚠️ Error del modelo: ${data.error.message}`;
    }

    // === 4) Responder al frontend ===
    return res.status(200).json({ text: reply, raw: data });
  } catch (error) {
    console.error("Error en /api/chat:", error);
    return res.status(500).json({
      error: "Error interno del servidor",
      detail: error.message,
    });
  }
}

