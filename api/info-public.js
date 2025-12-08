// /api/info-public.js — v1.2.0 (ESM, Vercel)
// Info Chat EXTERNO (idéntico al "modo info" de v30.2):
// - Sin reglas del planner.
// - No exige JSON; devuelve SIEMPRE { text: "<respuesta en texto>" }.
// - Solo POST (GET devuelve 405). CORS habilitado.

import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// =========== Utils ===========
function parseBody(reqBody) {
  if (!reqBody) return {};
  if (typeof reqBody === "string") {
    try { return JSON.parse(reqBody); } catch { return {}; }
  }
  return reqBody;
}

function extractMessages(body = {}) {
  // Igual a v30.2 pero aceptando también `query`
  const { messages, input, query, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;

  const prev = Array.isArray(history) ? history : [];
  const userText =
    typeof input === "string" ? input :
    typeof query === "string" ? query : "";

  return [...prev, { role: "user", content: userText }];
}

async function callText(messages, temperature = 0.4, max_output_tokens = 700) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    max_output_tokens,
    input: messages
      .map(m => `${m.role.toUpperCase()}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
      .join("\n\n"),
  });

  return (
    resp?.output_text?.trim() ||
    resp?.output?.[0]?.content?.[0]?.text?.trim() ||
    ""
  );
}

function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// =========== Handler ===========
export default async function handler(req, res) {
  try {
    setCORS(res);
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") {
      // Igual que v30.2: GET/otros métodos no están permitidos
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Diagnóstico rápido de variable de entorno
    if (!process.env.OPENAI_API_KEY || String(process.env.OPENAI_API_KEY).trim() === "") {
      return res.status(200).json({
        text: "Diagnóstico Info Chat: falta OPENAI_API_KEY en el proyecto `itravelbymyown-api` (Production/Preview). " +
              "Configúrala en Vercel → Project → Settings → Environment Variables y vuelve a desplegar."
      });
    }

    const body = parseBody(req.body);
    const messages = extractMessages(body);

    const hasUser = messages.some(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.trim().length > 0
    );
    if (!hasUser) {
      return res.status(200).json({
        text: "Escríbeme tu duda de viaje (clima, transporte, costos, auroras, etc.) y te respondo al instante."
      });
    }

    // Mismo comportamiento que v30.2 "mode=info": sin system prompt adicional
    const raw = await callText(messages, 0.4, 700);
    const text = raw && raw.length > 0
      ? raw
      : "⚠️ No se obtuvo respuesta del asistente. Verifica tu API Key/URL en Vercel e inténtalo de nuevo.";

    return res.status(200).json({ text });

  } catch (err) {
    console.error("❌ /api/info-public error:", err);
    const status = err?.status || err?.response?.status;
    const msg = err?.message || err?.response?.data?.error || "Unknown error";
    return res.status(200).json({
      text: `No pude traer la respuesta del Info Chat. Pista: status=${status ?? "?"}, msg="${String(msg)}".`
    });
  }
}
