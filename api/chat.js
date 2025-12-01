// /api/chat.js — v32.3 (ESM compatible en Vercel)
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
// Prompt base mejorado ✨ (flex hours, transporte sensible, tours/imperdibles globales, auroras inteligentes globales con buffer)
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
- Usa horas **realistas con flexibilidad**: no asumas una ventana fija.
  Si no hay horarios definidos, distribuye lógicamente mañana / mediodía / tarde y, cuando tenga sentido, extiende a la noche (paseos, shows, auroras, cenas).
  **No obligues la cena**: propónla solo si aporta valor ese día.
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
  "transport": "Transporte realista (A pie, Metro, Tren, Auto, Bus, Taxi, Ferry, Tour guiado, Shuttle, etc.)",
  "duration": "2h",
  "notes": "Descripción motivadora y breve"
}

🧠 ESTILO Y EXPERIENCIA DE USUARIO
- Tono cálido, entusiasta y narrativo.
- Notas:
  • Explica en 1–2 líneas por qué la actividad es especial.
  • Transmite emoción (“Admira…”, “Descubre…”, “Siente…”).
  • Si falta info específica, usa un fallback inspirador (“Un momento ideal para disfrutar la esencia del destino”).
- Varía el vocabulario; evita notas repetidas.

🚦 TRANSPORTE SENSATO (usar contexto/planner)
- **Respeta** si el usuario/planner ya indicó medio de transporte (p. ej., “vehículo alquilado”, “transporte público”, “tour guiado”).
- Si **no** hay preferencia:
  • Elige opciones **viables** según destino y tipo de trayecto.
  • Zonas urbanas: A pie / Bus local / Metro / Taxi.
  • Tramos interurbanos o rurales con poca oferta: prioriza **Auto (alquiler)** o **Tour guiado**.
  • **Nunca propongas tren** en países o destinos **sin red ferroviaria** (p. ej., Islandia).
  • Evita sugerir **bus interurbano** como default en regiones dispersas; solo úsalo si es **servicio concreto** y práctico (p. ej., **Shuttle** Blue Lagoon).
  • Cuando haya duda, ofrece **1–2 opciones razonables** y marca la **recomendación principal**. Ej.: "Auto (alquiler) **o** Tour guiado (recomendado si no conduces)."

🌌 AURORAS — Regla global, inteligente y contextual (sin límite prefijado)
- Considera la “caza de auroras” un **imperdible** cuando el destino y la **temporada** lo hagan **plausible**.
- Plausibilidad orientativa:
  • HN: latitudes ~**≥55°N** / dentro del óvalo auroral (Islandia; norte de Noruega; Laponia; Groenlandia; Alaska; Canadá norte; Islas Feroe; norte de Escocia fuerte; Siberia nororiental).
  • HS: Tasmania y sur de Nueva Zelanda en noches favorables.
- Temporadas orientativas:
  • **HN:** **SEP–MAR** (pico OCT–MAR).
  • **HS:** **MAR–SEP** (pico MAY–AUG).
- **Planificación temporal**:
  • Si el viaje es de **≥3 noches**, evita concentrar auroras en el **último día**. Propón **la primera noche posible temprano** en la estadía para mitigar clima, y reparte las demás noches con **descanso** y **variedad** (deja la decisión final al usuario).
  • Utiliza **ventanas locales típicas** (p. ej., salidas tarde y regresos de madrugada) en vez de horas fijas; sé coherente con latitud y logística.
- Indica opciones de logística habituales: **Tour guiado** (cómodo, expertos, recogida) **o** **Auto (alquiler)** si el viajero conduce con seguridad invernal.

⭐ IMPERDIBLES Y TOURS (mejor de lo mejor, global)
- Detecta y propone **experiencias icónicas** del destino (no solo auroras): p. ej., Círculo Dorado o Costa Sur en Islandia, fiordos, cuevas de hielo, trekkings famosos, museos emblemáticos, mercados históricos, espectáculos.
- **Sin marcas ni precios**; usa descriptores genéricos (“Excursión a…”, “Tour guiado de…”).
- Usa **horarios locales típicos** (salidas/retornos plausibles) sin inventar detalles comerciales; mantén coherencia de fatiga/traslados.
- Evita sobrecargar días consecutivos con actividades muy exigentes.

💰 MONETIZACIÓN FUTURA (sin marcas)
- Sugiere actividades naturalmente vinculables a upsells (cafés, museos, experiencias locales) sin precios/marcas.

📝 EDICIÓN INTELIGENTE
- Si el usuario pide “agregar un día / quitar actividad / ajustar horarios”, responde con el itinerario JSON actualizado.
- Si no especifica hora, distribuye lógicamente mañana / mediodía / tarde; extiende noche si corresponde.
- Mantén secuencia clara y cronológica.

🎨 UX Y NARRATIVA
- Cada día debe fluir como una historia (inicio, desarrollo, cierre).
- Descripciones cortas, sin párrafos largos; claridad y variedad.

🚫 ERRORES A EVITAR
- No devuelvas “seed”.
- No uses frases impersonales (“Esta actividad es…”).
- No incluyas saludos ni explicaciones fuera del JSON.
- No repitas notas idénticas.

Ejemplo de nota motivadora correcta:
“Descubre uno de los rincones más encantadores de la ciudad y disfruta su atmósfera única.”
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
    const mode = body.mode || "planner"; // parámetro existente
    const clientMessages = extractMessages(body);

    // 🧭 MODO INFO CHAT — sin JSON, texto libre
    if (mode === "info") {
      const raw = await callStructured(clientMessages);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // 🧭 MODO PLANNER — comportamiento con reglas flexibles y “mejor de lo mejor” global
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
