// /api/info-public.js — v1.0.1 (ESM, Vercel)
// Endpoint exclusivo para el Info Chat externo (widget flotante y botón superior).
// Responde SIEMPRE en formato { text: "..." } para no romper la UI del planner.

import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====== Utils ======
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
    typeof input === "string" ? input
    : typeof query === "string" ? query
    : "";

  // Si viene un "context" (datos del planner), lo anteponemos como system helper
  const ctxMsg = context
    ? [{ role: "system", content: `Contexto del planner (si aplica): ${JSON.stringify(context)}` }]
    : [];

  return [
    ...ctxMsg,
    ...prev,
    { role: "user", content: userText }
  ];
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

  return (
    resp?.output_text?.trim() ||
    resp?.output?.[0]?.content?.[0]?.text?.trim() ||
    ""
  );
}

// ====== Prompt del Info Chat externo ======
const SYSTEM_INFO_PUBLIC = `
Eres **Astra · Info Chat** para viajeros. Responde de forma breve, clara y útil.
- Idioma: responde en el mismo idioma del usuario (si no se detecta, usa español).
- Sé específico y práctico (rangos horarios, ejemplos de transporte, costos aproximados, clima típico).
- Si la pregunta es sobre auroras: indica meses probables, ventanas horarias y advertencias de clima/seguridad.
- Evita enlaces con seguimiento. Si sugieres búsqueda, di qué buscar (términos concretos).
- No devuelvas JSON, solo texto legible; máximo ~12 líneas. Usa viñetas cuando ayuden.
`.trim();

// ====== CORS helper ======
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// ====== Handler ======
export default async function handler(req, res) {
  try {
    setCORS(res);

    if (req.method === "OPTIONS") {
      return res.status(200).end();
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = parseBody(req.body);
    const clientMessages = extractMessages(body);

    // ✅ FIX: validar tipo antes de usar .trim() para evitar errores cuando content no es string
    const hasUser = clientMessages.some(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.trim().length > 0
    );

    if (!hasUser) {
      return res.status(200).json({
        text: "Escríbeme una pregunta concreta (clima, transporte, costos, auroras, etc.) y te respondo al instante."
      });
    }

    const raw = await callText(
      [{ role: "system", content: SYSTEM_INFO_PUBLIC }, ...clientMessages],
      0.35,
      700
    );

    const text = raw && raw.length > 0
      ? raw
      : "No pude obtener una respuesta ahora. Verifica tu API Key/URL en Vercel e inténtalo de nuevo.";

    return res.status(200).json({ text });
  } catch (err) {
    console.error("❌ /api/info-public error:", err);
    return res.status(200).json({
      text: "No pude traer la respuesta del Info Chat correctamente. Verifica tu API Key/URL en Vercel o vuelve a intentarlo."
    });
  }
}
