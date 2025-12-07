// /api/chat.js — v42.0 (stateful-ready, contract+versioning, robust fallback)
// Compatible con el render actual (responde { text: JSON.stringify(finalJSON) })

import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// =============== Storage Adapter (Redis opcional) ===============
let _redis = null;
async function getRedis() {
  if (_redis !== null) return _redis;
  const has =
    !!process.env.UPSTASH_REDIS_REST_URL &&
    !!process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!has) {
    _redis = false;
    return _redis;
  }
  try {
    const { Redis } = await import("@upstash/redis");
    _redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    return _redis;
  } catch {
    _redis = false;
    return _redis;
  }
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
  if (!r) return; // modo stateless
  try {
    await r.set(K(obj.itinerary_id), obj, { ex: 60 * 60 * 24 }); // 24h
  } catch {}
}

// =============== Utilidades generales ===============
function uuid() {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  // fallback simple
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

// Parser tolerante (acepta string JSON, bloque {...} u objeto)
function cleanToJSONPlus(raw) {
  if (!raw) return null;
  if (typeof raw === "object") {
    try {
      return JSON.parse(JSON.stringify(raw));
    } catch {
      return raw;
    }
  }
  if (typeof raw !== "string") return null;
  let s = raw.trim();
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
    destination: city || "Destino",
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

// Duraciones limpias
function stripApproxDuration(d = "") {
  if (!d) return d;
  return String(d).replace(/[~≈]/g, "").trim();
}

// =============== Transporte & Subparadas & Duraciones extra ===============
const NO_BUS_TOPICS = [
  "círculo dorado", "thingvellir", "þingvellir", "geysir", "geyser",
  "gullfoss", "seljalandsfoss", "skógafoss", "reynisfjara", "vik", "vík",
  "snaefellsnes", "snæfellsnes", "blue lagoon", "reykjanes", "krýsuvík",
  "arnarstapi", "hellnar", "djúpalónssandur", "djupalonssandur",
  "kirkjufell", "puente entre continentes"
];

function needsVehicleOrTour(row) {
  const a = (row.activity || "").toLowerCase();
  const to = (row.to || "").toLowerCase();
  return NO_BUS_TOPICS.some((k) => a.includes(k) || to.includes(k));
}

function coerceTransport(rows) {
  return rows.map((r) => {
    const t = String(r.transport || "").toLowerCase();
    if ((!t || t.includes("bus")) && needsVehicleOrTour(r)) {
      return { ...r, transport: "Vehículo alquilado o Tour guiado" };
    }
    return r;
  });
}

function enforceMotherSubstopFormat(rows) {
  const out = [...rows];
  for (let i = 0; i < out.length; i++) {
    const r = out[i];
    const act = (r.activity || "").toLowerCase();
    const isExc = /excursión/.test(act) || /day\s*trip/i.test(act);
    if (!isExc) continue;

    const rawName = (r.activity || "").trim();
    const routeBase =
      rawName.replace(/^excursión\s*(a|al)?\s*/i, "").split("—")[0].trim() ||
      "Ruta";

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

// Duraciones del regreso si FACTS trae hints
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

  return rows.map((r) => {
    const act = (r.activity || "").toLowerCase();
    const to = (r.to || "").toLowerCase();
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

function normalizeShapeContract(parsed, rowsFixed, prev = null) {
  const destination =
    parsed?.destination ||
    parsed?.destinations?.[0]?.name ||
    prev?.destination ||
    "Destino";

  const itinerary_id = parsed?.itinerary_id || prev?.itinerary_id || uuid();
  const version =
    typeof parsed?.version === "number"
      ? parsed.version
      : typeof prev?.version === "number"
      ? prev.version + 1
      : 1;

  return {
    itinerary_id,
    version,
    destination,
    rows: rowsFixed,
    followup: parsed?.followup || "",
  };
}

// =============== Prompts ===============
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

Reglas duras:
- Siempre >= 1 actividad en "rows" (si no hay nada claro, sintetiza 1-2 filas plausibles).
- Máx 20 actividades por día. Horas coherentes (08:30–19:00 si no hay otros datos).
- "duration" limpio: "1h45m" o "30m".
- Si FACTS no cubre una pareja exacta, estima tiempos coherentes.
- Day-trip fuera de ciudad: agrega "Regreso a {Ciudad}" con transporte correcto.
- Para rutas largas, usa formato madre/hijas: "Excursión — {Ruta} — {Subparada}" (hasta 8).
`.trim();

// =============== Llamadas Modelo ===============
async function chatJSON(messages, temperature = 0.4, tries = 2) {
  for (let k = 0; k < Math.max(1, tries); k++) {
    try {
      const resp = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature,
        response_format: { type: "json_object" },
        messages: messages.map((m) => ({
          role: m.role,
          content: String(m.content ?? ""),
        })),
        max_tokens: 2600,
      });
      const text = resp?.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    } catch (e) {
      if (k === tries - 1) throw e;
    }
  }
  return "";
}

async function chatFree(messages, temperature = 0.6, tries = 1) {
  for (let k = 0; k < Math.max(1, tries); k++) {
    try {
      const resp = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature,
        messages: messages.map((m) => ({
          role: m.role,
          content: String(m.content ?? ""),
        })),
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

// =============== Handler principal ===============
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body || {};
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    // ===== Modo INFO (respuestas libres para Info Chat) =====
    if (mode === "info") {
      try {
        const raw = await chatFree(clientMessages, 0.5, 1);
        return res.status(200).json({ text: raw || "⚠️ No se obtuvo respuesta." });
      } catch (e) {
        return res.status(200).json({ text: "⚠️ No se obtuvo respuesta." });
      }
    }

    // ===== Metadata opcional para estado =====
    const incomingId = typeof body.itinerary_id === "string" ? body.itinerary_id : null;
    const incomingVersion =
      typeof body.version === "number" && isFinite(body.version)
        ? body.version
        : null;

    // Carga estado previo si existe (solo si hay Redis)
    const prevState = incomingId ? await storeLoad(incomingId) : null;

    // ===== Paso 1: PRE-INFO (investigación + seed)
    let pre = null;
    try {
      const preRaw = await chatJSON(
        [{ role: "system", content: PRE_INFO_PROMPT }, ...clientMessages],
        0.35,
        1
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
      const rows = (s.rows || []).map((r) => ({
        ...r,
        duration: stripApproxDuration(r.duration),
      }));
      return { destination: s.destination || "", rows };
    })();

    const FACTS = JSON.stringify(factsMerged);
    const SEED = seedMerged ? JSON.stringify(seedMerged) : "";

    // ===== Modo PATCH (ajustes sobre tabla previa con versionado) =====
    if (mode === "patch") {
      // Requiere itinerary_id válido y versión
      if (!incomingId || incomingVersion == null) {
        const fb = fallbackJSON(seedMerged?.destination || "Destino");
        return res.status(200).json({ text: JSON.stringify(fb) });
      }

      // Si hay estado durable, compara versiones
      if (prevState && typeof prevState.version === "number") {
        if (incomingVersion < prevState.version) {
          // Versión vieja → devolvemos estado actual sin aplicar
          return res
            .status(200)
            .json({ text: JSON.stringify(prevState) });
        }
      }

      // PATCH: el usuario pidió un cambio; pedimos al modelo que
      // ajuste EN FUNCIÓN de la tabla previa (de body.rows o prevState.rows)
      const baseRows =
        Array.isArray(body.rows) && body.rows.length
          ? body.rows
          : Array.isArray(prevState?.rows)
          ? prevState.rows
          : [];

      const opText =
        typeof body.operation === "string"
          ? body.operation
          : clientMessages[clientMessages.length - 1]?.content || "";

      const patchSystem = `
Eres Astra (MODO PATCH).
Ajusta la tabla existente según la instrucción del usuario SIN borrar lo demás.
Devuelve únicamente JSON: {"destination":"...","rows":[...],"followup":""}
- Mantén formato, horas plausibles, y agrega "Regreso a {Ciudad}" si sales fuera.
- No devuelvas texto fuera del JSON.
`;
      const patchUser = `
DESTINO: ${seedMerged?.destination || prevState?.destination || "Destino"}
TABLA_ACTUAL:
${JSON.stringify(baseRows, null, 2)}

INSTRUCCIÓN_USUARIO:
${opText}

Devuelve {"destination":"...","rows":[...],"followup":""}
`.trim();

      let patched = null;
      try {
        const raw = await chatJSON(
          [
            { role: "system", content: patchSystem },
            { role: "system", content: `FACTS=${FACTS}` },
            ...(SEED ? [{ role: "system", content: `SEED=${SEED}` }] : []),
            { role: "user", content: patchUser },
          ],
          0.35,
          2
        );
        patched = cleanToJSONPlus(raw);
      } catch {}

      if (!patched) patched = { destination: prevState?.destination || "Destino", rows: baseRows, followup: "⚠️ Patch sin cambios (fallback)" };

      // Post-proceso
      let rows = Array.isArray(patched.rows) ? patched.rows : [];
      rows = rows.map((r) => ({ ...r, duration: stripApproxDuration(r.duration) }));
      rows = coerceTransport(enforceMotherSubstopFormat(rows));
      rows = applyReturnDurationsFromFacts(rows, factsMerged);

      // Siempre al menos 1 fila
      if (!rows.length) {
        rows.push({
          day: 1,
          start: "09:00",
          end: "10:30",
          activity: "Ajuste mínimo aplicado",
          from: "",
          to: "",
          transport: "A pie",
          duration: "90m",
          notes: "Fila sintética para mantener consistencia.",
        });
      }

      const final = normalizeShapeContract(patched, rows, prevState || null);

      // Persistir si hay Redis
      await storeSave(final);

      return res.status(200).json({ text: JSON.stringify(final) });
    }

    // ===== Paso 2: PLANNER (consume FACTS + SEED) =====
    let parsed = null;
    try {
      const plannerRaw = await chatJSON(
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "system", content: `FACTS=${FACTS}` },
          ...(SEED ? [{ role: "system", content: `SEED=${SEED}` }] : []),
          ...clientMessages,
        ],
        0.35,
        2
      );
      parsed = cleanToJSONPlus(plannerRaw);
    } catch {}

    // Fallback duro si no hay parsed
    if (!parsed) parsed = { destination: seedMerged?.destination || "Destino", rows: seedMerged?.rows || [] };

    // Post-proceso clásico
    let rows = Array.isArray(parsed.rows)
      ? parsed.rows
      : Array.isArray(parsed?.destinations?.[0]?.rows)
      ? parsed.destinations[0].rows
      : [];

    rows = rows.map((r) => ({ ...r, duration: stripApproxDuration(r.duration) }));
    rows = coerceTransport(enforceMotherSubstopFormat(rows));
    rows = applyReturnDurationsFromFacts(rows, factsMerged);

    // Siempre al menos 1 fila
    if (!rows.length) {
      rows.push({
        day: 1,
        start: "09:00",
        end: "10:30",
        activity: "Inicio de exploración",
        from: "",
        to: "",
        transport: "A pie",
        duration: "90m",
        notes: "Fila sintética para garantizar render.",
      });
    }

    // Normalizamos al contrato y asignamos ID/versión
    const prevForContract =
      prevState ||
      (incomingId && {
        itinerary_id: incomingId,
        version: incomingVersion ?? 0,
        destination: seedMerged?.destination || "Destino",
      }) ||
      null;

    const finalJSON = normalizeShapeContract(parsed, rows, prevForContract);

    // Persistir si hay Redis
    await storeSave(finalJSON);

    // Salida EXACTA que tu UI espera (string en "text")
    return res.status(200).json({ text: JSON.stringify(finalJSON) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    const fb = fallbackJSON("Destino");
    return res.status(200).json({ text: JSON.stringify(fb) });
  }
}
