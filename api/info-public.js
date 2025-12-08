// /api/info-public.js — v1.1.3 (ESM, Vercel)
// Info Chat EXTERNO: responde preguntas random de viaje (TEXTO corto).
// Responde siempre { text: "..." } para no romper la UI (nunca JSON en el contenido).

import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== Utils =====
function parseBody(reqBody) {
  if (!reqBody) return {};
  if (typeof reqBody === "string") {
    try { return JSON.parse(reqBody); } catch { return {}; }
  }
  return reqBody;
}
function extractMessages(body = {}) {
  const { messages, input, query, history, context } = body;
  if (Array.isArray(messages) && messages.length) return messages;

  const prev = Array.isArray(history) ? history : [];
  const userText =
    typeof input === "string" ? input :
    typeof query === "string" ? query : "";

  const ctxMsg = context
    ? [{ role: "system", content: `Contexto adicional (opcional): ${JSON.stringify(context)}` }]
    : [];

  return [...ctxMsg, ...prev, { role: "user", content: userText }];
}
async function callText(messages, temperature = 0.35, max_output_tokens = 700) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    max_output_tokens,
    input: messages.map(m =>
      `${m.role.toUpperCase()}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`
    ).join("\n\n"),
  });
  return resp?.output_text?.trim()
      || resp?.output?.[0]?.content?.[0]?.text?.trim()
      || "";
}
function looksLikeJSON(s) {
  if (!s || typeof s !== "string") return false;
  const t = s.trim();
  return t.startsWith("{") || t.startsWith("[") || /^```json/i.test(t);
}
function sanitizeText(s) {
  if (!s || typeof s !== "string") return s;
  let out = s.trim();
  if (out.startsWith("```")) {
    out = out.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  }
  if (looksLikeJSON(out)) out = "Aquí tienes la respuesta en términos prácticos (sin formato técnico).";
  return out;
}

// ===== Prompt (texto corto, sin JSON) =====
const SYSTEM_INFO_PUBLIC = `
Eres **Astra · Info Chat** para viajeros. Responde **solo TEXTO**, breve y útil.
- Idioma: usa el del usuario (fallback: español).
- Estilo: concreto; máx. ~10–12 líneas. Viñetas si ayudan.
- Incluye datos prácticos: horarios típicos, transporte, costos aproximados, clima, seguridad.
- Auroras (si preguntan): meses probables, ventana típica de observación y advertencias.
- Si recomiendas buscar algo, indica términos de búsqueda (sin enlaces con tracking).
- No devuelvas JSON ni bloques de código.
`.trim();

const SYSTEM_INFO_PUBLIC_STRICT = (base) => `
${base}

OBLIGATORIO:
- Entrega únicamente TEXTO plano (sin JSON, sin code fences).
- Nada de objetos { ... } ni arrays [ ... ].
`.trim();

// ===== CORS =====
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// ===== Handler =====
export default async function handler(req, res) {
  try {
    setCORS(res);
    res.setHeader("Content-Type","application/json; charset=utf-8");

    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    // 🔎 Diagnóstico rápido de env antes de llamar a OpenAI
    if (!process.env.OPENAI_API_KEY || String(process.env.OPENAI_API_KEY).trim() === "") {
      return res.status(200).json({
        text: "Diagnóstico: Falta OPENAI_API_KEY en el proyecto `itravelbymyown-api` (Production). " +
              "Configúrala en Vercel → Project → Settings → Environment Variables y redeploy."
      });
    }

    const body = parseBody(req.body);
    const clientMessages = extractMessages(body);

    const hasUser = clientMessages.some(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.trim().length > 0
    );
    if (!hasUser) {
      return res.status(200).json({
        text: "Escríbeme tu duda de viaje (clima, transporte, costos, auroras, etc.) y te respondo al instante."
      });
    }

    let raw = await callText(
      [{ role: "system", content: SYSTEM_INFO_PUBLIC }, ...clientMessages],
      0.35,
      700
    );
    if (looksLikeJSON(raw)) {
      raw = await callText(
        [{ role: "system", content: SYSTEM_INFO_PUBLIC_STRICT(SYSTEM_INFO_PUBLIC) }, ...clientMessages],
        0.3,
        650
      );
    }

    const safe = sanitizeText(raw);
    const text = safe && safe.length > 0
      ? safe
      : "No pude obtener una respuesta ahora. Verifica tu API Key/URL en Vercel e inténtalo de nuevo.";

    return res.status(200).json({ text });

  } catch (err) {
    // 🔎 Mensaje de error con pista (status/message) sin exponer secretos
    console.error("❌ /api/info-public error:", err);
    const status = err?.status || err?.response?.status;
    const message = err?.message || err?.response?.data?.error || "Unknown error";
    return res.status(200).json({
      text: `No pude traer la respuesta del Info Chat. Pista: status=${status ?? "?"}, msg="${String(message)}". `
          + `Revisa la variable OPENAI_API_KEY y los logs de Vercel.`
    });
  }
}
