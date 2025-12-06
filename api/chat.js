// /api/chat.js — v30.2 (ESM compatible en Vercel) — refactor defensivo sobre v30
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ==============================
// Helpers (idénticos + utilidades nuevas)
// ==============================
function extractMessages(body = {}) {
  const { messages, input, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;
  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";
  return [...prev, { role: "user", content: userText }];
}

// Más tolerante con bloques ```json ... ```
function cleanToJSON(raw = "") {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    try {
      let cleaned = raw.trim();

      // quita fences ```json ... ```
      if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/,"").replace(/```$/,"").trim();
      }

      // recorta a primer { ... } último }
      const first = cleaned.indexOf("{");
      const last = cleaned.lastIndexOf("}");
      if (first !== -1 && last !== -1 && last > first) {
        cleaned = cleaned.slice(first, last + 1);
      }
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

// Normalizadores/validadores seguros
const safeStr = (v) => (typeof v === "string" ? v : "");
const toLower = (s) => safeStr(s).toLowerCase();
const stripAccents = (s) =>
  safeStr(s).normalize("NFD").replace(/\p{Diacritic}/gu, "");

// Acceso seguro a rows en ambos formatos soportados
function getRows(parsed) {
  try {
    if (!parsed || typeof parsed !== "object") return [];
    if (Array.isArray(parsed.rows)) return parsed.rows;
    if (Array.isArray(parsed?.destinations?.[0]?.rows))
      return parsed.destinations[0].rows;
    return [];
  } catch {
    return [];
  }
}
function setRows(parsed, rows) {
  try {
    if (!parsed || typeof parsed !== "object" || !Array.isArray(rows)) return;
    if (Array.isArray(parsed.rows)) {
      parsed.rows = rows;
    } else if (Array.isArray(parsed?.destinations?.[0]?.rows)) {
      parsed.destinations[0].rows = rows;
    }
  } catch {
    /* no-op */
  }
}
function hasRows(parsed) {
  const r = getRows(parsed);
  return Array.isArray(r) && r.length > 0;
}

// ==============================
// Prompt base (igual al v30 + bloque Aurora breve)
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

📝 EDICIÓN INTELIGENTE
- Si el usuario pide “agregar un día”, “quitar actividad” o “ajustar horarios”, responde con el itinerario JSON actualizado.
- Si no especifica hora, distribuye las actividades lógicamente en mañana / mediodía / tarde.
- Mantén la secuencia clara y cronológica.

🎨 UX Y NARRATIVA
- Cada día debe fluir como una historia (inicio, desarrollo, cierre).
- Usa descripciones cortas, sin párrafos largos.
- Mantén claridad y variedad en las actividades.

🔭 AURORAS (si corresponde por latitud/temporada)
- Para destinos típicos de auroras, reparte **noches de caza de auroras** NO consecutivas (18:00–01:00), con transporte **"Vehículo alquilado o Tour guiado"** y nota breve. 
- Evita que actividades en ciudad, posteriores a un “Regreso…”, hereden ese transporte.

🚫 ERRORES A EVITAR
- No devuelvas “seed”.
- No uses frases impersonales (“Esta actividad es…”).
- No incluyas saludos ni explicaciones fuera del JSON.
- No repitas notas idénticas en varias actividades.

Ejemplo de nota motivadora correcta:
“Descubre uno de los rincones más encantadores de la ciudad y disfruta su atmósfera única.”
`.trim();

// ==============================
// Post-proceso defensivo (nuevo)
// ==============================
const AURORA_CITIES = new Set([
  "reykjavik","reykjavik","tromso","tromsø","rovaniemi","abisko","fairbanks",
  "yellowknife","kiruna","alta","akureyri","murmansk","svalbard","ivalo","honningsvag","honningvag"
]);

const AURORA_NOTE =
  "Noche especial de caza de auroras. Con cielos despejados y paciencia, podrás presenciar un espectáculo natural inolvidable. **Regreso según tour. Puedes ir con tour guiado o por tu cuenta; si conduces, infórmate sobre seguridad invernal y nieve nocturna.**";

function auroraNightsFor(totalDays) {
  if (!Number.isFinite(totalDays) || totalDays <= 0) return 1;
  if (totalDays <= 2) return 1;
  if (totalDays <= 4) return 2;
  if (totalDays <= 6) return 3;
  return 4;
}

function injectAurorasIfNeeded(parsed) {
  try {
    if (!parsed) return parsed;

    const cityRaw =
      parsed?.destination ??
      parsed?.destinations?.[0]?.name ??
      "";

    const cityKey = stripAccents(toLower(cityRaw));
    if (!cityKey) return parsed;

    // Aplica sólo en ciudades típicas
    if (!AURORA_CITIES.has(cityKey)) return parsed;

    const rows = getRows(parsed);
    if (!Array.isArray(rows) || rows.length === 0) return parsed;

    // Evitar duplicados si ya hay auroras
    const already = rows.some((r) => {
      const a = toLower(r?.activity);
      const n = toLower(r?.notes);
      return a.includes("aurora") || n.includes("aurora");
    });
    if (already) return parsed;

    const maxDay = rows.reduce((m, r) => {
      const d = Number(r?.day ?? 1);
      return Number.isFinite(d) && d > m ? d : m;
    }, 1);

    const target = auroraNightsFor(maxDay);
    const chosen = [];
    for (let d = 1; d <= maxDay && chosen.length < target; d += 2) chosen.push(d);

    chosen.forEach((dayNum) => {
      rows.push({
        day: dayNum,
        start: "18:00",
        end: "01:00",
        activity: "Caza de auroras boreales",
        from: "Hotel",
        to: "Puntos de observación (variable)",
        transport: "Vehículo alquilado o Tour guiado",
        duration: "≈7h",
        notes: AURORA_NOTE,
      });
    });

    // Ordenamos suavemente por (day,start) sin tirar si falta formato de hora
    const norm = [...rows].sort((a, b) => {
      const da = Number(a?.day ?? 1), db = Number(b?.day ?? 1);
      if (da !== db) return da - db;
      return safeStr(a?.start).localeCompare(safeStr(b?.start));
    });

    setRows(parsed, norm);
    return parsed;
  } catch {
    return parsed;
  }
}

function fixTransportAfterReturn(parsed) {
  try {
    const rows = getRows(parsed);
    if (!Array.isArray(rows) || rows.length === 0) return parsed;

    let returnedByDay = new Map();

    const norm = rows.map((r) => ({ ...r })); // copia superficial
    norm.forEach((r) => {
      const day = Number(r?.day ?? 1);
      const act = stripAccents(toLower(r?.activity));
      const isReturn = act.startsWith("regreso"); // “Regreso a …”
      if (isReturn) {
        returnedByDay.set(day, true);
      } else if (returnedByDay.get(day)) {
        const tr = stripAccents(toLower(r?.transport));
        if (tr.includes("vehiculo alquilado")) {
          r.transport = "A pie o taxi local";
        }
      }
    });

    setRows(parsed, norm);
    return parsed;
  } catch {
    return parsed;
  }
}

// ==============================
// Llamada al modelo (idéntica)
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
// Handler (igual, con post-proceso seguro)
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body;
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    // MODO INFO (texto libre)
    if (mode === "info") {
      const raw = await callStructured(clientMessages);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // MODO PLANNER
    let raw = await callStructured([{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages]);
    let parsed = cleanToJSON(raw);

    if (!(parsed && hasRows(parsed))) {
      const strictPrompt = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve al menos 1 fila en "rows". Nada de meta.`;
      raw = await callStructured([{ role: "system", content: strictPrompt }, ...clientMessages], 0.25);
      parsed = cleanToJSON(raw);
    }

    if (!(parsed && hasRows(parsed))) {
      const ultraPrompt = SYSTEM_PROMPT + `
Ejemplo válido:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
      raw = await callStructured([{ role: "system", content: ultraPrompt }, ...clientMessages], 0.1);
      parsed = cleanToJSON(raw);
    }

    // Post-procesos defensivos (no lanzan excepciones)
    if (parsed && hasRows(parsed)) {
      parsed = injectAurorasIfNeeded(parsed);
      parsed = fixTransportAfterReturn(parsed);
    }

    if (!parsed) parsed = fallbackJSON();
    return res.status(200).json({ text: JSON.stringify(parsed) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    // Nunca devolvemos 500 para no romper el front
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
