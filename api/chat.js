// /api/chat.js — v4 (estricto B/C + fallback servidor con días/horas del intake)
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ==============================
   Utilidades de request
============================== */
function extractMessages(body = {}) {
  const { messages, input, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;
  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";
  return [...prev, { role: "user", content: userText }];
}

function cleanToJSON(raw = "") {
  let s = (raw || "").trim();
  if (!s) return null;

  if (/```json/i.test(s)) s = s.replace(/```json|```/gi, "").trim();
  else if (s.startsWith("```") && s.endsWith("```")) s = s.slice(3, -3).trim();

  try { return JSON.parse(s); } catch (_) {}

  const m = s.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (m) {
    try { return JSON.parse(m[1]); } catch (_) {}
  }
  return null;
}

/* ==============================
   Heurísticas para leer pistas del intake enviado por el front
============================== */
// 1) Busca el bloque "Per-day hours (resolved): { ... }" que manda el front (v22)
function parsePerDayMapFromMessages(msgs = []) {
  const joined = msgs.map(m => m?.content || "").join("\n");
  const tag = "Per-day hours (resolved):";
  const idx = joined.indexOf(tag);
  if (idx === -1) return {};
  const after = joined.slice(idx + tag.length).trim();
  // Tomar primer JSON válido que aparezca
  const m = after.match(/(\{[\s\S]*\})/);
  if (!m) return {};
  try { return JSON.parse(m[1]); } catch (_) { return {}; }
}

// 2) Mapa ciudad -> días a partir de "Destinations: ... (País · N días"
function parseCityDaysMapFromMessages(msgs = []) {
  const joined = msgs.map(m => m?.content || "").join("\n");
  const map = {};
  const re = /\(([^\)]+?)·\s*(\d+)\s*días/gi; // captura "· 3 días"
  // Leemos por cada "(... · N días" que aparezca; cerca estará el nombre de ciudad antes del "("
  // Buscamos pares "NombreCiudad (" hacia atrás por línea
  const lines = joined.split("\n");
  for (const line of lines) {
    // Ej: "Barcelona (España · 3 días, start=20/10...)" --> ciudad = "Barcelona"
    const mCity = line.match(/([A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s'’-]+)\s*\(/);
    const mDays = line.match(/\(\s*[^)]*?·\s*(\d+)\s*días/);
    if (mCity && mDays) {
      const city = mCity[1].trim();
      const days = parseInt(mDays[1], 10);
      if (city && Number.isFinite(days)) map[city] = days;
    }
  }
  return map;
}

// 3) Ciudad objetivo (el front suele inyectar en el prompt JSON ejemplo con "destination":"City")
function parseTargetCityFromMessages(msgs = []) {
  const joined = msgs.map(m => m?.content || "").join("\n");
  let m = joined.match(/"destination":"([^"]+)"/);
  if (m && m[1]) return m[1].trim();
  // Alternativa: línea tipo Genera el itinerario SOLO para "Ciudad"
  m = joined.match(/Genera (?:el )?itinerario .*? para "([^"]+)"/i);
  if (m && m[1]) return m[1].trim();
  return null;
}

/* ==============================
   Fallback mínimo (cuando no llega JSON)
============================== */
function fallbackMeta() {
  return {
    meta: {
      city: "Desconocido",
      baseDate: new Date().toLocaleDateString("es-ES"),
      start: ["08:30"],
      end: "19:00",
      hotel: "",
    },
    followup:
      "No se recibió información de itinerario, se devolvió estructura base (meta).",
    _no_itinerary_rows: true,
  };
}

/* ==============================
   Prompts de sistema
============================== */
const SYSTEM_PROMPT_FLEX = `
Eres el planificador de viajes inteligente de ITravelByMyOwn (nivel concierge premium),
con la misma capacidad de razonamiento y generación de itinerarios que ChatGPT.

Debes devolver SIEMPRE **JSON válido** (sin texto extra), en uno de estos formatos:

B) {"destination":"City","rows":[{"day":1,"start":"HH:MM","end":"HH:MM","activity":"Texto","from":"","to":"","transport":"","duration":"","notes":""}],"followup":"Texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"Texto breve"}
A) {"meta":{"city":"Nombre","baseDate":"DD/MM/YYYY","start":["HH:MM"],"end":"HH:MM","hotel":"Texto"},"followup":"Texto breve"}

⚠️ Prioriza SIEMPRE B o C si el usuario ha indicado destino(s), fechas, horarios o ha solicitado generar/actualizar itinerarios.
Usa A SOLO si no hay información suficiente.

Reglas:
- Si el usuario da horarios start/end → úsalos exactamente.
- Si NO da horarios → usa 08:30–19:00 por defecto.
- Genera/ajusta itinerarios por días consecutivos desde baseDate (si existe).
- Incluye traslados realistas (transport, duration con ~15% colchón).
- Optimiza rutas y orden; prioriza IMPERDIBLES.
- No uses markdown. SOLO JSON.
`.trim();

const SYSTEM_PROMPT_STRICT_B = `
Eres un planificador que debe devolver SOLO itinerarios en formato B o C (NO metas).
Devuelve **únicamente JSON** y asegúrate de que exista **al menos 1 fila por día** solicitado.

Formato B:
{"destination":"City","rows":[{"day":1,"start":"HH:MM","end":"HH:MM","activity":"Texto","from":"","to":"","transport":"","duration":"","notes":""}],"followup":"Texto breve"}

Reglas estrictas:
- Si hay horas por día, respétalas; si faltan, usa 08:30–19:00.
- Añade traslados con transport + duration (+15%).
- No incluyas texto fuera del JSON. No devuelvas meta.
`.trim();

/* ==============================
   Intención "itinerario"
============================== */
function isItineraryRequest(messages = []) {
  if (!messages.length) return false;
  const last = (messages[messages.length - 1].content || "").toLowerCase();
  return (
    last.includes("devuelve formato b") ||
    last.includes("devuelve formato c") ||
    last.includes("destination") ||
    last.includes("perday") ||
    last.includes("itinerario") ||
    last.includes("rows") ||
    last.includes("generar") ||
    last.includes("planificar")
  );
}

/* ==============================
   Llamada al modelo
============================== */
async function completeJSON(messages, options = {}) {
  const model = options.model || "gpt-4o-mini";
  const temperature = options.temperature ?? 0.5;
  const system = options.strict ? SYSTEM_PROMPT_STRICT_B : SYSTEM_PROMPT_FLEX;

  const msgs = [
    { role: "system", content: system },
    ...messages.filter(m => m && m.role && m.content != null),
  ];

  const resp = await client.chat.completions.create({
    model,
    temperature,
    top_p: 0.9,
    messages: msgs,
    response_format: { type: "json_object" },
    max_tokens: 2500,
  });

  return resp.choices?.[0]?.message?.content?.trim() || "";
}

/* ==============================
   Fallback servidor: generar B con una fila por día
============================== */
function synthesizeB(messages) {
  const perDayMap = parsePerDayMapFromMessages(messages); // { City: [{day,start,end}, ...] }
  const daysMap   = parseCityDaysMapFromMessages(messages); // { City: N }
  const target    = parseTargetCityFromMessages(messages) || Object.keys(perDayMap)[0] || Object.keys(daysMap)[0] || "General";

  const perDay = Array.isArray(perDayMap[target]) ? perDayMap[target] : [];
  const days   = daysMap[target] || (perDay.length || 1);

  const rows = [];
  for (let d = 1; d <= days; d++) {
    const start = perDay[d-1]?.start || "08:30";
    const end   = perDay[d-1]?.end   || "19:00";
    rows.push({
      day: d,
      start,
      end,
      activity: `Día ${d} — actividad sugerida`,
      from: "",
      to: "",
      transport: "",
      duration: "",
      notes: "(generado por servidor — mínimo viable)"
    });
  }

  return {
    destination: target,
    rows,
    followup: "Itinerario mínimo generado en el servidor por ausencia de filas del modelo."
  };
}

/* ==============================
   Handler principal
============================== */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body || {};
    const clientMessages = extractMessages(body);

    const itineraryMode = body.force_itinerary === true
      ? true
      : isItineraryRequest(clientMessages);

    // 1) Intento flexible
    let raw = await completeJSON(clientMessages, {
      model: body?.model || "gpt-4o-mini",
      strict: false
    });
    let parsed = cleanToJSON(raw);

    // 2) Si esperamos itinerario y no hay rows → intento estricto (prohíbe meta)
    const lacksRows = !parsed || (!parsed.rows && !parsed.destinations);
    if (itineraryMode && lacksRows) {
      const strictMsgs = [
        { role: "system", content: SYSTEM_PROMPT_STRICT_B },
        ...clientMessages,
      ];
      raw = await completeJSON(strictMsgs, {
        model: body?.model || "gpt-4o-mini",
        temperature: 0.3,
        strict: true
      });
      parsed = cleanToJSON(raw);
    }

    // 3) Si sigue sin rows → sintetizar B en el servidor (mejor que meta)
    if (!parsed || (!parsed.rows && !parsed.destinations)) {
      parsed = synthesizeB(clientMessages);
    }

    // 4) Último recurso (nunca debería llegar si synthesizeB retornó algo)
    if (!parsed) parsed = fallbackMeta();

    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (error) {
    console.error("❌ Error en /api/chat.js:", error);
    return res.status(500).json({
      error: "Error interno del servidor. Verifica la configuración del modelo o tu API Key.",
    });
  }
}
