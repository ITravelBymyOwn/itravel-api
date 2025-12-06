// /api/chat.js — v31.0 (Info-first → Planner, global & fast)
// Base: v30.14 (se preservan nombres y flujo); cambios quirúrgicos:
// 1) Nuevo prepaso INFO (interno) que produce {facts, seed} por ciudad.
// 2) Planner consume FACTS + SEED y devuelve JSON final.
// 3) Sin defaults sesgados por país; global. Sin inyección automática de auroras.
// 4) Rápido: sin cascadas de reintentos costosas; tries=1, prompts compactos.
// 5) Post-proceso conservado: subparadas≤8, coerción transporte, limpieza, retorno con FACTS (si existen).

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

function cleanToJSONPlus(raw) {
  if (!raw) return null;
  if (typeof raw === "object") {
    const obj = raw;
    if (obj.rows || obj.destinations || obj.facts || obj.seed) return obj;
    try { return JSON.parse(JSON.stringify(obj)); } catch {}
  }
  if (typeof raw !== "string") return null;

  let s = raw.trim();
  s = s.replace(/^```json/i, "```").replace(/^```/, "").replace(/```$/, "").trim();

  try { return JSON.parse(s); } catch {}

  try {
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
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
// Limpieza / Formato / Transporte / Subparadas
// ==============================
const NO_BUS_TOPICS = [
  // genéricos frecuentes (no sesgados a un país)
  "círculo dorado","thingvellir","þingvellir","geysir","geyser",
  "gullfoss","seljalandsfoss","skógafoss","reynisfjara",
  "vik","vík","snaefellsnes","snæfellsnes","blue lagoon",
  "reykjanes","krýsuvík","arnarstapi","hellnar","djúpalónssandur",
  "kirkjufell","puente entre continentes"
];

function needsVehicleOrTour(row) {
  const a = (row.activity || "").toLowerCase();
  const to = (row.to || "").toLowerCase();
  return NO_BUS_TOPICS.some(k => a.includes(k) || to.includes(k));
}

function coerceTransport(rows) {
  return rows.map(r => {
    const transport = (r.transport || "").toLowerCase();
    if (transport.includes("bus") && needsVehicleOrTour(r)) {
      return { ...r, transport: "Vehículo alquilado o Tour guiado" };
    }
    return r;
  });
}

function scrubAuroraValid(text = "") {
  if (!text) return text;
  return text.replace(/valid:[^.\n\r]*auroral[^.\n\r]*\.?/gi, "").trim();
}

function scrubBlueLagoon(text = "") {
  if (!text) return text;
  return text
    .replace(/(\s*[-–•·]\s*)?min\s*stay\s*~?3h\s*\(ajustable\)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function stripApproxDuration(d = "") {
  if (!d) return d;
  return String(d).replace(/[~≈]/g, "").trim();
}

/**
 * Formato madre-subparadas:
 * – Detecta "Excursión".
 * – Reetiqueta hasta 8 filas hijas consecutivas como "Excursión — {Ruta} — {Subparada}".
 */
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
        aj.includes("cascada") ||
        aj.includes("playa") ||
        aj.includes("geysir") ||
        aj.includes("thingvellir") ||
        aj.includes("gullfoss") ||
        aj.includes("kirkjufell") ||
        aj.includes("arnarstapi") ||
        aj.includes("hellnar") ||
        aj.includes("djúpalónssandur") ||
        aj.includes("djupalonssandur") ||
        aj.includes("vík") ||
        aj.includes("vik") ||
        aj.includes("reynisfjara");

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

/**
 * Aplica duraciones reales al "Regreso a {Ciudad}" cuando FACTS aporta una duración concreta
 * para la última parada → ciudad base.
 */
function applyReturnDurationsFromFacts(rows, facts) {
  if (!facts || !facts.daytrip_patterns || !facts.base_city) return rows;
  const baseCity = (facts.base_city || "").toLowerCase();

  const toBase = {};
  for (const p of facts.daytrip_patterns) {
    const from = p.return_to_base_from || (p.stops && p.stops[p.stops.length - 1]);
    const key = `${from}→${facts.base_city}`;
    const dur = p.durations?.[key];
    if (from && dur) toBase[from.toLowerCase()] = dur;
  }

  return rows.map(r => {
    const act = (r.activity || "").toLowerCase();
    const to = (r.to || "").toLowerCase();
    const isReturn = act.startsWith("regreso a") && to.includes(baseCity);
    if (!isReturn) return r;

    const prevTo = (r.from || "").toLowerCase();
    const durationKnown =
      r.duration && /^[0-9]h|[0-9]+m|[0-9]h[0-9]{1,2}m$/i.test(String(r.duration).replace(/\s/g, ""));

    if (!durationKnown) {
      const best = toBase[prevTo] || null;
      if (best) return { ...r, duration: best };
    }
    return r;
  });
}

function normalizeShape(parsed, rowsFixed) {
  if (Array.isArray(parsed?.rows)) return { ...parsed, rows: rowsFixed };
  if (Array.isArray(parsed?.destinations)) {
    const name = parsed.destinations?.[0]?.name || parsed.destination || "Destino";
    return { destination: name, rows: rowsFixed, followup: parsed.followup || "" };
  }
  return { destination: parsed?.destination || "Destino", rows: rowsFixed, followup: parsed?.followup || "" };
}

// ==============================
// Prompts (Info-first → Planner)
// ==============================

/**
 * PRE_INFO_PROMPT
 * Produce un JSON compacto con:
 * {
 *   "facts": { "base_city":"...", "daytrip_patterns":[{route,stops[],return_to_base_from,durations{}}], "other_hints":[...] },
 *   "seed":  { "destination":"City", "rows":[ ...primer borrador de filas por días... ] }
 * }
 * - Global (no asume país).
 * - Debe ser rápido y sin texto fuera del JSON.
 */
const PRE_INFO_PROMPT = `
Eres un asistente turístico experto (MODO INVESTIGACIÓN RÁPIDA).
A partir del mensaje del usuario (ciudades, fechas, hotel/zona, preferencias) devuelve **EXCLUSIVAMENTE JSON** con:
{
  "facts":{
    "base_city":"<ciudad base si aplica>",
    "daytrip_patterns":[
      {
        "route":"<ruta o zona>",
        "stops":["<subparada1>","<subparada2>", "..."],
        "return_to_base_from":"<última parada para regresar a base>",
        "durations":{ "<A→B>":"<tiempo>", "<B→C>":"<tiempo>", "<C→Base>":"<tiempo>" }
      }
    ],
    "other_hints":[ "<reglas de transporte o ventanas típicas si aportan valor>" ]
  },
  "seed":{
    "destination":"<Ciudad principal detectada>",
    "rows":[
      {
        "day": 1,
        "start": "09:00",
        "end": "10:30",
        "activity": "Actividad relevante (permitido: 'Excursión — Ruta — Subparada')",
        "from": "Lugar de inicio",
        "to": "Lugar de destino",
        "transport": "A pie/Metro/Tren/Auto/Taxi/Bus/Ferry/Vehículo alquilado o Tour guiado",
        "duration": "90m",
        "notes": "Breve contexto"
      }
    ]
  }
}
No texto fuera del JSON.
`.trim();

/**
 * SYSTEM_PROMPT (PLANNER)
 * El planner usa FACTS + SEED para estructurar y completar el itinerario final.
 */
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido**.

Dispones de:
- FACTS: patrones y duraciones investigadas.
- SEED: un borrador de filas por días.

TAREA: Con FACTS+SEED, genera un itinerario coherente y completo.

📌 FORMATO
{"destination":"City","rows":[{...}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos una actividad en "rows".
- Nada de texto fuera del JSON.
- Máx. 20 actividades por día.
- Usa horas realistas (08:30–19:00 si no hay otras).
- "duration" limpio: "1h45m" o "30m" (no uses "~" ni "≈").
- Si FACTS no cubre una pareja exacta de lugares, estima tiempos coherentes.

🧭 ESTRUCTURA DE CADA FILA
{
  "day": 1,
  "start": "08:30",
  "end": "10:30",
  "activity": "Nombre claro (permitido: 'Excursión — Ruta — Subparada')",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "A pie, Metro, Tren, Auto, Taxi, Bus, Ferry, Vehículo alquilado o Tour guiado",
  "duration": "2h",
  "notes": "Descripción breve"
}

🧩 DESTINO–SUBPARADAS
- Para rutas de jornada completa, usa la convención **"Excursión — {Ruta} — {Subparada}"** en las paradas hijas (hasta 8).
- Agrega explícitamente la fila **"Regreso a {Ciudad}"** con tiempo real de vuelta si el día sale fuera.
`.trim();

// ==============================
// Llamadas al modelo (rápidas)
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

    // ===== INFO MODE (como tu info chat) =====
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
      const preRaw = await chatJSON(
        [{ role: "system", content: PRE_INFO_PROMPT }, ...clientMessages],
        0.3,
        1
      );
      pre = cleanToJSONPlus(preRaw);
    } catch (e) {
      // continúa sin bloquear
    }

    // FACTS globales por defecto (sin sesgo de país)
    const FACTS_DEFAULT = { base_city: "", daytrip_patterns: [], other_hints: [] };

    // Mezcla FACTS del prepaso con defaults globales (no-bias)
    const factsMerged = (() => {
      const m = (pre && pre.facts) ? pre.facts : {};
      const out = { ...FACTS_DEFAULT };
      // Base_city si viene
      if (typeof m.base_city === "string") out.base_city = m.base_city;
      // Patrones de day trip
      if (Array.isArray(m.daytrip_patterns)) out.daytrip_patterns = m.daytrip_patterns;
      // Hints
      if (Array.isArray(m.other_hints)) out.other_hints = m.other_hints;
      return out;
    })();

    // SEED opcional para guiar al planner
    const seedMerged = (() => {
      const s = (pre && pre.seed && pre.seed.rows) ? pre.seed : null;
      if (!s) return null;
      // Limpieza liviana de seed
      const rows = (s.rows || []).map(r => ({
        ...r,
        duration: stripApproxDuration(r.duration),
        notes: scrubBlueLagoon(scrubAuroraValid(r.notes))
      }));
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
    } catch (e) {
      // continúa a fallback
    }

    if (!parsed) parsed = fallbackJSON();

    // Post-proceso: limpieza + formato madre-subparadas + transporte
    let rows = Array.isArray(parsed.rows)
      ? parsed.rows
      : Array.isArray(parsed?.destinations?.[0]?.rows)
        ? parsed.destinations[0].rows
        : [];

    rows = rows.map(r => ({
      ...r,
      duration: stripApproxDuration(r.duration),
      notes: scrubBlueLagoon(scrubAuroraValid(r.notes))
    }));
    rows = coerceTransport(enforceMotherSubstopFormat(rows));

    // Si FACTS incluye una ruta con "return_to_base_from", aplica duración real para "Regreso a {Ciudad}"
    rows = applyReturnDurationsFromFacts(rows, factsMerged);

    const finalJSON = normalizeShape(parsed, rows);

    return res.status(200).json({ text: JSON.stringify(finalJSON) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    // JSON válido para no romper la UI
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
