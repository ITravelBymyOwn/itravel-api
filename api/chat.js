// /api/chat.js — v31.7 (ESM compatible en Vercel)
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
        notes:
          "Explora libremente la ciudad y descubre sus lugares más emblemáticos.",
      },
    ],
    followup: "⚠️ Fallback local: revisa configuración de Vercel o API Key.",
  };
}

// ==============================
// Prompt base mejorado ✨ (global: auroras, tours con sub-paradas, transporte realista)
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
- Usa horas **realistas con flexibilidad**: no fuerces 08:30–19:00.
  Si no hay información de horarios, reparte mañana / mediodía / tarde y extiende la noche sólo cuando tenga sentido (cenas, shows, paseos, auroras).
  **No obligues la cena**: sólo si aporta valor.
- La respuesta debe poder renderizarse en una UI web.
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

🧠 ESTILO Y EXPERIENCIA
- Tono cálido y narrativo.
- Notas en 1–2 líneas con emoción (“Admira…”, “Descubre…”, “Siente…”).
- Fallback inspirador si falta dato (“Una parada ideal para disfrutar la esencia del destino”).
- Varía vocabulario y personaliza según la actividad.

🌌 AURORAS (REGLA **GLOBAL** si el destino/temporada lo permiten)
- Trátalas como **imperdibles** cuando proceda.
- **Evita** programarlas en la **última noche**; prioriza noches tempranas.
- Programa **2–3 noches** en estancias de 5–7 días si es razonable; evita noches consecutivas salvo **justificación clara** (clima muy variable, latitud alta, ventana corta).
- Horarios **plausibles de mercado**:
  • **Salida mínima 19:00** (preferente 20:00–21:30).
  • **Duración típica 4–6h** (nunca <3.5h).
  • **Regreso ≥ 23:30** (habitual 00:30–02:30).
- Indica “Tour guiado” cuando sea la opción natural; si el usuario indicó **vehículo alquilado**, respétalo y sugiere puntos de observación seguros.

🚆 TRANSPORTE Y TIEMPOS (realistas, sin inventar redes)
- **Investiga o infiere** la disponibilidad real (a pie, metro, tren, bus, auto, ferri, tour).
- Cuando **no** haya transporte público razonable y el usuario **no** haya indicado preferencia, en "transport" usa **EXACTAMENTE**:
  **"Vehículo alquilado o Tour guiado"**
  (elige una como principal para esa fila según el contexto) y menciona la alternativa en "notes".
- Horarios ordenados, sin superposición, con duraciones y traslados aproximados.

🎫 TOURS Y ACTIVIDADES (horarios reales, sub-paradas y sentido) — **GLOBAL**
- **Investiga o infiere horarios** basados en prácticas locales (luz, distancia, clima, demanda).
- En **tours de nombre genérico o de jornada completa** (p. ej. “Círculo Dorado”, “Costa Sur”, “Reykjanes”, “Ruta del Vino”, “Tour por Kioto”, “Delta del Mekong”, “Costa Amalfitana”…), **desglosa como sub-paradas** en filas separadas **bajo el mismo encabezado principal** en "activity":
  Ejemplos de formato:
    "Círculo Dorado — Þingvellir"
    "Círculo Dorado — Geysir"
    "Círculo Dorado — Gullfoss"
    "Costa Sur — Reynisfjara"
    "Costa Sur — Vík"
    "Reykjanes — Brimketill" / "Reykjanes — Puente entre Continentes" / "Reykjanes — campos de lava", etc.
- **Incluye localidades clave naturalmente ligadas** a la ruta (p. ej., si aparece Reynisfjara, incluir también **Vík**).
- Mantén trazado lógico punto-a-punto; evita saltos innecesarios.

💰 MONETIZACIÓN FUTURA (sin marcas)
- Sugiere experiencias monetizables (museos, cafés, actividades), sin precios ni marcas.

📝 EDICIÓN INTELIGENTE
- Ante “agregar día/quitar/ajustar”, responde con el JSON actualizado.
- Si no hay hora, reparte lógicamente mañana/mediodía/tarde y, si corresponde, noche.
- Mantén la secuencia cronológica.

🎨 UX Y NARRATIVA
- Cada día debe fluir como historia (inicio, desarrollo, cierre), claro y variado.

🚫 ERRORES A EVITAR
- No “seed”, no frases impersonales, no saludos, no repetir notas idénticas.

Ejemplo de nota correcta:
“Descubre uno de los rincones más encantadores de la ciudad y disfruta su atmósfera única.”

📌 REGLA QUÍRÚRGICA ADICIONAL
- “Investiga o infiere los horarios reales que se manejan en los tours o actividades equivalentes del destino,
  basándote en prácticas comunes y condiciones locales (luz, distancia, clima, demanda).
  Usa los ejemplos de ventanas solo como guía general.
  El tour de auroras **no puede quedar para el último día** del viaje ni comenzar antes de **19:00**, y su **duración mínima** será de **3h 30m**.”
`.trim();

// ==============================
// Llamada al modelo
// ==============================
async function callStructured(messages, temperature = 0.4) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    input: messages
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n"),
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
    let raw = await callStructured(
      [{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages]
    );
    let parsed = cleanToJSON(raw);

    const hasRows = parsed && (parsed.rows || parsed.destinations);
    if (!hasRows) {
      const strictPrompt =
        SYSTEM_PROMPT +
        `
OBLIGATORIO: Devuelve al menos 1 fila en "rows". Nada de meta.`;
      raw = await callStructured(
        [{ role: "system", content: strictPrompt }, ...clientMessages],
        0.25
      );
      parsed = cleanToJSON(raw);
    }

    const stillNoRows = !parsed || (!parsed.rows && !parsed.destinations);
    if (stillNoRows) {
      const ultraPrompt =
        SYSTEM_PROMPT +
        `
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
