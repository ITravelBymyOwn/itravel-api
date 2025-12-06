// /api/chat.js — v30.1 (ESM compatible en Vercel) — cambios mínimos
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
        start: "08:30",
        end: "19:00",
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
// Prompt base mejorado ✨
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
- Usa horas realistas (o 08:30–19:00 si no se indica nada).
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
- Usa un tono cálido, entusiasta y narrativo.
- Las notas deben:
  • Explicar en 1 o 2 líneas por qué la actividad es especial.  
  • Transmitir emoción y motivación (ej. “Admira…”, “Descubre…”, “Siente…”).  
  • Si no hay información específica, usa un fallback inspirador (“Una parada ideal para disfrutar la esencia de este destino”).
- Personaliza las notas según la naturaleza de la actividad: arquitectura, gastronomía, cultura, naturaleza, etc.
- Varía el vocabulario: evita repetir exactamente la misma nota.

🚆 TRANSPORTE Y TIEMPOS
- Usa medios coherentes con el contexto (a pie, metro, tren, taxi, bus, auto, ferry…).
- Las horas deben estar ordenadas y no superponerse.
- Incluye tiempos aproximados de actividad y traslados.

💰 MONETIZACIÓN FUTURA (sin marcas)
- Sugiere actividades naturalmente vinculables a upsells (ej. cafés, museos, experiencias locales).
- No incluyas precios ni nombres comerciales.
- No digas “compra aquí” — solo describe experiencias.

📝 EDICIÓN INTELIGENTE
- Si el usuario pide “agregar un día”, “quitar actividad” o “ajustar horarios”, responde con el itinerario JSON actualizado.
- Si no especifica hora, distribuye las actividades lógicamente en mañana / mediodía / tarde.
- Mantén la secuencia clara y cronológica.

🎨 UX Y NARRATIVA
- Cada día debe fluir como una historia (inicio, desarrollo, cierre).
- Usa descripciones cortas, sin párrafos largos.
- Mantén claridad y variedad en las actividades.

🔭 AURORAS (regla global, si aplica por latitud/temporada)
- Si el destino está en una zona típica de auroras (p. ej., Reykjavik, Tromsø, Abisko, Rovaniemi, Fairbanks, Yellowknife, Kiruna, Alta, Akureyri, Ivalo, Svalbard) y la época es propicia,
  reparte **noches de caza de auroras** NO consecutivas según la duración de la estancia.
- Cada noche de auroras debe ir 18:00–01:00, transporte **"Vehículo alquilado o Tour guiado"** y nota breve clara.
- Evita colocar “Vehículo alquilado o Tour guiado” en actividades posteriores a un “Regreso …” dentro de la misma noche/ciudad.

🚫 ERRORES A EVITAR
- No devuelvas “seed”.
- No uses frases impersonales (“Esta actividad es…”).
- No incluyas saludos ni explicaciones fuera del JSON.
- No repitas notas idénticas en varias actividades.

Ejemplo de nota motivadora correcta:
“Descubre uno de los rincones más encantadores de la ciudad y disfruta su atmósfera única.”
`.trim();

// ==============================
// Utilidades de post-proceso (AÑADIDO)
// ==============================

// Ciudades comunes con auroras (lista estática mínima — sin dependencias)
const AURORA_CITIES = new Set([
  "reykjavik","reykjavík","tromso","tromsø","rovaniemi","abisko","fairbanks",
  "yellowknife","kiruna","alta","akureyri","murmansk","svalbard","ivalo","honningsvag","honningvåg"
]);

// Nota reducida (sin tamaño pequeño; con la parte final en negrita)
const AURORA_NOTE =
  "Noche especial de caza de auroras. Con cielos despejados y paciencia, podrás presenciar un espectáculo natural inolvidable. **Regreso según tour. Puedes ir con tour guiado o por tu cuenta; si conduces, infórmate sobre seguridad invernal y nieve nocturna.**";

// Decide cuántas noches de auroras según total de días
function auroraNightsFor(totalDays) {
  if (totalDays <= 2) return 1;
  if (totalDays <= 4) return 2;
  if (totalDays <= 6) return 3;
  return 4;
}

// Inserta noches de auroras (no consecutivas, prioriza noches tempranas)
function injectAurorasIfNeeded(parsed) {
  try {
    const city =
      (parsed?.destination || parsed?.destinations?.[0]?.name || "").toString().toLowerCase().trim();

    if (!city) return parsed;
    if (![true, "true"].includes(parsed?.__skipAuroras)) {
      // Heurística: si la ciudad pertenece a la lista, consideramos que “aplica”
      const applies = AURORA_CITIES.has(city);
      if (!applies) return parsed;
    } else {
      return parsed;
    }

    // Normalizamos acceso a rows
    const rows = parsed.rows || parsed.destinations?.[0]?.rows || [];
    if (!Array.isArray(rows) || rows.length === 0) return parsed;

    // Si ya hay actividades de auroras, no duplicar
    const already = rows.some(r =>
      (r?.activity || "").toLowerCase().includes("aurora")
      || (r?.notes || "").toLowerCase().includes("aurora")
    );
    if (already) return parsed;

    const maxDay = rows.reduce((m, r) => Math.max(m, Number(r.day || 1)), 1);
    const targetNights = auroraNightsFor(maxDay);

    // Elegimos días: 1, 3, 5, 7...
    const chosenDays = [];
    for (let d = 1; d <= maxDay && chosenDays.length < targetNights; d += 2) {
      chosenDays.push(d);
    }

    // Insertamos actividad al final de cada día elegido
    chosenDays.forEach(dayNum => {
      rows.push({
        day: dayNum,
        start: "18:00",
        end: "01:00",
        activity: "Caza de auroras boreales",
        from: "Hotel",
        to: "Puntos de observación (variable)",
        transport: "Vehículo alquilado o Tour guiado",
        duration: "≈7h",
        notes: AURORA_NOTE
      });
    });

    // Re-escribimos estructura sin cambiar formato del usuario
    if (parsed.rows) {
      parsed.rows = rows;
    } else if (parsed.destinations && parsed.destinations[0]) {
      parsed.destinations[0].rows = rows;
    }
    return parsed;
  } catch {
    return parsed;
  }
}

// Corrige transporte “post-regreso”: tras una fila con “Regreso …”, 
// si aparecen filas con “Vehículo alquilado o Tour guiado” dentro de la ciudad, las relajamos a “A pie”.
function fixTransportAfterReturn(parsed) {
  try {
    const rows = parsed.rows || parsed.destinations?.[0]?.rows || [];
    if (!Array.isArray(rows) || rows.length === 0) return parsed;

    // Ordenamos por (day, start) de forma defensiva (no cambiamos el resto)
    const normalized = [...rows].sort((a, b) => {
      const da = Number(a.day || 1), db = Number(b.day || 1);
      if (da !== db) return da - db;
      return String(a.start || "").localeCompare(String(b.start || ""));
    });

    let returnedFlagByDay = {}; // day -> boolean
    normalized.forEach((r) => {
      const day = Number(r.day || 1);
      const text = (r.activity || "").toLowerCase();
      if (text.startsWith("regreso")) {
        returnedFlagByDay[day] = true;
      } else if (returnedFlagByDay[day]) {
        if (typeof r.transport === "string" &&
            r.transport.toLowerCase().includes("vehículo alquilado")) {
          // Cambiamos a algo urbano y neutro
          r.transport = "A pie o taxi local";
        }
      }
    });

    // Reaplicamos
    if (parsed.rows) {
      parsed.rows = normalized;
    } else if (parsed.destinations && parsed.destinations[0]) {
      parsed.destinations[0].rows = normalized;
    }
    return parsed;
  } catch {
    return parsed;
  }
}

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

    // 🧭 MODO PLANNER — comportamiento original
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

    // ⬇️ AÑADIDOS ULTRA-QUIRÚRGICOS
    if (parsed && (parsed.rows || parsed.destinations)) {
      parsed = injectAurorasIfNeeded(parsed);
      parsed = fixTransportAfterReturn(parsed);
    }

    if (!parsed) parsed = fallbackJSON();
    return res.status(200).json({ text: JSON.stringify(parsed) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
