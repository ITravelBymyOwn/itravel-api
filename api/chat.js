// /api/chat.js — v31.3 (ESM compatible en Vercel) · ajustes quirúrgicos: JSON nativo planner + auroras globales + transporte y tours
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
// Prompt base mejorado ✨ (flex hours, transporte/tours realistas, auroras globales)
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
- Tono cálido y narrativo.
- Notas breves (1–2 líneas) que expliquen por qué la actividad es especial.
- Varía el vocabulario; evita repetir notas idénticas.

🌌 AURORAS (regla GLOBAL, si aplica por destino/temporada)
- Trátalas como **imperdibles** cuando el destino y la época lo permitan.
- **Evita programarlas en la última noche del viaje**; prioriza noches tempranas.
- Evita noches consecutivas salvo que exista **justificación clara** (ej. clima variable, estadías largas).
- Para estancias de ~5 días, suele ser razonable **2–3 noches no consecutivas** si es plausible (guía, no regla dura).
- Usa ventanas y duraciones **plausibles**: salida **~18:00–19:30**, duración **≥4–6 h**, regreso **≥23:30** (a menudo 00:30–02:00).

🚆 TRANSPORTE Y TIEMPOS (realistas)
- **Investiga o infiere** medios disponibles (a pie, metro, tren, bus, auto, ferri, tour guiado) según prácticas locales.
- **No** asumas buses o trenes donde no apliquen; en destinos con poca red pública, prefiere **Auto (alquilado)** o **Tour guiado**.
- Si el usuario ya indicó preferencia (p. ej., “vehículo alquilado”), **respétala**.
- Si el usuario **no** indicó preferencia y **no hay transporte público razonable**, el campo **"transport" debe decir literal**:
  **"Vehículo alquilado o Tour guiado"**.
- En otros casos (cuando ambas opciones son válidas), usa la más razonable en "transport" y menciona la alternativa en "notes".
- Ordena horas sin solaparlas e incluye tiempos aproximados de actividad y traslados.

🎫 TOURS Y ACTIVIDADES GUIADAS (robustas)
- **Investiga o infiere** horarios reales habituales de los tours según luz, distancia, clima, demanda.
- Detalla **paradas clave** y el **orden lógico** en rutas emblemáticas (p. ej., en un “Círculo Dorado” enumera puntos principales).
- Usa las ventanas como **guía general**, ajustándote al contexto local.

📝 EDICIÓN INTELIGENTE
- Si el usuario pide “agregar un día”, “quitar actividad” o “ajustar horarios”, devuelve el itinerario JSON actualizado.
- Si no se especifican horas, distribuye lógicamente en mañana / mediodía / tarde, extendiendo noche si corresponde.
- Mantén secuencia clara y cronológica.

🎨 UX Y NARRATIVA
- Cada día debe fluir como una historia (inicio, desarrollo, cierre).
- Descripciones cortas; claridad y variedad.

🚫 ERRORES A EVITAR
- No devuelvas “seed”.
- No uses frases impersonales (“Esta actividad es…”).
- No incluyas saludos ni texto fuera del JSON.
- No repitas notas idénticas.
`.trim();

// ==============================
// Llamadas al modelo
// ==============================

// Modo info: texto libre (sin forzar JSON)
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

  console.log("🛰️ RAW RESPONSE (info):", text);
  return text;
}

// Modo planner: forzar JSON nativo para evitar parseos fallidos
async function callStructuredJSON(messages, temperature = 0.35) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    response_format: { type: "json_object" }, // 🔒 fuerza JSON válido
    input: messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
    max_output_tokens: 2600,
  });

  const text =
    resp?.output_text?.trim() ||
    resp?.output?.[0]?.content?.[0]?.text?.trim() ||
    "";

  console.log("🛰️ RAW RESPONSE (planner-json):", text);
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
      const raw = await callStructured(clientMessages);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // 🧭 MODO PLANNER — reglas flexibles + mejoras globales
    let raw = await callStructuredJSON([{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages]);
    let parsed = cleanToJSON(raw);

    const hasRows = parsed && (parsed.rows || parsed.destinations);
    if (!hasRows) {
      const strictPrompt = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve al menos 1 fila en "rows". Nada de meta.`;
      raw = await callStructuredJSON([{ role: "system", content: strictPrompt }, ...clientMessages], 0.25);
      parsed = cleanToJSON(raw);
    }

    const stillNoRows = !parsed || (!parsed.rows && !parsed.destinations);
    if (stillNoRows) {
      const ultraPrompt = SYSTEM_PROMPT + `
Ejemplo válido:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
      raw = await callStructuredJSON([{ role: "system", content: ultraPrompt }, ...clientMessages], 0.1);
      parsed = cleanToJSON(raw);
    }

    if (!parsed) parsed = fallbackJSON();
    return res.status(200).json({ text: JSON.stringify(parsed) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
