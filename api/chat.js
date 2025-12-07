// /api/chat.js — v31.2 (robust-planner: JSON ALWAYS with >=1 row, strict durations, better model & retries)
// Objetivo: evitar respuestas vacías, garantizar al menos 1–2 filas útiles y mantener el shape clásico del frontend.

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

// Heurística muy suave para inferir ciudad si faltara
function guessCityFromMessages(msgs = []) {
  const all = msgs.map(m => String(m?.content || "")).join(" ");
  // Aprende de tus casos (Reykjavik/Tromsø) y nombres con mayúsculas típicas:
  const known = [
    "Reykjavik","Reikiavik","Reykjavík","Tromsø","Tromso","Oslo","Roma","Florencia","Kyoto","Tokyo","Tokio"
  ];
  for (const k of known) if (new RegExp(`\\b${k}\\b`, "i").test(all)) return k;
  // Fallback: última palabra Capitalizada de 4+ letras
  const m = all.match(/(?:^|\s)([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{3,}(?:[ -][A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})?)/g);
  if (m && m.length) return m[m.length - 1].trim();
  return "Destino";
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

function fallbackJSON(city = "Destino") {
  return {
    destination: city || "Destino",
    rows: [
      {
        day: 1,
        start: "09:00",
        end: "17:30",
        activity: `Recorrido esencial por ${city || "la ciudad"}`,
        from: "",
        to: city || "Centro",
        transport: "A pie",
        duration: "8h30m",
        notes: "Explora los sitios icónicos, organiza tus entradas y tiempos de comida."
      },
      {
        day: 1,
        start: "17:30",
        end: "18:00",
        activity: "Regreso a hotel",
        from: city || "Centro",
        to: "Hotel",
        transport: "Taxi",
        duration: "30m",
        notes: "Cierre del día y descanso."
      }
    ],
    followup: "⚠️ Fallback local: revisión de parámetros o API Key podría ser necesaria."
  };
}

// ==============================
// Limpieza / Transporte / Subparadas / Duraciones
// ==============================
const NO_BUS_TOPICS = [
  "círculo dorado","thingvellir","þingvellir","geysir","geyser",
  "gullfoss","seljalandsfoss","skógafoss","reynisfjara","vik","vík",
  "snaefellsnes","snæfellsnes","blue lagoon","reykjanes","krýsuvík",
  "arnarstapi","hellnar","djúpalónssandur","kirkjufell","puente entre continentes",
  "dyrhólaey","kirkjufellsfoss","kleifarvatn","seltún","reykjanesviti"
];

function needsVehicleOrTour(row) {
  const a = (row.activity || "").toLowerCase();
  const to = (row.to || "").toLowerCase();
  return NO_BUS_TOPICS.some(k => a.includes(k) || to.includes(k));
}

function coerceTransport(rows) {
  return rows.map(r => {
    const t = String(r.transport || "").toLowerCase();
    if ((!t || t.includes("bus")) && needsVehicleOrTour(r)) {
      return { ...r, transport: "Vehículo alquilado o Tour guiado" };
    }
    return r;
  });
}

function stripApproxDuration(d = "") {
  if (!d) return d;
  return String(d).replace(/[~≈]/g, "").trim();
}

function ensureStrictDuration(d = "") {
  // Acepta "1h", "1h30m", "90m", "45m"
  const s = String(d || "").replace(/\s+/g, "");
  if (/^\d+h(\d{1,2}m)?$/.test(s) || /^\d+m$/.test(s)) return s;
  // Reconstrucción simple si trajera "1:30" o "02:00"
  const h = s.match(/^(\d{1,2}):(\d{2})$/);
  if (h) {
    const mm = parseInt(h[1],10)*60 + parseInt(h[2],10);
    return mm >= 60 ? `${Math.floor(mm/60)}h${mm%60 ? `${mm%60}m` : ""}` : `${mm}m`;
  }
  // Fallback mínimo
  return "30m";
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

// Usa FACTS (si existen) para ajustar duración de “Regreso a {Ciudad}”
function applyReturnDurationsFromFacts(rows, facts) {
  if (!facts || !facts.daytrip_patterns || !facts.base_city) return rows;
  const baseCity = (facts.base_city || "").toLowerCase();

  const toBaseMap = {};
  for (const p of facts.daytrip_patterns) {
    const from = p.return_to_base_from || (p.stops && p.stops[p.stops.length - 1]);
    const key = `${from}→${facts.base_city}`;
    const dur = p.durations?.[key];
    if (from && dur) toBaseMap[from.toLowerCase()] = ensureStrictDuration(dur);
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

// Si se detecta salida fuera de ciudad y no hay “Regreso a {Ciudad}”, lo añadimos
function ensureReturnToCityIfDaytrip(rows, city) {
  const cityLow = String(city || "").toLowerCase();
  const outOfTown = rows.some(r => {
    const a = (r.activity || "").toLowerCase();
    const t = (r.to || "").toLowerCase();
    return NO_BUS_TOPICS.some(k => a.includes(k) || t.includes(k));
  });
  if (!outOfTown) return rows;

  const hasReturn = rows.some(r => {
    const a = (r.activity || "").toLowerCase();
    const t = (r.to || "").toLowerCase();
    return a.startsWith("regreso a") && t.includes(cityLow);
  });
  if (hasReturn) return rows;

  const last = rows[rows.length - 1] || {};
  const start = last.end || "17:00";
  return [
    ...rows,
    {
      day: last.day || 1,
      start,
      end: addMinutes(start, 60),
      activity: `Regreso a ${city}`,
      from: last.to || "Alrededores",
      to: city,
      transport: "Vehículo alquilado o Tour guiado",
      duration: "1h",
      notes: "Ruta de retorno hacia base."
    }
  ];
}

// Asegura “Regreso a hotel” al final del día
function ensureReturnToHotel(rows, city) {
  if (!rows.length) return rows;
  const last = rows[rows.length - 1];
  const isHotel = /regreso\s+al?\s*hotel/i.test(String(last.activity || ""));
  if (isHotel) return rows;
  const start = last.end || "20:00";
  return [
    ...rows,
    {
      day: last.day || 1,
      start,
      end: addMinutes(start, 30),
      activity: "Regreso a hotel",
      from: last.to || city || "",
      to: "Hotel",
      transport: "Taxi",
      duration: "30m",
      notes: "Cierre del día."
    }
  ];
}

// Normaliza respuesta al contrato clásico
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

// Tiempo util
function toMin(t) { const m = String(t||"").match(/^(\d{1,2}):(\d{2})$/); if (!m) return null; return parseInt(m[1],10)*60 + parseInt(m[2],10); }
function toHH(m) { const mm = ((m%1440)+1440)%1440; const h = Math.floor(mm/60), mi = mm%60; return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}`; }
function addMinutes(hhmm = "09:00", add = 30) { const s = toMin(hhmm) ?? 540; return toHH(s + add); }

// Si rows viene vacío, generamos un set mínimo (nunca devolvemos 0 filas)
function synthesizeIfEmpty(rows, destination) {
  if (Array.isArray(rows) && rows.length > 0) return rows;
  const city = destination || "Destino";
  return [
    {
      day: 1,
      start: "09:00",
      end: "17:30",
      activity: `Recorrido esencial por ${city}`,
      from: "",
      to: city,
      transport: "A pie",
      duration: "8h30m",
      notes: "Itinerario base generado para evitar vacío."
    },
    {
      day: 1,
      start: "17:30",
      end: "18:00",
      activity: "Regreso a hotel",
      from: city,
      to: "Hotel",
      transport: "Taxi",
      duration: "30m",
      notes: "Cierre del día."
    }
  ];
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
// Llamadas modelo (con retries)
// ==============================
async function chatJSON(messages, temperature = 0.25, tries = 2, model = "gpt-4o-mini") {
  for (let k = 0; k < Math.max(1, tries); k++) {
    try {
      const resp = await client.chat.completions.create({
        model,
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

async function chatFree(messages, temperature = 0.5, tries = 1, model = "gpt-4o-mini") {
  for (let k = 0; k < Math.max(1, tries); k++) {
    try {
      const resp = await client.chat.completions.create({
        model,
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
        const raw = await chatFree(clientMessages, 0.5, 1, "gpt-4o-mini");
        return res.status(200).json({ text: raw || "⚠️ No se obtuvo respuesta." });
      } catch (e) {
        return res.status(200).json({ text: "⚠️ No se obtuvo respuesta." });
      }
    }

    // ===== Paso 1: PRE-INFO (investigación + seed) =====
    let pre = null;
    try {
      const preRaw = await chatJSON(
        [{ role: "system", content: PRE_INFO_PROMPT }, ...clientMessages],
        0.25,
        2,
        "gpt-4o-mini"
      );
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
      const rows = (s.rows || []).map(r => ({ ...r, duration: ensureStrictDuration(stripApproxDuration(r.duration)) }));
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
        0.2,
        2,
        "gpt-4o" // Modelo más fuerte para cumplir JSON y contenido
      );
      parsed = cleanToJSONPlus(plannerRaw);
    } catch (_) {}

    // ===== Robustez contra null/rows vacías =====
    const destinationRaw =
      parsed?.destination ||
      factsMerged?.base_city ||
      seedMerged?.destination ||
      guessCityFromMessages(clientMessages) ||
      "Destino";

    // Si no hay parsed o viene sin rows válidas, generamos un mínimo
    if (!parsed || !Array.isArray(parsed.rows)) {
      parsed = fallbackJSON(destinationRaw);
    }

    // ===== Post-proceso para shape clásico =====
    let rows = Array.isArray(parsed.rows)
      ? parsed.rows
      : Array.isArray(parsed?.destinations?.[0]?.rows)
        ? parsed.destinations[0].rows
        : [];

    // Aseguramos que NUNCA quede vacío
    rows = synthesizeIfEmpty(rows, destinationRaw);

    // Normalizaciones adicionales
    rows = rows.map(r => ({
      ...r,
      duration: ensureStrictDuration(stripApproxDuration(r.duration)),
      start: r.start || "09:00",
      end: r.end || addMinutes(r.start || "09:00", 90),
      day: r.day ?? 1
    }));

    rows = coerceTransport(enforceMotherSubstopFormat(rows));
    rows = applyReturnDurationsFromFacts(rows, factsMerged);
    rows = ensureReturnToCityIfDaytrip(rows, destinationRaw);
    rows = ensureReturnToHotel(rows, destinationRaw);

    // Salida normalizada EXACTA al contrato que tu UI espera
    const finalJSON = normalizeShape(
      { ...parsed, destination: destinationRaw || parsed?.destination || "Destino" },
      rows
    );

    // Importante: devolvemos SIEMPRE como string en "text" (shape clásico)
    return res.status(200).json({ text: JSON.stringify(finalJSON) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    const city = "Destino";
    return res.status(200).json({ text: JSON.stringify(fallbackJSON(city)) });
  }
}
