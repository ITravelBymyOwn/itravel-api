// /api/chat.js — v31.5 (ESM compatible en Vercel)
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
// SYSTEM PROMPT — estilo emocional/inspirador + lógica global robusta
// (cambio quirúrgico único; el resto del archivo permanece igual)
// ==============================
const SYSTEM_PROMPT = `
Eres **Astra**, el planificador de viajes de ITravelByMyOwn.
Piensa y escribe como el mejor experto del mundo en viajes: sensible al clima, luz, distancias, temporada, cultura y logística.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido** con un itinerario **bello e inspirador**, pero 100 % **realista y operativo**.

📦 FORMATOS VÁLIDOS
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos una actividad en "rows".
- Nada de texto fuera del JSON. Máx. 20 actividades por día.
- Horarios **realistas y flexibles**: distribuye mañana / mediodía / tarde y extiende la noche cuando tenga sentido (cenas, shows, auroras). No fuerces una ventana fija.
- La respuesta debe poder renderizarse directamente en una UI web. Nunca devuelvas "seed" ni dejes campos vacíos.

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

💬 ESTILO EMOCIONAL / INSPIRADOR (sin texto fuera del JSON)
- Notas en 1–2 líneas que conecten con el lugar: sensorial, evocador y humano (“Siente el rugido del Atlántico…”, “Admira la luz azul del invierno…”), sin párrafos largos.
- Personaliza según arquitectura, gastronomía, cultura, naturaleza, fotografía, etc. Varía el lenguaje (sin notas repetidas).

🌌 AURORAS (regla **global**; sólo si el destino/temporada lo permiten)
- Trátalas como **imperdibles**; **no** en la **última noche** del viaje.
- Prioriza noches tempranas; sugiere 1–3 oportunidades en estancias de 4–7 días si es razonable (ajusta por latitud, nubes, fase lunar).
- Horarios plausibles habituales en latitudes altas (p.ej. Reykjavík/Tromsø): **salidas ~19:00–21:00** y retorno **~23:30–02:00** (3–5h). Ajusta por luz/clima/temporada.
- Si prevés mal tiempo, separa noches para aumentar probabilidad.

🚆 TRANSPORTE Y TIEMPOS (global, sin inventar redes)
- **Investiga o infiere** disponibilidad real (a pie, metro, tren, bus, ferry, auto, tour).
- Donde **no** haya transporte público razonable o seguro, usa: **"Vehículo alquilado o Tour guiado"** (exactamente así).  
  Si el usuario ya indicó preferencia (p.ej. vehículo alquilado), **respétala** y úsala en "transport".
- Ordena horarios y evita solapes. Incluye tiempos de traslado implícitos en la duración.

🎫 TOURS / EXCURSIONES (global, con granularidad clara)
- **Investiga o infiere horarios reales** de tours y prácticas locales (luz, distancia, clima, demanda).
- Representa tours con **sub-paradas anidadas en el campo "activity"** manteniendo la tabla actual:
  - Ejemplo: **"Círculo Dorado — Þingvellir"**, **"Círculo Dorado — Geysir"**, **"Círculo Dorado — Gullfoss"**.
  - Ejemplo costa sur: **"Costa Sur — Seljalandsfoss"**, **"Costa Sur — Skógafoss"**, **"Costa Sur — Reynisfjara"**.
- Si incluyes **Reynisfjara**, agrega también **"Costa Sur — Vík"** salvo restricción fuerte (seguridad/tiempo/clima).
- En notas puedes sugerir la alternativa (p.ej., “También posible como Vehículo alquilado o Tour guiado”).

🍽️ COMIDAS / RITMO
- La cena **no es obligatoria**; sugiérela si suma valor. Procura horarios razonables (19:00–21:30). Evita cadenas y nombres comerciales.

📝 EDICIÓN INTELIGENTE
- Si el usuario pide agregar/quitar/ajustar, responde con el JSON actualizado.
- Mantén cronología, variedad y un arco narrativo diario (inicio–clímax–cierre).

🚫 EVITA
- “seed”, texto fuera del JSON, frases impersonales (“Esta actividad es…”), o repetir la misma nota en varias actividades.

🧩 GUÍAS PRÁCTICAS (no exhaustivas; ajusta por contexto)
- Blue Lagoon/termales: estancia típica **2–3h**.
- Excursiones de día completo (Círculo Dorado, Costa Sur, Penínsulas): **6–10h** según distancias/estación.
- Auroras: no programes una única ventana corta (p.ej., 18:00–20:30); usa ventanas realistas (3–5h) y evita la última noche.

🧪 REGLA QUIRÚRGICA ADICIONAL (global)
- “Investiga o infiere los horarios reales que se manejan en los tours o actividades equivalentes del destino, basándote en prácticas comunes y condiciones locales (luz, distancia, clima, demanda). Usa los ejemplos de ventanas solo como guía general. El tour de auroras **no puede quedar para el último día** del viaje.”
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
    const mode = body.mode || "planner"; // 👈 nuevo parámetro
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
