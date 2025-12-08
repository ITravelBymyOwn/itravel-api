// /api/chat.js — v42.1 (render-ready, fallback blindado, coherente con planner.js v75)
// Mantiene compatibilidad con el render de tablas y con las secciones 15–21 actuales.
// Devuelve { text: JSON.stringify(finalJSON) } con estructura completa.

import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ======================================================
   REDIS CACHE OPCIONAL (estado temporal de itinerarios)
====================================================== */
let _redis = null;
async function getRedis() {
  if (_redis !== null) return _redis;
  const has =
    !!process.env.UPSTASH_REDIS_REST_URL &&
    !!process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!has) return (_redis = false);
  try {
    const { Redis } = await import("@upstash/redis");
    _redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  } catch {
    _redis = false;
  }
  return _redis;
}
const K = (id) => `itbmo:itinerary:${id}`;
async function storeLoad(id) {
  const r = await getRedis();
  if (!r || !id) return null;
  try {
    return await r.get(K(id));
  } catch {
    return null;
  }
}
async function storeSave(obj) {
  const r = await getRedis();
  if (!r) return;
  try {
    await r.set(K(obj.itinerary_id), obj, { ex: 60 * 60 * 24 });
  } catch {}
}

/* ======================================================
   UTILIDADES GENERALES
====================================================== */
function uuid() {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0,
      v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
function extractMessages(body = {}) {
  const { messages, input, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;
  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";
  return [...prev, { role: "user", content: userText }];
}
function cleanToJSONPlus(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return JSON.parse(JSON.stringify(raw));
  let s = String(raw).trim();
  s = s.replace(/^```json/i, "```").replace(/^```/, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(s);
  } catch {}
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
function fallbackJSON(city = "Destino") {
  return {
    itinerary_id: uuid(),
    version: 1,
    destination: city,
    rows: [
      {
        day: 1,
        start: "08:30",
        end: "19:00",
        activity: "Itinerario base (fallback)",
        from: "",
        to: "",
        transport: "A pie",
        duration: "2h",
        notes: "Explora los imperdibles del centro. Reajusta desde el chat.",
      },
    ],
    followup: "⚠️ Fallback local: revisa configuración de Vercel o API Key.",
  };
}
function stripApproxDuration(d = "") {
  return d ? String(d).replace(/[~≈]/g, "").trim() : d;
}

/* ======================================================
   TRANSPORTE, SUBPARADAS Y DURACIONES
====================================================== */
const NO_BUS_TOPICS = [
  "círculo dorado","thingvellir","þingvellir","geysir","geyser","gullfoss",
  "seljalandsfoss","skógafoss","reynisfjara","vik","vík","snaefellsnes",
  "snæfellsnes","blue lagoon","reykjanes","krýsuvík","arnarstapi","hellnar",
  "djúpalónssandur","djupalonssandur","kirkjufell","puente entre continentes"
];
function needsVehicleOrTour(r) {
  const a = (r.activity || "").toLowerCase();
  const to = (r.to || "").toLowerCase();
  return NO_BUS_TOPICS.some((k) => a.includes(k) || to.includes(k));
}
function coerceTransport(rows) {
  return rows.map((r) =>
    (!r.transport || /bus/i.test(r.transport)) && needsVehicleOrTour(r)
      ? { ...r, transport: "Vehículo alquilado o Tour guiado" }
      : r
  );
}
function enforceMotherSubstopFormat(rows) {
  const out = [...rows];
  for (let i = 0; i < out.length; i++) {
    const r = out[i];
    const act = (r.activity || "").toLowerCase();
    const isExc = /excursión/.test(act) || /day\s*trip/i.test(act);
    if (!isExc) continue;
    const base = (r.activity || "").replace(/^excursión\s*(a|al)?\s*/i, "").split("—")[0].trim();
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
        aj.includes("vik") ||
        aj.includes("reynisfjara");
      if (!isSub) break;
      const pretty = (rj.to || rj.activity || "")
        .replace(/^visita\s+(a|al)\s*/i, "")
        .trim();
      rj.activity = `Excursión — ${base || "Ruta"} — ${pretty}`;
      if (!rj.notes) rj.notes = "Parada dentro de la ruta.";
      count++;
    }
  }
  return out;
}
function applyReturnDurationsFromFacts(rows, facts) {
  if (!facts || !facts.daytrip_patterns || !facts.base_city) return rows;
  const baseCity = facts.base_city.toLowerCase();
  const toBaseMap = {};
  for (const p of facts.daytrip_patterns) {
    const from = p.return_to_base_from || (p.stops && p.stops.at(-1));
    const key = `${from}→${facts.base_city}`;
    const dur = p.durations?.[key];
    if (from && dur) toBaseMap[from.toLowerCase()] = dur;
  }
  return rows.map((r) => {
    const act = (r.activity || "").toLowerCase();
    const to = (r.to || "").toLowerCase();
    const isReturn = act.startsWith("regreso a") && to.includes(baseCity);
    if (!isReturn) return r;
    const prevTo = (r.from || "").toLowerCase();
    const durationKnown = /^[0-9]+h([0-9]{1,2}m)?$|^[0-9]+m$/.test(
      String(r.duration || "").replace(/\s/g, "")
    );
    if (!durationKnown) {
      const best = toBaseMap[prevTo];
      if (best) return { ...r, duration: best };
    }
    return r;
  });
}
function normalizeShapeContract(parsed, rows, prev = null) {
  const dest = parsed?.destination || prev?.destination || "Destino";
  const id = parsed?.itinerary_id || prev?.itinerary_id || uuid();
  const ver =
    typeof parsed?.version === "number"
      ? parsed.version
      : typeof prev?.version === "number"
      ? prev.version + 1
      : 1;
  return {
    itinerary_id: id,
    version: ver,
    destination: dest,
    rows,
    followup: parsed?.followup || "",
  };
}

/* ======================================================
   PROMPTS BASE
====================================================== */
const PRE_INFO_PROMPT = `
Eres un asistente turístico experto (MODO INVESTIGACIÓN RÁPIDA).
Devuelve solo JSON:
{
  "facts":{"base_city":"<ciudad>","daytrip_patterns":[{"route":"<ruta>","stops":["<sub1>"],"return_to_base_from":"<última>","durations":{"<A→B>":"<tiempo>"}}],"other_hints":[]},
  "seed":{"destination":"<Ciudad>","rows":[{"day":1,"start":"09:00","end":"10:30","activity":"Actividad","from":"Inicio","to":"Destino","transport":"A pie","duration":"90m","notes":"Contexto"}]}
}`.trim();

const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes de ITravelByMyOwn.
Responde exclusivamente JSON válido:
{"destination":"City","rows":[{...}],"followup":"texto breve"}
Reglas:
- Siempre >=1 fila; 08:30–19:00 si no hay datos.
- "duration" limpio ("1h30m" / "45m").
- Day-trip fuera de ciudad → agrega "Regreso a {Ciudad}" coherente.
- Máx 8 subparadas por ruta "Excursión — Ruta — Subparada".
- Si no hay datos, genera contenido plausible y seguro.
`.trim();

/* ======================================================
   LLAMADAS OPENAI
====================================================== */
async function chatJSON(messages, temperature = 0.4, tries = 2) {
  for (let k = 0; k < tries; k++) {
    try {
      const r = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature,
        response_format: { type: "json_object" },
        messages: messages.map((m) => ({
          role: m.role,
          content: String(m.content || ""),
        })),
        max_tokens: 2600,
      });
      const txt = r?.choices?.[0]?.message?.content?.trim();
      if (txt) return txt;
    } catch (e) {
      if (k === tries - 1) throw e;
    }
  }
  return "";
}
async function chatFree(messages, temperature = 0.6) {
  try {
    const r = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature,
      messages: messages.map((m) => ({
        role: m.role,
        content: String(m.content || ""),
      })),
      max_tokens: 2000,
    });
    return r?.choices?.[0]?.message?.content?.trim() || "";
  } catch {
    return "";
  }
}

/* ======================================================
   HANDLER PRINCIPAL
====================================================== */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const body = req.body || {};
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    // ----- INFO CHAT -----
    if (mode === "info") {
      const txt = await chatFree(clientMessages, 0.5);
      return res.status(200).json({ text: txt || "⚠️ Sin respuesta." });
    }

    const incomingId = typeof body.itinerary_id === "string" ? body.itinerary_id : null;
    const incomingVersion =
      typeof body.version === "number" ? body.version : null;
    const prevState = incomingId ? await storeLoad(incomingId) : null;

    // ----- PRE-INFO -----
    let pre = null;
    try {
      const raw = await chatJSON(
        [{ role: "system", content: PRE_INFO_PROMPT }, ...clientMessages],
        0.35
      );
      pre = cleanToJSONPlus(raw);
    } catch {}
    const facts = pre?.facts || { base_city: "", daytrip_patterns: [], other_hints: [] };
    const seed = pre?.seed || null;

    const FACTS = JSON.stringify(facts);
    const SEED = seed ? JSON.stringify(seed) : "";

    // ----- PATCH -----
    if (mode === "patch") {
      if (!incomingId || incomingVersion == null) {
        const fb = fallbackJSON(seed?.destination || "Destino");
        return res.status(200).json({ text: JSON.stringify(fb) });
      }
      const baseRows =
        Array.isArray(body.rows) && body.rows.length
          ? body.rows
          : prevState?.rows || [];
      const opText =
        body.operation ||
        clientMessages[clientMessages.length - 1]?.content ||
        "";
      const patchSys = `
Eres Astra (PATCH). Ajusta la tabla existente según la instrucción.
Devuelve solo JSON {"destination":"...","rows":[...],"followup":""}
Mantén formato, horas plausibles y coherencia.
`;
      const patchUser = `
DESTINO: ${seed?.destination || prevState?.destination || "Destino"}
TABLA_ACTUAL:
${JSON.stringify(baseRows, null, 2)}

INSTRUCCIÓN:
${opText}
`.trim();

      let patched = null;
      try {
        const raw = await chatJSON(
          [
            { role: "system", content: patchSys },
            { role: "system", content: `FACTS=${FACTS}` },
            ...(SEED ? [{ role: "system", content: `SEED=${SEED}` }] : []),
            { role: "user", content: patchUser },
          ],
          0.35
        );
        patched = cleanToJSONPlus(raw);
      } catch {}
      if (!patched)
        patched = { destination: prevState?.destination, rows: baseRows, followup: "⚠️ Patch sin cambios" };

      let rows = Array.isArray(patched.rows) ? patched.rows : [];
      rows = rows.map((r) => ({ ...r, duration: stripApproxDuration(r.duration) }));
      rows = coerceTransport(enforceMotherSubstopFormat(rows));
      rows = applyReturnDurationsFromFacts(rows, facts);
      if (!rows.length)
        rows.push({
          day: 1,
          start: "09:00",
          end: "10:30",
          activity: "Ajuste mínimo aplicado",
          transport: "A pie",
          duration: "90m",
          notes: "Fila sintética.",
        });
      const final = normalizeShapeContract(patched, rows, prevState);
      await storeSave(final);
      return res.status(200).json({ text: JSON.stringify(final) });
    }

    // ----- PLANNER -----
    let parsed = null;
    try {
      const raw = await chatJSON(
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "system", content: `FACTS=${FACTS}` },
          ...(SEED ? [{ role: "system", content: `SEED=${SEED}` }] : []),
          ...clientMessages,
        ],
        0.35
      );
      parsed = cleanToJSONPlus(raw);
    } catch {}

    if (!parsed)
      parsed = { destination: seed?.destination || "Destino", rows: seed?.rows || [] };

    let rows = Array.isArray(parsed.rows)
      ? parsed.rows
      : parsed.destinations?.[0]?.rows || [];

    rows = rows.map((r) => ({ ...r, duration: stripApproxDuration(r.duration) }));
    rows = coerceTransport(enforceMotherSubstopFormat(rows));
    rows = applyReturnDurationsFromFacts(rows, facts);

    if (!rows.length)
      rows.push({
        day: 1,
        start: "09:00",
        end: "10:30",
        activity: "Inicio de exploración",
        transport: "A pie",
        duration: "90m",
        notes: "Fila sintética para render.",
      });

    const prevForContract =
      prevState ||
      (incomingId && {
        itinerary_id: incomingId,
        version: incomingVersion ?? 0,
        destination: seed?.destination || "Destino",
      }) ||
      null;

    const finalJSON = normalizeShapeContract(parsed, rows, prevForContract);
    await storeSave(finalJSON);
    return res.status(200).json({ text: JSON.stringify(finalJSON) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    const fb = fallbackJSON("Destino");
    return res.status(200).json({ text: JSON.stringify(fb) });
  }
}
