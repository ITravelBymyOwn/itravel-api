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

    // Si vienen messages, los convertimos a un historial legible.
    if (!prompt && Array.isArray(messages) && messages.length > 0) {
      // Tomamos el último mensaje del usuario como "pregunta actual"
      const lastUserMsg =
        [...messages].reverse().find((m) => m.role === "user")?.content || "";

      // Construimos contexto a partir del historial
      const history = messages
        .map((m) => {
          const role = m.role === "user" ? "Usuario" : "Asistente";
          return `${role}: ${m.content}`;
        })
        .join("\n");

      // Rol / Sistema (robusto y listo para futuras integraciones)
      const systemRole = `
Eres "ITravelByMyOwn", un asistente de viajes experto, conciso, proactivo y amigable.
Tu objetivo es crear y ajustar itinerarios inteligentes, claros y accionables.
- Siempre mantén el objetivo del usuario y respeta idioma y tono.
- Si el usuario da restricciones (p. ej. empezar a las 10:00, tiempos estimados), respétalas.
- Si el usuario cambia de tema, sigue el nuevo hilo con coherencia.
- A futuro podrás consultar fuentes externas (p.ej. Google Maps, APIs de transporte, clima, eventos).
  Cuando existan esas integraciones, sugiere y usa datos (duraciones, horarios, distancias).
- Cuando no tengas datos exactos, usa estimaciones razonables y marca que son aproximadas.

FORMATO DE RESPUESTA (Markdown simple):
- Título corto del plan o tema.
- Para itinerarios:
  ---
  **Día X**  
  **Mañana**
  ✅ Punto clave 1 (10:00–11:30) – breve descripción accionable
  ✅ Punto clave 2 (11:45–12:30) – breve descripción
  ⏱️ Traslado (~15 min a pie / ~8 min en metro)
  **Tarde**
  ✅ ...
  **Noche**
  ✅ ...
  ---
- Usa bullets, negritas y checkmarks ✅; marca traslados ⏱️ y tiempos estimados.
- Termina con una sección **Opciones y Ajustes** con 2–3 alternativas.
- Sé claro y legible en móvil. Evita párrafos largos.
      `.trim();

      // Prompt final combinando sistema + historial + instrucción actual
      prompt = `
${systemRole}

HISTORIAL RECIENTE:
${history}

INSTRUCCIÓN ACTUAL (del usuario):
${lastUserMsg}

Entrega una respuesta bien estructurada y legible, siguiendo el formato pedido.
      `.trim();
    }

    if (!prompt) {
      return res
        .status(400)
        .json({ error: "Falta el parámetro 'text' o 'input' o 'messages'" });
    }

    // === 2) Llamada al API de OpenAI (Responses) ===
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Usa tu clave de entorno en Vercel/GitHub
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: prompt,
        temperature: 0.7,
        max_output_tokens: 1200, // margen para itinerarios con detalle
      }),
    });

    const data = await response.json();

    // === 3) Extraemos texto de forma robusta ===
    let reply = "(Sin respuesta del modelo)";
    // a) Responses API: data.output[0].content[0].text
    if (data?.output && Array.isArray(data.output) && data.output.length > 0) {
      const content = data.output[0]?.content;
      if (Array.isArray(content) && content.length > 0) {
        reply = content[0]?.text || reply;
      }
    }
    // b) Algunas variantes devuelven data.output_text
    if (reply === "(Sin respuesta del modelo)" && typeof data?.output_text === "string") {
      reply = data.output_text;
    }
    // c) Fallback si vino un error del API
    if (data?.error && data.error.message) {
      reply = `⚠️ Error del modelo: ${data.error.message}`;
    }

    // === 4) Respuesta al frontend ===
    return res.status(200).json({ text: reply, raw: data });
  } catch (error) {
    console.error("Error en /api/chat:", error);
    return res.status(500).json({
      error: "Error interno del servidor",
      detail: error.message,
    });
  }
}

