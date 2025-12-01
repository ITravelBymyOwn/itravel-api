// /api/chat.js — v32.3 (ESM compatible en Vercel) · PATCH QUIRÚRGICO AL PROMPT
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
// Prompt base mejorado ✨ (flex hours, transporte sensible, tours/imperdibles globales, auroras inteligentes globales sin límite fijo)
// **PATCH v32.3**: no relegar imperdibles al último día; auroras tempranas cuando aplique; transporte con alternativas realistas si el usuario no fijó preferencia; investigar horarios de tours; evitar “tren” donde no existe (p.ej., Islandia) y “bus” interurbano poco práctico.
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
- Usa horas **realistas con flexibilidad**: NO asumas una ventana fija. Si no hay datos, distribuye lógicamente mañana / mediodía / tarde y, cuando tenga sentido, extiende a la noche (paseos, shows, auroras, cenas).
- **No obligues la cena**: propónla sólo si aporta valor ese día (si no, sugiérela como opcional).
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
  "transport": "Transporte realista (A pie, Metro, Tren, Auto, Bus, Taxi, Ferry, Tour guiado, etc.)",
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

🚦 TRANSPORTE SENSATO (contexto + destino)
- **Respeta** si el usuario ya indicó medio de transporte (p. ej., “vehículo alquilado”, “transporte público”). Si hay preferencia explícita, úsala como principal.
- Si **no** hay preferencia, elige opciones **viables** según destino y tipo de trayecto:
  • Tramos **urbanos**: A pie / Bus local / Metro / Taxi.
  • Tramos **interurbanos o rurales con poca oferta**: prioriza **Auto (alquiler)** o **Tour guiado**. Si ambos son razonables, preséntalos como **alternativas** en "transport" (p. ej., "Auto (alquiler) / Tour guiado") y acláralo en "notes".
  • Evita sugerir **tren** en destinos **sin red ferroviaria** (p. ej., Islandia) y evita proponer **bus interurbano** cuando sea poco práctico o infrecuente.
- Indica duración/traslado aproximado cuando ayude.

🌌 AURORAS — **Regla global e inteligente, sin límite prefijado**
- Trata la “caza de auroras” como **actividad imperdible** siempre que sea **plausible** por destino y **temporada**; propónla con criterio experto.
- Heurística de plausibilidad:
  • Hemisferio **norte**: latitudes altas (≈ **≥55°N**) u **óvalo auroral** (Islandia; norte de Noruega; Laponia FIN/SWE; Groenlandia; Alaska; Canadá norte; Feroe; norte de Escocia en noches fuertes; Siberia nororiental).
  • Hemisferio **sur**: latitudes altas (p. ej., **Tasmania**, **Isla Sur – NZ**) en noches favorables.
- Temporadas orientativas:
  • **HN:** **SEP–MAR** (pico aprox. OCT–MAR).
  • **HS:** **MAR–SEP** (pico aprox. MAY–AUG).
- **Planificación**: no concentres los intentos al final del viaje. Si el viaje dura **≥3 días** en un destino con auroras plausibles, prioriza **al menos un intento temprano** (en los **primeros 1–2 días**) y, si recomiendas más, **espácialos** según clima, fatiga y agenda. **El número final de noches queda a decisión del usuario**.
- Horarios: **investiga/infiere** salidas y regresos habituales en esa ciudad. Si no hay datos, usa una **ventana amplia y realista** de referencia (p. ej., salidas al atardecer **18:00–21:00** y retorno **23:00–02:30**), ajustándola al contexto local.

⭐ IMPERDIBLES Y TOURS (REGLA GLOBAL “mejor de lo mejor”)
- Detecta y propone **experiencias icónicas** del destino (no solo auroras): excursiones clave, miradores, museos emblemáticos, navegación de fiordos, cuevas de hielo, treks célebres, espectáculos, mercados históricos, etc. (**sin marcas ni precios**).
- No inventes nombres comerciales; usa descriptores genéricos (“Tour guiado de…”, “Excursión de…”).
- **Presenta alternativas** cuando existan varias opciones válidas (p. ej., “Excursión costa sur” **o** “Círculo Dorado”), indicando la **más recomendable** y dejando la **decisión final al usuario**.
- Evita sobrecargar **días consecutivos** con actividades muy exigentes; intercala días más ligeros.

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
