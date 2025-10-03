// api/chat.js
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { intent, text = "", state = {}, model = "gpt-5-nano" } = req.body || {};

    // Prompt: pedimos JSON ESTRICTO con la estructura esperada
    const schemaExample = {
      assistant: "string (breve: resumen + siguiente pregunta para el usuario)",
      itinerary: {
        currency: "USD",
        days: [
          {
            day: 1,
            items: [
              {
                start: "09:00",
                end: "09:30",
                activity: "Transfer to Museum",
                from: "Hotel",
                to: "Museum of Art",
                transport: "Walk/Taxi/Metro/Bus/Car/Train/Ferry",
                durationMin: 30,
                notes: "Incluye 15% de contingencia",
                isTransfer: true
              }
            ]
          }
        ]
      }
    };

    const system = `
Eres un planificador de viajes. Devuelves SIEMPRE JSON válido y NADA fuera de JSON.
Estructura EXACTA:
${JSON.stringify(schemaExample, null, 2)}

Reglas:
- Incluye traslados (isTransfer=true) entre cada actividad, con duración y "+15% contingencia" en notes.
- La primera fila del día debe ser el traslado desde "Hotel" o "Alojamiento" hacia la primera actividad (si aplica).
- Al final del día, regresa al alojamiento salvo que el usuario lo pida distinto.
- Horas en formato 24h "HH:MM". Calcula "end" sumando "durationMin".
- En "assistant" escribe un resumen corto del plan generado o actualizado + una pregunta natural al usuario.
- Usa "currency" del estado si está disponible.
- Si falta info clave, genera la mejor suposición y pregunta en "assistant".
`;

    const user = `
INTENT: ${intent}
STATE (JSON): ${JSON.stringify(state)}
USER_TEXT: ${text}
`;

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        input: `SYSTEM:\n${system}\n\nUSER:\n${user}\n\nDevuelve SOLO el JSON.`,
      })
    });

    const data = await resp.json();

    // La Responses API trae utilidades; intentamos obtener texto
    const outText =
      data.output_text ||
      data.text ||
      (Array.isArray(data.output) ? data.output.map(o => o.content?.[0]?.text?.value || "").join("\n") : "") ||
      JSON.stringify(data);

    // Intentar parsear JSON puro o desde bloque ```json
    const parsed = safeParseJson(outText);

    // Si no parseó, devolvemos mensaje simple para no romper el front
    if (!parsed || typeof parsed !== "object") {
      return res.status(200).json({
        success: true,
        assistant: "Generé un borrador, pero no pude formatearlo aún. ¿Podrías confirmar el destino/fechas para estructurarlo?",
        itinerary: null,
        raw: outText
      });
    }

    return res.status(200).json({
      success: true,
      assistant: parsed.assistant || "",
      itinerary: parsed.itinerary || null,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "server_error", details: err.message });
  }
}

/* Extrae JSON aunque venga en bloque ```json ... ``` */
function safeParseJson(txt) {
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch (_) {}
  // buscar bloque triple
  const m = txt.match(/```json\s*([\s\S]*?)\s*```/i) || txt.match(/```[\s\S]*?```/);
  if (m && m[1]) {
    try { return JSON.parse(m[1]); } catch (_) {}
  }
  // intento extra: localizar primer { ... último }
  const first = txt.indexOf("{");
  const last  = txt.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const slice = txt.slice(first, last + 1);
    try { return JSON.parse(slice); } catch (_) {}
  }
  return null;
}
