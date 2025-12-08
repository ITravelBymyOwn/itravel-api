// /api/info-public.js — v1.0-min
// Info Chat EXTERNO: texto libre. Sin SYSTEM, sin sanitizar, sin contexto.
// Siempre responde { text: "..." }.

import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function parseBody(b) {
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch { return {}; } }
  return b;
}

// Igual que v30.2: si ya traen messages, se pasan tal cual.
// Si no, usamos `input` o `history` (sin `context`).
function extractMessages(body = {}) {
  const { messages, input, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;
  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";
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
  return resp?.output_text?.trim()
      || resp?.output?.[0]?.content?.[0]?.text?.trim()
      || "";
}

export default async function handler(req, res) {
  try {
    // CORS básicos
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

    const body = parseBody(req.body);
    const messages = extractMessages(body);

    const hasUser = messages.some(m => m.role === "user" && String(m.content || "").trim());
    if (!hasUser) {
      return res.status(200).json({
        text: "Escríbeme tu duda de viaje (clima, transporte, costos, auroras, etc.)."
      });
    }

    // 🔁 Comportamiento idéntico al mode:"info" de v30.2
    const raw  = await callText(messages);
    const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
    return res.status(200).json({ text });
  } catch (err) {
    console.error("❌ /api/info-public error:", err);
    return res.status(200).json({
      text: "No pude traer la respuesta del Info Chat correctamente. Verifica tu API Key/URL en Vercel o vuelve a intentarlo."
    });
  }
}
