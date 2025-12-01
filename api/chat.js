// /api/chat.js — v31.2 (ESM compatible en Vercel)
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ==============================
// Helpers
// ==============================
function extractMessages(body = {}) {
  const { messages, input, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;
  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";
  return [...prev, { role: "user", content: userText }];
}

function cleanToJSON(raw = "") {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    try {
      const cleaned = raw.replace(/^[^\{]+/, "").replace(/[^\}]+$/, "");
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }
}

function fallbackJSON() {
  return {
    destination: "Desconocido",
    rows: [
      {
        day: 1,
        start: "09:00",
        end: "18:00",
        activity: "Itinerario base (fallback)",
        from: "",
        to: "",
        transport: "",
        duration: "",
        notes: "Explora libremente la ciudad y descubre sus lugares más emblemáticos.",
      },
    ],
    followup: "⚠️ Fallback local: revisa configuración de Vercel o API Key.",
  };
}

// ==============================
// Prompt base mejorado ✨ (flex hours, tours/transporte realistas, auroras globales)
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido** que describa un itinerario turístico inspirador y funcional.

📌 FORMATOS VÁLIDOS DE RESPUESTA
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos una actividad en "rows".
- Nada de texto fuera del JSON.
- 20 actividades máximo por día.
- Usa horas **realistas con flexibilidad**: no asumas una ventana fija (no fuerces 08:30–19:00).
  Si no hay información de horarios, distribuye lógicamente en mañana / mediodía / tarde y, cuando tenga sentido, puedes extender la noche (cenas, shows, paseos, auroras).
  **No obligues la cena**: sugiérela sólo si aporta valor ese día.
- La respuesta debe poder renderizarse directamente en una UI web.
- Nunca devuelvas "seed" ni dejes campos vacíos.

🧭 ESTRUCTURA OBLIGATORIA DE CADA ACTIVIDAD
{
  "day": 1,
  "start": "08:30",
  "end": "10:30",
  "activity": "Nombre claro y específico",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "Transporte realista (A pie, Metro, Tren, Bus, Auto, Tour guiado, etc.)",
  "duration": "2h",
  "notes": "Descripción motivadora y breve"
}

🧠 ESTILO Y EXPERIENCIA DE USUARIO
- Usa un tono cálido, entusiasta y narrativo.
- Las notas deben:
  • Explicar en 1 o 2 líneas por qué la actividad es especial.
  • Transmitir emoción y motivación (ej. “Admira…”, “Descubre…”, “Siente…”).
  • Si no hay información específica, usa un fallback inspirador (“Una parada ideal para disfrutar la esencia de este destino”).
- Personaliza las notas según la naturaleza de la actividad: arquitectura, gastronomía, cultura, naturaleza, etc.
- Varía el vocabulario: evita repetir exactamente la misma nota.

🌌 AURORAS (regla **global**, si aplica por destino/temporada)
- Trátalas como **imperdibles globales** cuando el destino y la época lo permitan.
- **Evita** programarlas en la **última noche del viaje**; prioriza noches tempranas.
- Evita noches consecutivas salvo que haya **justificación clara** (p. ej., condiciones climáticas variables, estadías largas, alta latitud).
- Usa horarios **plausibles del mercado local**:
  • Salida habitual ~18:00–19:30 (por desplazamientos y búsqueda de cielos despejados).
  • Duración 4–6 h.
  • Regreso después de 23:30; típico 00:30–02:00.

🚆 TRANSPORTE Y TIEMPOS (realistas, no inventar redes inexistentes)
- **Investiga o infiere** la disponibilidad real de medios (a pie, metro, tren, bus, auto, ferri, tour guiado).
- **No** asumas buses o trenes donde no apliquen; para destinos con poca red pública, usa:
  • En el campo "transport", exactamente: **"Vehículo alquilado o Tour guiado"** (elige el que mejor encaje en esa actividad) y menciona la alternativa en "notes".
- Si el usuario ya indicó preferencia (p. ej., “vehículo alquilado”), **respétala**.
- Las horas deben estar ordenadas y no superponerse. Incluye tiempos aproximados de actividad y traslados.

🎫 TOURS Y ACTIVIDADES GUIADAS (horarios, paradas y sentido)
- **Investiga o infiere** horarios reales según **prácticas locales** (luz, distancia, clima, demanda).
- Usa ejemplos de ventanas como **guía**, ajustando al contexto.
- En tours emblemáticos, **lista las paradas clave en orden lógico** (p. ej., en el Círculo Dorado: Thingvellir → Geysir → Gullfoss; en la Costa Sur: Seljalandsfoss → Skógafoss → Reynisfjara → Vík).
- Evita itinerarios absurdos (p. ej., visitar penínsulas muy tarde sin luz suficiente).

💰 MONETIZACIÓN FUTURA (sin marcas)
- Sugiere actividades naturalmente vinculables a upsells (cafés, museos, experiencias locales).
- No incluyas precios ni nombres comerciales.
- No digas “compra aquí” — solo describe experiencias.

📝 EDICIÓN INTELIGENTE
- Si el usuario pide “agregar un día”, “quitar actividad” o “ajustar horarios”, responde con el itinerario JSON actualizado.
- Si no especifica hora, distribuye las actividades lógicamente en mañana / mediodía / tarde, con flexibilidad para la noche si corresponde.
- Mantén la secuencia clara y cronológica.

🎨 UX Y NARRATIVA
- Cada día debe fluir como una historia (inicio, desarrollo, cierre).
- Usa descripciones cortas, sin párrafos largos.
- Mantén claridad y variedad en las actividades.

🚫 ERRORES A EVITAR
- No devuelvas “seed”.
- No uses frases impersonales (“Esta actividad es…”).
- No incluyas saludos ni explicaciones fuera del JSON.
- No repitas notas idénticas en varias actividades.

Ejemplo de nota motivadora correcta:
“Descubre uno de los rincones más encantadores de la ciudad y disfruta su atmósfera única.”

📌 REGLA QUIRÚRGICA ADICIONAL
- “Investiga o infiere los horarios reales que se manejan en los tours o actividades equivalentes del destino, basándote en prácticas comunes y condiciones locales (luz, distancia, clima, demanda). Usa los ejemplos de ventanas solo como guía general. El tour de auroras **no puede quedar para el último día** del viaje.”
`.trim();

// ==============================
// Llamada al modelo
// ==============================
async function callStructured(messages, temperature = 0.35, forceJson = false) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    input: messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
    max_output_tokens: 2600,
    ...(forceJson ? { response_format: { type: "json_object" } } : {}),
  });

  const text =
    resp?.output_text?.trim() ||
    resp?.output?.[0]?.content?.[0]?.text?.trim() ||
    "";

  console.log(`🛰️ RAW RESPONSE${forceJson ? " (planner-json)" : ""}:`, text);
  return text;
}

// ==============================
// Exportación ESM correcta
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body;
    const mode = body.mode || "planner"; // 👈 nuevo parámetro
    const clientMessages = extractMessages(body);

    // 🧭 MODO INFO CHAT — sin JSON, texto libre
    if (mode === "info") {
      const raw = await callStructured(clientMessages, 0.4, false);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // 🧭 MODO PLANNER — comportamiento original con reglas flexibles y mejoras
    let raw = await callStructured([{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages], 0.35, true);
    let parsed = cleanToJSON(raw);

    const hasRows = parsed && (parsed.rows || parsed.destinations);
    if (!hasRows) {
      const strictPrompt = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve al menos 1 fila en "rows". Nada de meta.`;
      raw = await callStructured([{ role: "system", content: strictPrompt }, ...clientMessages], 0.25, true);
      parsed = cleanToJSON(raw);
    }

    const stillNoRows = !parsed || (!parsed.rows && !parsed.destinations);
    if (stillNoRows) {
      const ultraPrompt = SYSTEM_PROMPT + `
Ejemplo válido:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
      raw = await callStructured([{ role: "system", content: ultraPrompt }, ...clientMessages], 0.1, true);
      parsed = cleanToJSON(raw);
    }

    if (!parsed) parsed = fallbackJSON();
    return res.status(200).json({ text: JSON.stringify(parsed) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
