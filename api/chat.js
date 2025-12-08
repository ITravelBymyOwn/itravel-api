// /api/chat.js — v42.5.1 (ESM, Vercel)
// Doble etapa: (1) INFO (investiga y calcula) → (2) PLANNER (estructura).
// Respeta estrictamente preferencias/condiciones del usuario. Salidas SIEMPRE en { text: "<JSON|texto>" }.

import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// =============== Utilidades comunes ===============
function parseBody(reqBody) {
  if (!reqBody) return {};
  if (typeof reqBody === "string") {
    try { return JSON.parse(reqBody); } catch { return {}; }
  }
  return reqBody;
}
function extractMessages(body = {}) {
  const { messages, input, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;
  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";
  return [...prev, { role: "user", content: userText }];
}
function cleanToJSONPlus(raw = "") {
  if (!raw || typeof raw !== "string") return null;
  try { return JSON.parse(raw); } catch {}
  try {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(raw.slice(first, last + 1));
    }
  } catch {}
  try {
    const cleaned = raw.replace(/^[^{]+/, "").replace(/[^}]+$/, "");
    return JSON.parse(cleaned);
  } catch {}
  return null;
}
function fallbackJSON() {
  return {
    destination: "Desconocido",
    rows: [
      {
        day: 1,
        start: "08:30",
        end: "19:00",
        activity: "Itinerario base (fallback)",
        from: "",
        to: "",
        transport: "",
        duration: "",
        notes: "Explora libremente la ciudad.",
      },
    ],
    followup: "⚠️ Fallback local: revisa OPENAI_API_KEY o ancho de banda.",
  };
}
async function callText(messages, temperature = 0.4, max_output_tokens = 3000) {
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

// 🆕 Normalizador ligero de duraciones dentro del JSON ya parseado
function normalizeDurationsInParsed(parsed){
  if(!parsed) return parsed;
  const norm = (txt)=>{
    const s = String(txt||'').trim();
    if(!s) return s;
    const dh = s.match(/^(\d+(?:\.\d+)?)\s*h$/i);
    const hMix = s.match(/^(\d+)h(\d{1,2})$/i);
    if(dh){
      const hours = parseFloat(dh[1]);
      const total = Math.round(hours*60);
      const h = Math.floor(total/60);
      const m = total%60;
      return h>0 ? (m>0 ? `${h}h${m}m` : `${h}h`) : `${m}m`;
    }
    if(hMix){
      return `${hMix[1]}h${hMix[2]}m`;
    }
    return s;
  };
  const touchRows = (rows=[]) => rows.map(r=>({ ...r, duration: norm(r.duration) }));
  try{
    if(Array.isArray(parsed.rows)) parsed.rows = touchRows(parsed.rows);
    if(Array.isArray(parsed.destinations)){
      parsed.destinations = parsed.destinations.map(d=>({
        ...d,
        rows: Array.isArray(d.rows) ? touchRows(d.rows) : d.rows
      }));
    }
    if(Array.isArray(parsed.itineraries)){
      parsed.itineraries = parsed.itineraries.map(it=>({
        ...it,
        rows: Array.isArray(it.rows) ? touchRows(it.rows) : it.rows
      }));
    }
  }catch{}
  return parsed;
}

// =============== Prompts del sistema ===============

// 1) SISTEMA — INFO CHAT
const SYSTEM_INFO = `
Eres el **motor de investigación** de ITravelByMyOwn (Info Chat).
[...SIN CAMBIOS AL PROMPT...]
`.trim();

// 2) SISTEMA — PLANNER
const SYSTEM_PLANNER = `
Eres **Astra Planner**. Recibes "research_json" del Info Chat con datos fácticos
[...SIN CAMBIOS AL PROMPT...]
`.trim();

// =============== Handler principal ===============
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = parseBody(req.body);
    const mode = (body.mode || "planner").toLowerCase();

    // -------------------- MODO INFO --------------------
    if (mode === "info") {
      const context = body.context || {};
      const infoUserMsg = { role: "user", content: JSON.stringify({ context }, null, 2) };

      let raw = await callText([{ role: "system", content: SYSTEM_INFO }, infoUserMsg], 0.35, 3500);
      let parsed = cleanToJSONPlus(raw);

      if (!parsed) {
        const strict = SYSTEM_INFO + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, infoUserMsg], 0.2, 3200);
        parsed = cleanToJSONPlus(raw);
      }

      if (!parsed) parsed = {
        destination: context.city || "Destino",
        country: context.country || "",
        days_total: context.days_total || 1,
        hotel_base: context.hotel_address || "",
        rationale: "Fallback mínimo.",
        imperdibles: [],
        macro_tours: [],
        in_city_routes: [],
        meals_suggestions: [],
        aurora: {
          plausible: false,
          suggested_days: [],
          window_local: { start: "", end: "" },
          transport_default: "",
          note: "Actividad sujeta a clima; depende del tour",
          duration: "Depende del tour o horas que dediques si vas por tu cuenta"
        },
        constraints: { max_substops_per_tour: 8, respect_user_preferences_and_conditions: true }
      };

      // 🆕 normalización suave
      parsed = normalizeDurationsInParsed(parsed);

      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    // -------------------- MODO PLANNER --------------------
    if (mode === "planner") {
      const research = body.research_json || null;

      // Camino legado (mensajes)
      if (!research) {
        const clientMessages = extractMessages(body);
        let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, ...clientMessages], 0.35, 3500);
        let parsed = cleanToJSONPlus(raw);
        if (!parsed) {
          const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo un JSON válido.`;
          raw = await callText([{ role: "system", content: strict }, ...clientMessages], 0.2, 3000);
          parsed = cleanToJSONPlus(raw);
        }
        if (!parsed) parsed = fallbackJSON();

        // 🆕 normalización suave
        parsed = normalizeDurationsInParsed(parsed);

        return res.status(200).json({ text: JSON.stringify(parsed) });
      }

      // Camino nuevo (research_json)
      const plannerUserMsg = { role: "user", content: JSON.stringify({ research_json: research }, null, 2) };

      let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, plannerUserMsg], 0.35, 3500);
      let parsed = cleanToJSONPlus(raw);

      if (!parsed) {
        const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, plannerUserMsg], 0.2, 3000);
        parsed = cleanToJSONPlus(raw);
      }

      if (!parsed) parsed = fallbackJSON();

      // 🆕 normalización suave
      parsed = normalizeDurationsInParsed(parsed);

      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    // -------------------- MODO LEGADO "text" --------------------
    if (mode === "text") {
      const clientMessages = extractMessages(body);
      const raw = await callText(clientMessages, 0.5, 2000);
      return res.status(200).json({ text: raw || "" });
    }

    return res.status(400).json({ error: "Invalid mode" });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
