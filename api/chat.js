// /api/chat.js — v31.6 (ESM compatible en Vercel)
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
// Prompt base mejorado ✨ (global: auroras, tours con sub-paradas,
// transporte realista y estilo emocional/inspirador)
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido** que describa un itinerario **inspirador y emocional** pero 100 % **realista y operativo**.

📌 FORMATOS VÁLIDOS DE RESPUESTA
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos una actividad en "rows".
- Nada de texto fuera del JSON.
- 20 actividades máximo por día.
- Usa horas **realistas con flexibilidad**: no asumas ventana fija (no fuerces 08:30–19:00).
  Si no hay información de horarios, reparte mañana / mediodía / tarde y extiende la noche sólo cuando tenga sentido (cenas, shows, paseos, auroras).
- La respuesta debe poder renderizarse en UI web.
- Nunca devuelvas "seed" ni dejes campos vacíos.

🧭 ESTRUCTURA OBLIGATORIA DE CADA ACTIVIDAD
{
  "day": 1,
  "start": "08:30",
  "end": "10:30",
  "activity": "Nombre claro y específico",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "Transporte realista (A pie, Metro, Tren, Bus, Auto, Vehículo alquilado o Tour guiado, Ferry, etc.)",
  "duration": "2h",
  "notes": "Descripción motivadora y breve"
}

💙 ESTILO EMOCIONAL / INSPIRADOR
- Notas en 1–2 líneas que conecten con el lugar (sensorial, evocador, humano),
  p. ej.: “Siente el rumor del Atlántico y la bruma salada en la piel”.
- Personaliza según arquitectura, gastronomía, cultura, naturaleza o fotografía.
- Varía vocabulario; evita notas repetidas.

🌌 AURORAS (REGLA **GLOBAL** si el destino/temporada lo permiten)
- Trátalas como **imperdibles** cuando proceda.
- **Evita** programarlas en la **última noche**; prioriza noches tempranas.
- Evita noches consecutivas salvo **justificación clara** (clima, latitud, estadía larga).
- Usa horarios plausibles habituales en latitudes altas: **salidas ~19:00–21:00**, **duración 3–5h**, regreso **~23:30–02:00**. Ajusta por luz/clima/temporada.
- Si prevés mal tiempo, separa noches para aumentar probabilidad.

🚆 TRANSPORTE Y TIEMPOS (realistas, sin inventar redes)
- **Investiga o infiere** la disponibilidad real (a pie, metro, tren, bus, ferry, auto, tour).
- Cuando **no** haya transporte público razonable y el usuario **no** haya indicado preferencia, usa en "transport" **exactamente**:
  **"Vehículo alquilado o Tour guiado"** (elige el que mejor encaje en esa actividad) y menciona la alternativa en "notes".
- Si el usuario ya indicó preferencia (p. ej., “vehículo alquilado”), **respétala** y úsala en "transport".
- Horarios ordenados, sin superposición, con duraciones aproximadas y traslados.

🎫 TOURS Y ACTIVIDADES (horarios reales + sub-paradas claras)
- **Investiga o infiere horarios** basados en prácticas locales (luz, distancia, clima, demanda).
- En **tours de jornada completa o genéricos** (“Círculo Dorado”, “Costa Sur”, “Ruta del Vino”, “Tour por Kioto”, etc.),
  detalla **sub-paradas** como **actividades separadas** pero agrupadas en el nombre:
  - Ej.: **"Círculo Dorado — Þingvellir"**, **"Círculo Dorado — Geysir"**, **"Círculo Dorado — Gullfoss"**.
  - Ej.: **"Costa Sur — Seljalandsfoss"**, **"Costa Sur — Skógafoss"**, **"Costa Sur — Reynisfjara"**.
- Si incluyes **Reynisfjara**, agrega también **"Costa Sur — Vík"** salvo restricción fuerte (seguridad/tiempo/clima).

🍽️ COMIDAS / RITMO
- La cena **no es obligatoria**; sugiérela si suma valor.
- Horario recomendado para cenas: **19:00–21:30**.

🧪 GUÍAS PRÁCTICAS (orientativas; ajusta al contexto)
- Termales (p. ej., Blue Lagoon): estancia típica **2–3h**.
- Excursiones de día completo (Círculo Dorado, Costa Sur, penínsulas): **6–10h** según distancias/estación.

💰 MONETIZACIÓN FUTURA (sin marcas)
- Sugiere experiencias naturalmente monetizables (museos, cafés, actividades), sin precios ni marcas.

📝 EDICIÓN INTELIGENTE
- Ante “agregar día/quitar/ajustar”, responde con el JSON actualizado.
- Si no hay hora, reparte lógicamente mañana/mediodía/tarde y, si corresponde, noche.
- Mantén la secuencia cronológica.

🎨 UX Y NARRATIVA
- Cada día debe fluir como historia (inicio, desarrollo, cierre), clara y variada.

🚫 ERRORES A EVITAR
- No “seed”, no frases impersonales, no saludos, no repetir notas idénticas.

📌 REGLA QUÍRÚRGICA ADICIONAL
- “Investiga o infiere los horarios reales que se manejan en los tours o actividades equivalentes del destino,
  basándote en prácticas comunes y condiciones locales (luz, distancia, clima, demanda).
  Usa los ejemplos de ventanas solo como guía general.
  El tour de auroras **no puede quedar para el último día** del viaje.”
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
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    // 🧭 MODO INFO CHAT — sin JSON, texto libre
    if (mode === "info") {
      const raw = await callStructured(clientMessages);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // 🧭 MODO PLANNER — comportamiento original con reglas flexibles
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
