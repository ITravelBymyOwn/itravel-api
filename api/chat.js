// /api/chat.js — v5 (Itinerarios forzados en formato B/C — sin opción meta)
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
   Parseo auxiliar desde mensajes
============================== */
function parsePerDayMapFromMessages(msgs = []) {
  const joined = msgs.map(m => m?.content || "").join("\n");
  const tag = "Per-day hours (resolved):";
  const idx = joined.indexOf(tag);
  if (idx === -1) return {};
  const after = joined.slice(idx + tag.length).trim();
  const m = after.match(/(\{[\s\S]*\})/);
  if (!m) return {};
  try { return JSON.parse(m[1]); } catch (_) { return {}; }
}

function parseCityDaysMapFromMessages(msgs = []) {
  const joined = msgs.map(m => m?.content || "").join("\n");
  const map = {};
  const lines = joined.split("\n");
  for (const line of lines) {
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

function parseTargetCityFromMessages(msgs = []) {
  const joined = msgs.map(m => m?.content || "").join("\n");
  let m = joined.match(/"destination":"([^"]+)"/);
  if (m && m[1]) return m[1].trim();
  m = joined.match(/Genera (?:el )?itinerario .*? para "([^"]+)"/i);
  if (m && m[1]) return m[1].trim();
  return null;
}

/* ==============================
   Prompt ÚNICO (sin opción A)
============================== */
const SYSTEM_PROMPT_STRICT = `
Eres el planificador de viajes inteligente de ITravelByMyOwn (nivel concierge premium),
con la misma capacidad de razonamiento que ChatGPT.

Tu única misión es devolver **únicamente JSON válido** en uno de estos dos formatos:

B) {"destination":"City","rows":[{"day":1,"start":"HH:MM","end":"HH:MM","activity":"Texto","from":"","to":"","transport":"","duration":"","notes":""}],"followup":"Texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"Texto breve"}

❌ No está permitido devolver ningún otro formato (ni texto libre, ni meta).
✅ Siempre debes generar un itinerario completo con actividades y horarios.

Reglas estrictas:
- Si se dan horarios start/end → úsalos exactamente.
- Si no hay horarios → usa 08:30–19:00.
- Genera itinerarios por cada día indicado.
- Incluye traslados realistas (transport, duration con ~15% de buffer).
- Prioriza actividades imperdibles, emblemáticas, históricas y naturales.
- No uses markdown ni explicación fuera del JSON.
- Si la información del usuario es limitada, **inventa actividades realistas** para completar el itinerario.
`.trim();

/* ==============================
   Intención de itinerario
============================== */
function isItineraryRequest(messages = []) {
  if (!messages.length) return false;
  const last = (messages[messages.length - 1].content || "").toLowerCase();
  return (
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
  const temperature = options.temperature ?? 0.6;
  const msgs = [
    { role: "system", content: SYSTEM_PROMPT_STRICT },
    ...messages.filter(m => m && m.role && m.content != null),
  ];
  const resp = await client.chat.completions.create({
    model,
    temperature,
    top_p: 0.9,
    messages: msgs,
    response_format: { type: "json_object" },
    max_tokens: 3000,
  });
  return resp.choices?.[0]?.message?.content?.trim() || "";
}

/* ==============================
   Fallback servidor si el modelo falla
============================== */
function synthesizeB(messages) {
  const perDayMap = parsePerDayMapFromMessages(messages);
  const daysMap = parseCityDaysMapFromMessages(messages);
  const target =
    parseTargetCityFromMessages(messages) ||
    Object.keys(perDayMap)[0] ||
    Object.keys(daysMap)[0] ||
    "General";

  const perDay = Array.isArray(perDayMap[target]) ? perDayMap[target] : [];
  const days = daysMap[target] || (perDay.length || 1);

  const rows = [];
  for (let d = 1; d <= days; d++) {
    const start = perDay[d - 1]?.start || "08:30";
    const end = perDay[d - 1]?.end || "19:00";
    rows.push({
      day: d,
      start,
      end,
      activity: `Día ${d} — actividad sugerida`,
      from: "",
      to: "",
      transport: "",
      duration: "",
      notes: "(generado por servidor — mínimo viable)",
    });
  }

  return {
    destination: target,
    rows,
    followup: "Itinerario mínimo generado en el servidor por ausencia de filas del modelo.",
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

    // Primer intento — ya estricto
    let raw = await completeJSON(clientMessages, {
      model: body?.model || "gpt-4o-mini",
    });
    let parsed = cleanToJSON(raw);

    // Si no hay filas → fallback server
    if (itineraryMode && (!parsed || (!parsed.rows && !parsed.destinations))) {
      parsed = synthesizeB(clientMessages);
    }

    // Último recurso si todo falla
    if (!parsed) {
      parsed = synthesizeB(clientMessages);
    }

    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (error) {
    console.error("❌ Error en /api/chat.js:", error);
    return res.status(500).json({
      error: "Error interno del servidor. Verifica la configuración del modelo o tu API Key.",
    });
  }
}
