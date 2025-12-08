// /api/info-public.js — v1.1.1 (ESM, Vercel)
// Info Chat EXTERNO: responde preguntas random de viaje (texto corto).
// Siempre responde { text: "..." } para no romper la UI. Nada de JSON en el contenido.

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

  // Si ya vienen messages, se respetan tal cual
  if (Array.isArray(messages) && messages.length) return messages;

  const prev = Array.isArray(history) ? history : [];
  const userText =
    typeof input === "string" ? input
    : typeof query === "string" ? query
    : "";

  // El contexto (si llega) solo se pasa como ayudante, sin reglas del planner
  const ctxMsg = context
    ? [{ role: "system", content: `Contexto adicional (opcional): ${JSON.stringify(context)}` }]
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

// Sanitizador: garantiza salida en TEXTO (sin JSON ni code fences)
function sanitizeText(s) {
  if (!s || typeof s !== "string") return s;
  let out = s.trim();

  // Quitar fences ```...```
  if (out.startsWith("```")) {
    out = out.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  }

  // Si parece JSON, lo convertimos a resumen plano
  if (/^[\[{]/.test(out)) {
    out = `Resumen:\n${out}`;
  }

  return out;
}

// ====== Prompt del Info Chat EXTERNO (simple, sin reglas de itinerario) ======
const SYSTEM_INFO_PUBLIC = `
Eres **Astra · Info Chat** para viajeros. Responde **solo texto**, breve y útil.
- Idioma: el mismo del usuario (si no se detecta, usa español).
- Estilo: concreto; máximo ~10–12 líneas. Usa viñetas cuando ayuden.
- Incluye datos prácticos cuando aplique: rangos horarios, opciones de transporte, costos aproximados, clima típico, seguridad.
- Auroras (si preguntan): meses probables, ventana nocturna típica y advertencias de clima/seguridad.
- Si sugieres buscar algo, di **qué términos** usar (sin enlaces con tracking).
- No devuelvas JSON ni bloques de código.
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
    res.setHeader("Content-Type","application/json; charset=utf-8");

    if (req.method === "OPTIONS") {
      return res.status(200).end();
    }
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
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

    const raw = await callText(
      [{ role: "system", content: SYSTEM_INFO_PUBLIC }, ...clientMessages],
      0.35,
      700
    );

    const safe = sanitizeText(raw);
    const text = safe && safe.length > 0
      ? safe
      : "No pude obtener una respuesta ahora. Verifica tu API Key/URL en Vercel e inténtalo de nuevo.";

    return res.status(200).json({ text });
  } catch (err) {
    console.error("❌ /api/info-public error:", err);
    return res.status(200).json({
      text: "No pude traer la respuesta del Info Chat correctamente. Verifica tu API Key/URL en Vercel o vuelve a intentarlo."
    });
  }
}
