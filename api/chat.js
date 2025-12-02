// /api/chat.js — v31.2 (ESM compatible en Vercel)
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

function stripCodeFences(text = "") {
  if (typeof text !== "string") return text;
  // remove ```json ... ``` or ``` ... ```
  return text.replace(/^\s*```[\s\S]*?\n/, "").replace(/\n```[\s\S]*?$/m, "").trim();
}

function cleanToJSON(raw = "") {
  if (!raw || typeof raw !== "string") return null;
  const txt = stripCodeFences(raw);
  const attempts = [
    (s) => s,
    (s) => s.replace(/^[^\{]+/, "").replace(/[^\}]+$/, ""),
  ];
  for (const fn of attempts) {
    try {
      return JSON.parse(fn(txt));
    } catch (_) {}
  }
  return null;
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
        transport: "A pie",
        duration: "",
        notes:
          "Explora libremente la ciudad y descubre sus lugares más emblemáticos.",
      },
    ],
    followup: "⚠️ Fallback local: revisa configuración de Vercel o API Key.",
  };
}

/** Normaliza una respuesta del modelo:
 *  - Si viene en formato C (destinations[]), lo transforma a formato B
 *  - Garantiza rows con campos mínimos y day numérico
 */
function normalizeParsed(parsed) {
  if (!parsed || typeof parsed !== "object") return null;

  // Aceptar formato C -> convertir al primero con rows
  if (!parsed.rows && Array.isArray(parsed.destinations)) {
    const first = parsed.destinations.find(
      (d) => Array.isArray(d.rows) && d.rows.length > 0
    );
    if (first) {
      parsed = {
        destination: first.name || first.city || first.destination || "Destino",
        rows: first.rows,
        followup: parsed.followup || "",
      };
    }
  }

  if (!Array.isArray(parsed.rows)) return null;

  // Sanitizar filas
  parsed.rows = parsed.rows
    .map((r, idx) => {
      const dayNum =
        Number.isFinite(+r.day) && +r.day > 0 ? +r.day : 1 + (idx % 5);
      const start = (r.start || "").toString().trim() || "09:00";
      const end = (r.end || "").toString().trim() || "10:00";
      const activity = (r.activity || "").toString().trim() || "Actividad";
      return {
        day: dayNum,
        start,
        end,
        activity,
        from: (r.from || "").toString(),
        to: (r.to || "").toString(),
        transport: (r.transport || "").toString() || "A pie",
        duration: (r.duration || "").toString(),
        notes: (r.notes || "").toString() || "Una parada ideal para disfrutar.",
      };
    })
    .slice(0, 100); // safety

  return parsed;
}

// ==============================
// Prompt base mejorado ✨
// (horarios flex, cena NO obligatoria, auroras inteligentes,
// transporte dual en day trips, desglose de tours por paradas)
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido** que describa un itinerario turístico inspirador y funcional.

📌 FORMATOS VÁLIDOS DE RESPUESTA
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos una actividad en "rows".
- Nada de texto fuera del JSON (sin explicaciones).
- 20 actividades máximo por día.
- Usa horas **realistas con flexibilidad**: NO asumas ventana fija (no fuerces 08:30–19:00).
  Si no hay horarios previos, distribuye lógicamente mañana/mediodía/tarde y, cuando tenga sentido,
  extiende la noche (cenas, shows, paseos, auroras).
- **No obligues la cena**: sugiérela sólo si aporta valor ese día.
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

🌌 AURORAS (si aplica por destino/temporada)
- Sólo proponlas cuando sea plausible.
- **Evita noches consecutivas**.
- **Evita** que la **única** noche de auroras sea el **último día**.
- En estancias de 4–5+ días, es razonable 2–3 noches **no consecutivas** (incentivo suave, no obligatorio).

🚆 TRANSPORTE Y TIEMPOS
- Medios coherentes (a pie, metro, taxi, bus, auto, ferry…).
- Horas ordenadas, **sin solaparse** y con buffers razonables.
- **Si el usuario no indicó transporte y la actividad es fuera de la ciudad (day trip)**:
  usa **"Auto (alquilado) o Tour guiado"** (evita bus/tren si no es viable en el destino).
- Incluye tiempos aproximados de actividad y traslados.

🧭 TOURS / DAY TRIPS — DESGLOSE
- Cuando sea un recorrido típico, **divide en paradas/waypoints clave** como filas separadas.
  Ejemplos:
  • Círculo Dorado: Thingvellir → Geysir → Gullfoss.
  • Costa Sur: Seljalandsfoss → Skógafoss → Reynisfjara → Vík.
  • Whale watching / fiordos: incluye salida, navegación, retorno.
- Prioriza horas de **luz** para costas/penínsulas.

💰 MONETIZACIÓN FUTURA (sin marcas)
- Sugiere actividades naturalmente vinculables a upsells (cafés, museos, experiencias locales) sin precios.

📝 EDICIÓN INTELIGENTE
- Si el usuario pide “agregar un día”, “quitar actividad” o “ajustar horarios”, responde con el itinerario JSON actualizado.
- Mantén secuencia clara y cronológica.

🎨 UX Y NARRATIVA
- Cada día debe fluir como una historia (inicio, desarrollo, cierre).
- Notas cortas y motivadoras; varía el vocabulario.

🚫 ERRORES A EVITAR
- No devuelvas “seed”.
- No uses frases impersonales (“Esta actividad es…”).
- No incluyas saludos ni explicaciones fuera del JSON.
- No repitas notas idénticas en varias actividades.
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
// Exportación ESM
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body || {};
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    // 🧭 MODO INFO CHAT — sin JSON, texto libre
    if (mode === "info") {
      const raw = await callStructured(clientMessages);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // 🧭 MODO PLANNER — con reglas flexibles
    let raw = await callStructured(
      [{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages],
      0.4
    );
    let parsed = normalizeParsed(cleanToJSON(raw));

    // Pass 2: exige al menos 1 row
    const hasRows = parsed && Array.isArray(parsed.rows) && parsed.rows.length > 0;
    if (!hasRows) {
      const strictPrompt =
        SYSTEM_PROMPT +
        `\n\nOBLIGATORIO: Devuelve al menos 1 fila en "rows". Nada de meta.`;
      raw = await callStructured(
        [{ role: "system", content: strictPrompt }, ...clientMessages],
        0.25
      );
      parsed = normalizeParsed(cleanToJSON(raw));
    }

    // Pass 3: ejemplo mínimo
    const stillNoRows = !parsed || !Array.isArray(parsed.rows) || parsed.rows.length === 0;
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
      parsed = normalizeParsed(cleanToJSON(raw));
    }

    if (!parsed) parsed = fallbackJSON();
    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
