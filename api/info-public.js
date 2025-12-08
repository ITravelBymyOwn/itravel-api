// /api/info-public.js — v1.3 (ESM, Vercel)
// Info Chat EXTERNO: responde preguntas de viaje en texto libre (idéntico al modo "info" del planner).
// Siempre responde { text: "..." } sin JSON ni reglas adicionales.

import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// =============== Utils ===============
function parseBody(reqBody) {
  if (!reqBody) return {};
  if (typeof reqBody === "string") {
    try { return JSON.parse(reqBody); } catch { return {}; }
  }
  return reqBody;
}

function extractMessages(body = {}) {
  const { messages, input, query, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;

  const prev = Array.isArray(history) ? history : [];
  const userText =
    typeof input === "string" ? input
    : typeof query === "string" ? query
    : "";

  return [...prev, { role: "user", content: userText }];
}

async function callText(messages, temperature = 0.35, max_output_tokens = 800) {
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

// =============== Handler ===============
export default async function handler(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = parseBody(req.body);
    const clientMessages = extractMessages(body);

    const hasUser = clientMessages.some(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.trim().length > 0
    );
    if (!hasUser) {
      return res.status(200).json({
        text: "Escríbeme una pregunta concreta (clima, transporte, costos, auroras, etc.) y te respondo al instante."
      });
    }

    // 🧭 Simplemente pedimos texto, igual que el modo "info" del v30.2
    const raw = await callText(clientMessages);
    const text = raw || "⚠️ No se obtuvo respuesta del asistente.";

    return res.status(200).json({ text });
  } catch (err) {
    console.error("❌ /api/info-public error:", err);
    return res.status(200).json({
      text: "No pude traer la respuesta del Info Chat correctamente. Verifica tu API Key/URL en Vercel o vuelve a intentarlo."
    });
  }
}
