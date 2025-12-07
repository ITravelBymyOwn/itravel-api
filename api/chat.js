// /api/chat.js — v31.1 (compat-restored: FACTS+SEED interno, salida idéntica al shape clásico)
// Objetivo: mantener la secuencia de render de tablas "como antes" sin tocar el frontend.

import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

// Parser tolerante (acepta string JSON, bloque {...} embebido u objeto)
function cleanToJSONPlus(raw) {
  if (!raw) return null;

  if (typeof raw === "object") {
    try { return JSON.parse(JSON.stringify(raw)); } catch { return raw; }
  }

  if (typeof raw !== "string") return null;

  let s = raw.trim();
  s = s.replace(/^```json/i, "```").replace(/^```/, "").replace(/```$/, "").trim();

  try { return JSON.parse(s); } catch {}
  try {
    const first = s.indexOf("{");
    const last  = s.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(s.slice(first, last + 1));
  } catch {}

  try {
    const cleaned = s.replace(/^[^{]+/, "").replace(/[^}]+$/, "");
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
        notes: "Explora libremente la ciudad y descubre sus lugares más emblemáticos.",
      },
    ],
    followup: "⚠️ Fallback local: revisa configuración de Vercel o API Key.",
  };
}

// ==============================
// Limpieza / Transporte / Subparadas / Duraciones
// ==============================
const NO_BUS_TOPICS = [
  "círculo dorado","thingvellir","þingvellir","geysir","geyser",
  "gullfoss","seljalandsfoss","skógafoss","reynisfjara","vik","vík",
  "snaefellsnes","snæfellsnes","blue lagoon","reykjanes","krýsuvík",
  "arnarstapi","hellnar","djúpalónssandur","kirkjufell","puente entre continentes"
];

function needsVehicleOrTour(row) {
  const a = (row.activity || "").toLowerCase();
  const to = (row.to || "").toLowerCase();
  return NO_BUS_TOPICS.some(k => a.includes(k) || to.includes(k));
}

function coerceTransport(rows) {
  return rows.map(r => {
    const t = String(r.transport || "").toLowerCase();
    if (t.includes("bus") && needsVehicleOrTour(r)) {
      return { ...r, transport: "Vehículo alquilado o Tour guiado" };
    }
    return r;
  });
}

function stripApproxDuration(d = "") {
  if (!d) return d;
  return String(d).replace(/[~≈]/g, "").trim();
}

function enforceMotherSubstopFormat(rows) {
  const out = [...rows];
  for (let i = 0; i < out.length; i++) {
    const r = out[i];
    const act = (r.activity || "").toLowerCase();
    if (!/excursión/.test(act)) continue;

    const rawName = (r.activity || "").trim();
    const routeBase = rawName.replace(/^excursión\s*(a|al)?\s*/i, "").split("—")[0].trim() || "Ruta";

    let count = 0;
    for (let j = i + 1; j < out.length && count < 8; j++) {
      const rj = out[j];
      const aj = (rj?.activity || "").toLowerCase();
      const isSub =
        aj.startsWith("visita") ||
        aj.includes("cascada") || aj.includes("playa") ||
        aj.includes("geysir")   || aj.includes("thingvellir") || aj.includes("gullfoss") ||
        aj.includes("kirkjufell")|| aj.includes("arnarstapi")  || aj.includes("hellnar") ||
        aj.includes("djúpalónssandur") || aj.includes("djupalonssandur") ||
        aj.includes("vík") || aj.includes("vik") || aj.includes("reynisfjara");

      if (!isSub) break;

      const pretty = (rj.to || rj.activity || "")
        .replace(/^visita\s+(a|al)\s*/i, "")
        .trim();

      rj.activity = `Excursión — ${routeBase} — ${pretty}`;
      if (!rj.notes) rj.notes = "Parada dentro de la ruta.";
      count++;
    }
  }
  return out;
}

// Usar duraciones de FACTS para el "Regreso a {Ciudad}" si existen
function applyReturnDurationsFromFacts(rows, facts) {
  if (!facts || !facts.daytrip_patterns || !facts.base_city) return rows;
  const baseCity = (facts.base_city || "").toLowerCase();

  const toBaseMap = {};
  for (const p of facts.daytrip_patterns) {
    const from = p.return_to_base_from || (p.stops && p.stops[p.stops.length - 1]);
    const key = `${from}→${facts.base_city}`;
    const dur = p.durations?.[key];
    if (from && dur) toBaseMap[from.toLowerCase()] = dur;
  }

  return rows.map(r => {
    const act = (r.activity || "").toLowerCase();
    const to  = (r.to || "").toLowerCase();
    const isReturn = act.startsWith("regreso a") && to.includes(baseCity);
    if (!isReturn) return r;

    const prevTo = (r.from || "").toLowerCase();
    const durationKnown = r.duration && /^[0-9]+h([0-9]{1,2}m)?$|^[0-9]+m$/.test(String(r.duration).replace(/\s/g, ""));
    if (!durationKnown) {
      const best = toBaseMap[prevTo] || null;
      if (best) return { ...r, duration: best };
    }
    return r;
  });
}

function normalizeShape(parsed, rowsFixed) {
  if (Array.isArray(parsed?.rows)) {
    return { ...parsed, rows: rowsFixed };
  }
  if (Array.isArray(parsed?.destinations)) {
    const name = parsed.destinations?.[0]?.name || parsed.destination || "Destino";
    return { destination: name, rows: rowsFixed, followup: parsed.followup || "" };
  }
  return { destination: parsed?.destination || "Destino", rows: rowsFixed, followup: parsed?.followup || "" };
}

// ==============================
// Prompts (Pre-INFO → Planner)
// ==============================
const PRE_INFO_PROMPT = `
Eres un asistente turístico experto (MODO INVESTIGACIÓN RÁPIDA).
Devuelve **solo JSON**:
{
  "facts":{
    "base_city":"<ciudad base si aplica>",
    "daytrip_patterns":[
      {
        "route":"<ruta o zona>",
        "stops":["<sub1>","<sub2>","..."],
        "return_to_base_from":"<última parada para regresar a base>",
        "durations":{ "<A→B>":"<tiempo>", "<B→C>":"<tiempo>", "<C→Base>":"<tiempo>" }
      }
    ],
    "other_hints":[ "<reglas útiles breves>" ]
  },
  "seed":{
    "destination":"<Ciudad detectada>",
    "rows":[
      {
        "day":1,"start":"09:00","end":"10:30",
        "activity":"Actividad relevante (permitido 'Excursión — Ruta — Subparada')",
        "from":"Inicio","to":"Destino",
        "transport":"A pie/Metro/Tren/Auto/Taxi/Bus/Ferry/Vehículo alquilado o Tour guiado",
        "duration":"90m","notes":"Breve contexto"
      }
    ]
  }
}
`.trim();

const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido** con shape:
{"destination":"City","rows":[{...}],"followup":"texto breve"}

Reglas:
- Siempre al menos 1 actividad en "rows".
- Sin texto fuera del JSON. Máx 20 actividades por día.
- Horas realistas (08:30–19:00 si no hay otras).
- "duration" limpio: "1h45m" o "30m".
- Si FACTS no cubre una pareja exacta, estima tiempos coherentes.
- Para rutas de jornada completa, usar "Excursión — {Ruta} — {Subparada}" en paradas hijas (hasta 8).
- Agrega explícitamente "Regreso a {Ciudad}" cuando el día sale fuera.
`.trim();

// ==============================
// Llamadas modelo
// ==============================
async function chatJSON(messages, temperature = 0.3, tries = 1) {
  for (let k = 0; k < Math.max(1, tries); k++) {
    try {
      const resp = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature,
        response_format: { type: "json_object" },
        messages: messages.map(m => ({ role: m.role, content: String(m.content ?? "") })),
        max_tokens: 2200,
      });
      const text = resp?.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    } catch (e) {
      if (k === tries - 1) throw e;
    }
  }
  return "";
}

async function chatFree(messages, temperature = 0.5, tries = 1) {
  for (let k = 0; k < Math.max(1, tries); k++) {
    try {
      const resp = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature,
        messages: messages.map(m => ({ role: m.role, content: String(m.content ?? "") })),
        max_tokens: 2200,
      });
      const text = resp?.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    } catch (e) {
      if (k === tries - 1) throw e;
    }
  }
  return "";
}

// ==============================
// Handler
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body || {};
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    // ===== Modo INFO: responde libre (no JSON estricto) =====
    if (mode === "info") {
      try {
        const raw = await chatFree(clientMessages, 0.5, 1);
        return res.status(200).json({ text: raw || "⚠️ No se obtuvo respuesta." });
      } catch (e) {
        return res.status(200).json({ text: "⚠️ No se obtuvo respuesta." });
      }
    }

    // ===== Paso 1: PRE-INFO (investigación + seed) =====
    let pre = null;
    try {
      const preRaw = await chatJSON([{ role: "system", content: PRE_INFO_PROMPT }, ...clientMessages], 0.3, 1);
      pre = cleanToJSONPlus(preRaw);
    } catch (_) {}

    const FACTS_DEFAULT = { base_city: "", daytrip_patterns: [], other_hints: [] };
    const factsMerged = (() => {
      const m = (pre && pre.facts) ? pre.facts : {};
      const out = { ...FACTS_DEFAULT };
      if (typeof m.base_city === "string") out.base_city = m.base_city;
      if (Array.isArray(m.daytrip_patterns)) out.daytrip_patterns = m.daytrip_patterns;
      if (Array.isArray(m.other_hints)) out.other_hints = m.other_hints;
      return out;
    })();

    const seedMerged = (() => {
      const s = (pre && pre.seed && pre.seed.rows) ? pre.seed : null;
      if (!s) return null;
      const rows = (s.rows || []).map(r => ({ ...r, duration: stripApproxDuration(r.duration) }));
      return { destination: s.destination || "", rows };
    })();

    const FACTS = JSON.stringify(factsMerged);
    const SEED  = seedMerged ? JSON.stringify(seedMerged) : "";

    // ===== Paso 2: PLANNER (consume FACTS + SEED) =====
    let parsed = null;
    try {
      const plannerRaw = await chatJSON(
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "system", content: `FACTS=${FACTS}` },
          ...(SEED ? [{ role: "system", content: `SEED=${SEED}` }] : []),
          ...clientMessages
        ],
        0.3,
        1
      );
      parsed = cleanToJSONPlus(plannerRaw);
    } catch (_) {}

    if (!parsed) parsed = fallbackJSON();

    // ===== Post-proceso para shape clásico =====
    let rows = Array.isArray(parsed.rows)
      ? parsed.rows
      : Array.isArray(parsed?.destinations?.[0]?.rows)
        ? parsed.destinations[0].rows
        : [];

    rows = rows.map(r => ({ ...r, duration: stripApproxDuration(r.duration) }));
    rows = coerceTransport(enforceMotherSubstopFormat(rows));
    rows = applyReturnDurationsFromFacts(rows, factsMerged);

    // Salida normalizada EXACTA al contrato que tu UI espera
    const finalJSON = normalizeShape(parsed, rows);

    // Importante: devolvemos SIEMPRE como string en "text" (shape clásico)
    return res.status(200).json({ text: JSON.stringify(finalJSON) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
