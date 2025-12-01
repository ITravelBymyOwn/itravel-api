// /api/chat.js — v32.4 (ESM compatible en Vercel)
// Cambio quirúrgico vs v32.3: refuerzo en el prompt para “investigar/INFERIR horarios reales por destino”
// (los ejemplos de ventanas quedan como guía, NO como restricción).
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
        end: "10:00",
        activity: "Itinerario base (fallback)",
        from: "",
        to: "",
        transport: "A pie",
        duration: "60m",
        notes: "Explora libremente la ciudad y descubre sus lugares más emblemáticos.",
      },
    ],
    followup: "⚠️ Fallback local: revisa configuración de Vercel o API Key.",
  };
}

// ==============================
// PROMPT DEL AGENTE (flexible y contextual)
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido** con formato B o C (ver abajo). Nada de texto fuera del JSON.

📌 FORMATOS VÁLIDOS
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos una actividad en "rows".
- Máximo 20 actividades por día.
- Horarios **flexibles y realistas** (NO fijes 08:30–19:00 por defecto). Ajusta según ciudad, estación, luz diurna, traslados y ritmo lógico.
- La respuesta debe poder renderizarse directamente en una UI web.
- Nunca devuelvas "seed" ni dejes campos clave vacíos.

🧭 ESTRUCTURA OBLIGATORIA DE CADA ACTIVIDAD
{
  "day": 1,
  "start": "09:00",
  "end": "10:30",
  "activity": "Nombre claro y específico",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "A pie / Metro / Bus / Tren / Auto / Tour guiado / Ferry … (coherente)",
  "duration": "90m",
  "notes": "Descripción motivadora y breve"
}

🧠 ESTILO Y EXPERIENCIA
- Tono cálido, entusiasta y concreto.
- Notas que expliquen en 1–2 líneas el atractivo (arquitectura, gastronomía, cultura, naturaleza, etc.), evitando repeticiones.

🚆 TRANSPORTE Y COHERENCIA
- Elige transporte **coherente con el destino**: verifica si realmente hay bus/tren/ferry/avión en esa ruta; si no, sugiere **alquiler de vehículo** o **tour guiado**. 
- Si el usuario ya indicó que alquilará vehículo, úsalo por defecto; si no, ofrece alternativas sensatas (auto vs. tour vs. público) y **usa la que tenga más sentido** para la actividad/ciudad.
- Ordena horas, evita solapamientos, incluye tiempos aproximados realistas (actividad + traslados).

🌌 AURORAS BOREALES (regla global, inteligente)
- Considera la observación de auroras como **imperdible** en ciudades/latitudes donde aplique (ej.: Tromsø, Reykjavik, Rovaniemi, Fairbanks, Yellowknife, Abisko, etc.) y en temporada adecuada.
- **No fijes una frecuencia rígida**: recomienda la cantidad de noches que consideres razonable según contexto (estancia total, condiciones típicas, latitud, temporada). Deja margen a decisión del usuario en el followup.
- Para cada ciudad donde aplique, **investiga o infiere** ventanas/horarios y formato real (puntos de salida típicos, traslados, paradas fotográficas, duración, margen de retorno).
- **Ventanas típicas de ejemplo (orientativas, NO obligatorias)**: salida 18:00–21:00; regreso 00:00–02:30+. 
  🔧 **Modificación v32.4 (quirúrgica)**: “**Investiga o infiere los horarios reales** que se manejan en el destino (tours, latitud, temporada, distancias). **Usa los ejemplos solo como guía**, nunca como restricción.”

🎫 TOURS Y ACTIVIDADES “IMPERDIBLES”
- Siempre que tenga sentido, **considera tours reales típicos** del destino (p. ej., glaciares, cuevas de hielo, ballenas, fiordos, free tours, pases de museos, etc.). 
- Incluye en notas: hora(s) de salida aproximada(s), duración esperada, requisitos usuales (ropa térmica, reserva previa), y **punto de encuentro típico** (centro, terminal, puerto).
- Si “tour guiado” no encaja (poca oferta en ese horario/ruta), propone **auto de alquiler** con itinerario verosímil (carreteras factibles, ida/vuelta dentro de tiempos seguros).

🍽️ COMIDAS (regla flexible)
- Considera **almuerzo** y **cena** en horarios razonables del destino. 
- Si hay opciones icónicas/imperdibles (restaurantes emblemáticos, mercados, shows con cena), sugiere de forma equilibrada a lo largo del viaje (no en exceso). 
- No obligues la cena si no aporta valor al flujo del día.

📝 EDICIÓN INTELIGENTE
- Si el usuario pide “agregar/quitar día”, “mover actividad” o “ajustar horarios”, devuelve el itinerario en JSON actualizado.
- Si no se especifica hora, distribuye lógicamente mañana/mediodía/tarde/noche, respetando buffers razonables y evitando huecos largos.

🎨 UX Y NARRATIVA
- Cada día debe fluir como una historia (inicio, desarrollo, cierre).
- Descripciones cortas, claras y variadas.

🚫 ERRORES A EVITAR
- No devuelvas “seed”.
- No texto fuera del JSON.
- No repitas notas idénticas en varios items.
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
// Exportación ESM
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

    // 🧭 MODO PLANNER — estrictamente JSON (B o C)
    let raw = await callStructured(
      [{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages]
    );
    let parsed = cleanToJSON(raw);

    const hasRows = parsed && (parsed.rows || parsed.destinations);
    if (!hasRows) {
      const strictPrompt = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve al menos 1 fila en "rows". Nada de meta.`;
      raw = await callStructured(
        [{ role: "system", content: strictPrompt }, ...clientMessages],
        0.25
      );
      parsed = cleanToJSON(raw);
    }

    const stillNoRows = !parsed || (!parsed.rows && !parsed.destinations);
    if (stillNoRows) {
      const ultraPrompt = SYSTEM_PROMPT + `
Ejemplo válido:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
      raw = await callStructured(
        [{ role: "system", content: ultraPrompt }, ...clientMessages],
        0.1
      );
      parsed = cleanToJSON(raw);
    }

    if (!parsed) parsed = fallbackJSON();
    return res.status(200).json({ text: JSON.stringify(parsed) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
