// /api/chat.js — v31.1 (ESM compatible en Vercel)
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_OPENAI_API_KEY || process.env.OPENAI_API_KEY, // tolerante a var alternativa
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
// Prompt base mejorado ✨ (global: tours/transportes/auroras)
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido** que describa un itinerario turístico inspirador y funcional.

📌 FORMATOS VÁLIDOS DE RESPUESTA
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES (GLOBALES)
- Devuelve SIEMPRE al menos una actividad en "rows".
- Nada de texto fuera del JSON.
- 20 actividades máximo por día.
- Usa horas **realistas con flexibilidad**: no asumas una ventana fija (no fuerces 08:30–19:00).
  Si no hay información de horarios, distribuye lógicamente en mañana / mediodía / tarde y, cuando tenga sentido,
  puedes extender la noche (cenas, shows, paseos, **auroras**). **No obligues la cena**: sugiérela sólo si aporta valor.
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
  "transport": "Transporte realista (A pie, Metro, Tren, Auto, etc.)",
  "duration": "2h",
  "notes": "Descripción motivadora y breve"
}

🧠 ESTILO Y EXPERIENCIA DE USUARIO
- Tono cálido, entusiasta y narrativo.
- Notas: 1–2 líneas que expliquen por qué la actividad es especial; motiva (“Admira…”, “Descubre…”, “Siente…”).
- Varía el vocabulario; evita notas idénticas en varias actividades.
- Si faltan datos, usa un fallback inspirador (“Una parada ideal para disfrutar la esencia de este destino”).

🚆 TRANSPORTE (GLOBAL, INTELIGENTE)
- Usa medios coherentes con el contexto (a pie, metro, tren, taxi, bus, auto, ferry…).
- **Si el usuario NO especificó transporte y la actividad es FUERA de ciudad (day trip o trayecto interurbano),
  sugiere como opciones principales: "Auto (alquilado) o Tour guiado".**
- Evita proponer bus/tren cuando no sea habitual o práctico para ese trayecto; sólo sugiérelo si es realmente viable/localmente común.
- Si el usuario dijo explícitamente que alquila auto o que usará transporte público, respeta su preferencia.

🧭 TOURS (GLOBAL)
- **Desglosa** los tours en **paradas/waypoints clave** como filas separadas para que el plan sea accionable.
  Ejemplos de estilo (no son listas cerradas):
  • “Parque Thingvellir → Geysir → Gullfoss” (Círculo Dorado)
  • “Seljalandsfoss → Skógafoss → Reynisfjara → Vík” (Costa Sur)
- **Investiga o infiere los horarios reales** que se manejan en los tours o actividades equivalentes del destino,
  basándote en prácticas comunes y condiciones locales (luz, distancia, clima, demanda).
  Usa los ejemplos de ventanas sólo como guía general.
- Para **costas/penínsulas** prioriza **horas de luz**; evita programarlas demasiado tarde salvo justificación clara.

🌌 AURORAS (GLOBAL)
- Sugiere “caza de auroras” cuando sea plausible por **destino y época** (no inventes donde no aplica).
- **Evita noches consecutivas**.
- **No dejes la única noche de auroras para el último día del viaje**; reparte antes si es razonable.
- En estancias de 4–5+ días suele ser común 2–3 noches no consecutivas, pero decide según condiciones (clima, distancia, fatiga) y deja que el usuario ajuste.

📝 EDICIÓN INTELIGENTE
- Si el usuario pide “agregar un día”, “quitar actividad” o “ajustar horarios”, responde con el itinerario JSON actualizado.
- Si no especifica hora, distribuye las actividades lógicamente y con flexibilidad para la noche si corresponde.
- Mantén secuencia clara y cronológica.

🎨 UX Y NARRATIVA
- Cada día debe fluir como una historia (inicio, desarrollo, cierre).
- Descripciones cortas, sin párrafos largos.

🚫 ERRORES A EVITAR
- No devuelvas “seed”.
- No incluyas saludos ni explicaciones fuera del JSON.
- No repitas notas idénticas.
`.trim();

// ==============================
// Llamada al modelo
// ==============================
async function callStructured(messages, temperature = 0.4) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    input: messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
    max_output_tokens: 2200,
  });

  const text =
    resp?.output_text?.trim() ||
    resp?.output?.[0]?.content?.[0]?.text?.trim() ||
    "";

  console.log("🛰️ RAW RESPONSE:", text);
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
    const mode = body.mode || "planner"; // 👈 mantiene parámetro
    const clientMessages = extractMessages(body);

    // 🧭 MODO INFO CHAT — sin JSON, texto libre
    if (mode === "info") {
      const raw = await callStructured(clientMessages);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // 🧭 MODO PLANNER — reglas globales reforzadas
    let raw = await callStructured([{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages]);
    let parsed = cleanToJSON(raw);

    const hasRows = parsed && (parsed.rows || parsed.destinations);
    if (!hasRows) {
      const strictPrompt = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve al menos 1 fila en "rows". Nada de meta.`;
      raw = await callStructured([{ role: "system", content: strictPrompt }, ...clientMessages], 0.25);
      parsed = cleanToJSON(raw);
    }

    const stillNoRows = !parsed || (!parsed.rows && !parsed.destinations);
    if (stillNoRows) {
      const ultraPrompt = SYSTEM_PROMPT + `
Ejemplo válido:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
      raw = await callStructured([{ role: "system", content: ultraPrompt }, ...clientMessages], 0.1);
      parsed = cleanToJSON(raw);
    }

    if (!parsed) parsed = fallbackJSON();
    return res.status(200).json({ text: JSON.stringify(parsed) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
