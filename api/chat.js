// /api/chat.js — v31.1 (ESM compatible en Vercel) — “ultraquirúrgico” sobre v31.0
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

/** Remueve fences y repara comas colgantes sin alterar contenido válido */
function _prep(raw = "") {
  if (!raw || typeof raw !== "string") return "";
  let t = raw.trim();

  // El modelo a veces envía ```json ... ``` o ``` ... ```
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "");

  // También puede anteponer/posponer texto explicativo
  // (dejamos un intento rápido con regex de bloque JSON balanceado)
  return t;
}

/** Busca el primer bloque JSON balanceado { ... } dentro de un string */
function _extractBalancedJSONObjectString(s = "") {
  const n = s.length;
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;

  for (let i = 0; i < n; i++) {
    const c = s[i];

    if (inStr) {
      if (!esc && c === "\\") { esc = true; continue; }
      if (!esc && c === '"') inStr = false;
      esc = false;
      continue;
    }

    if (c === '"') { inStr = true; continue; }
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      if (depth > 0) depth--;
      if (depth === 0 && start !== -1) {
        return s.slice(start, i + 1);
      }
    }
  }
  return "";
}

/** Intenta parsear JSON con varias estrategias conservadoras */
function cleanToJSON(raw = "") {
  try {
    if (!raw || typeof raw !== "string") return null;

    // 1) Directo
    try { return JSON.parse(raw); } catch {}

    // 2) Sin fences / comas colgantes simples
    let t = _prep(raw).replace(/,\s*([}\]])/g, "$1");
    try { return JSON.parse(t); } catch {}

    // 3) Buscar primer objeto balanceado y parsear
    const blk = _extractBalancedJSONObjectString(t);
    if (blk) {
      try { return JSON.parse(blk); } catch {}
      // 3b) Intento con comas colgantes dentro del bloque
      const repaired = blk.replace(/,\s*([}\]])/g, "$1");
      try { return JSON.parse(repaired); } catch {}
    }

    // 4) Último intento: recortar texto antes/después de llaves
    try {
      const cleaned = raw.replace(/^[^\{]+/, "").replace(/[^\}]+$/, "");
      return JSON.parse(cleaned);
    } catch {}

    return null;
  } catch {
    return null;
  }
}

/** Fallback mínimo seguro (no romper render) */
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
        transport: "A pie",
        duration: "9h",
        notes:
          "Explora libremente la ciudad y descubre sus lugares más emblemáticos.",
      },
    ],
    followup:
      "⚠️ Fallback local: revisa configuración de Vercel o la API Key si esto persiste.",
  };
}

/** Normaliza/asegura el “shape” esperado por el planner */
function coercePlannerShape(parsed) {
  if (!parsed || typeof parsed !== "object") return null;

  // Caso B
  if (Array.isArray(parsed.rows)) return parsed;

  // Caso C => mantenemos “destinations” (el planner ya lo soporta)
  if (Array.isArray(parsed.destinations)) return parsed;

  // Algunos modelos devuelven {destination, itinerary:[...]} u otros campos
  if (Array.isArray(parsed.itinerary)) {
    return { destination: parsed.destination || "Desconocido", rows: parsed.itinerary };
  }
  if (Array.isArray(parsed.items)) {
    return { destination: parsed.destination || "Desconocido", rows: parsed.items };
  }

  // Si sólo hay “rows” sueltas
  if (parsed.rows && typeof parsed.rows === "object") {
    const arr = Array.isArray(parsed.rows) ? parsed.rows : Object.values(parsed.rows);
    return { destination: parsed.destination || "Desconocido", rows: arr };
  }

  // Último recurso: intentar encontrar “rows” dentro de algún campo conocido
  for (const k of Object.keys(parsed)) {
    if (Array.isArray(parsed[k]) && parsed[k].length && parsed[k][0]?.day !== undefined) {
      return { destination: parsed.destination || "Desconocido", rows: parsed[k] };
    }
  }

  return parsed;
}

// ==============================
// Prompt base mejorado ✨ (flex hours, cena no obligatoria, auroras inteligentes,
// transporte dual para day trips si el usuario no lo definió, y tours desglosados)
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
- Horarios **realistas con flexibilidad**: NO asumas una ventana fija (no fuerces 08:30–19:00).
  Si no hay información de horarios, reparte en mañana / mediodía / tarde y, si tiene sentido, extiende la noche (shows, paseos, auroras, cenas).
- **No obligues la cena**: sugiérela sólo cuando aporte valor real.
- La respuesta debe poder renderizarse directamente en una UI web.
- No devuelvas "seed" y evita valores nulos/undefined.

🧭 ESTRUCTURA OBLIGATORIA DE CADA ACTIVIDAD
{
  "day": 1,
  "start": "08:30",
  "end": "10:30",
  "activity": "Nombre claro y específico",
  "from": "Lugar de partida (vacío si no aplica)",
  "to": "Lugar de destino (vacío si no aplica)",
  "transport": "Transporte realista (A pie, Metro, Bus, Tren, Taxi/Uber, Auto, Tour guiado, Ferry, etc.)",
  "duration": "2h",
  "notes": "Descripción motivadora y breve"
}

🧠 ESTILO Y EXPERIENCIA DE USUARIO
- Tono cálido, entusiasta y específico.
- Notas: 1–2 líneas que expliquen por qué la actividad es especial. Varía vocabulario y evita repeticiones.

🌌 AURORAS (si aplica por destino/temporada)
- Sugiere “caza de auroras” sólo cuando sea plausible por destino/época.
- Evita noches consecutivas y **NO** la dejes como única noche en el último día.
- Estancia 4–5+ días: suele ser razonable 2–3 noches no consecutivas (es una guía, no obligación).

🚆 TRANSPORTE Y TIEMPOS
- Usa medios coherentes con el contexto.
- Las horas deben estar ordenadas y no superponerse; incluye tiempos aproximados.
- Si el usuario **no especificó transporte** y la actividad es **fuera de la ciudad (day trip)**,
  asume opciones viables **"Auto (alquilado) o Tour guiado"** (evita bus/tren si no es realista).
- Para **tours/recorridos**, **desglosa paradas/waypoints clave** como filas separadas cuando corresponda
  (ej.: Círculo Dorado: Thingvellir → Geysir → Gullfoss; Costa Sur: Seljalandsfoss → Skógafoss → Reynisfjara → Vík).
- En costa/penínsulas prioriza las horas de **luz**.

📝 EDICIÓN INTELIGENTE
- Si te piden agregar/quitar/ajustar, devuelve el JSON actualizado (B o C) manteniendo secuencia clara y cronológica.

🎨 UX Y NARRATIVA
- Cada día debe fluir como una historia (inicio, desarrollo, cierre).
- Descripciones cortas; claridad y variedad.

🚫 ERRORES A EVITAR
- No uses frases impersonales (“Esta actividad es…”).
- No incluyas saludos ni texto fuera del JSON.
- No repitas notas idénticas.
`.trim();

// ==============================
// Llamada al modelo
// ==============================
async function callStructured(messages, temperature = 0.4) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    input: messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
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
    const mode = body.mode || "planner"; // 👈 modo: "planner" | "info"
    const clientMessages = extractMessages(body);

    // 🧭 MODO INFO CHAT — sin JSON, texto libre
    if (mode === "info") {
      const raw = await callStructured(clientMessages);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // 🧭 MODO PLANNER — comportamiento original con reglas flexibles
    // Pass 1
    let raw = await callStructured([{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages]);
    let parsed = coercePlannerShape(cleanToJSON(raw));

    // Pass 2 — “strict” (baja temperatura) si no llegaron rows/destinations
    const hasRows = parsed && (parsed.rows || parsed.destinations);
    if (!hasRows) {
      const strictPrompt = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve **al menos 1** fila en "rows". Nada de texto fuera del JSON.`;
      raw = await callStructured([{ role: "system", content: strictPrompt }, ...clientMessages], 0.25);
      parsed = coercePlannerShape(cleanToJSON(raw));
    }

    // Pass 3 — ejemplo mínimo si aún no hay JSON válido
    const stillNoRows = !parsed || (!parsed.rows && !parsed.destinations);
    if (stillNoRows) {
      const ultraPrompt = SYSTEM_PROMPT + `
Ejemplo válido:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
      raw = await callStructured([{ role: "system", content: ultraPrompt }, ...clientMessages], 0.1);
      parsed = coercePlannerShape(cleanToJSON(raw));
    }

    // Guard final — nunca devolvemos vacío
    if (!parsed) parsed = fallbackJSON();

    // Entregamos como string para el planner (mantiene contrato actual)
    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
