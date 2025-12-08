// /api/chat.js — v42.2 (render-ready, fallback blindado, coherente con planner.js v75)
// Cambios clave vs v42.1:
// 1) Inserción automática de “Regreso a {Ciudad}” si falta en day-trips (con heurística).
// 2) Límite duro de 20 actividades por día (compactación soft de excedentes).
// 3) Normalización robusta de duraciones a patrón "HhMm" / "Xm" (corrige 'about 1 hr', '90 min', etc.).
// 4) Uso de other_hints (ventanas horarias y notas) en post-proceso.
// 5) Heurística de respaldo cuando facts.daytrip_patterns esté incompleto.
//
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

/* ======================================================
   DURACIONES: normalización robusta
====================================================== */
function stripApproxDuration(d = "") {
  return d ? String(d).replace(/[~≈≈]/g, "").trim() : d;
}
function normalizeDurationToken(token) {
  if (!token) return "";
  let s = String(token).toLowerCase().trim();
  s = s.replace(/[~≈]/g, "").replace(/\b(about|around|aprox\.?|aprox|approximately|approx)\b/g, "").trim();
  s = s.replace(/hours?\b/g, "h").replace(/hrs?\b/g, "h").replace(/\bhr\b/g, "h");
  s = s.replace(/minutes?\b/g, "m").replace(/\bmins?\b/g, "m").replace(/\bmin\b/g, "m");
  s = s.replace(/\s+/g, "");
  // patterns: "1h30m", "90m", "1.5h", "1:30"
  const mColon = s.match(/^(\d+):(\d{1,2})$/);
  if (mColon) {
    const h = parseInt(mColon[1], 10);
    const m = parseInt(mColon[2], 10);
    return h > 0 ? `${h}h${m ? `${m}m` : ""}` : `${m}m`;
  }
  const mHourDec = s.match(/^(\d+(?:\.\d+)?)h$/);
  if (mHourDec) {
    const dec = parseFloat(mHourDec[1]);
    const h = Math.floor(dec);
    const m = Math.round((dec - h) * 60);
    return h > 0 ? `${h}h${m ? `${m}m` : ""}` : `${m}m`;
  }
  const mH = s.match(/^(\d+)h(?:((\d+)m)?)$/);
  if (mH) return `${parseInt(mH[1], 10)}h${mH[2] ? mH[2] : ""}`;
  const mM = s.match(/^(\d+)m$/);
  if (mM) return `${parseInt(mM[1], 10)}m`;
  const mMix = s.match(/^(\d+)h(\d{1,2})$/); // "1h30"
  if (mMix) return `${parseInt(mMix[1], 10)}h${parseInt(mMix[2], 10)}m`;
  const justNum = s.match(/^(\d+)$/); // assume minutes
  if (justNum) {
    const mins = parseInt(justNum[1], 10);
    if (mins >= 60) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return h > 0 ? `${h}h${m ? `${m}m` : ""}` : `${m}m`;
    }
    return `${mins}m`;
  }
  return ""; // indeterminado -> se resolverá luego
}
function normalizeDurations(rows) {
  return rows.map((r) => {
    const raw = r.duration ?? "";
    const cleaned = stripApproxDuration(raw);
    const norm = normalizeDurationToken(cleaned);
    return { ...r, duration: norm || (cleaned || "").replace(/\s+/g, "") || "" };
  });
}

/* ======================================================
   TRANSPORTE, SUBPARADAS, HEURÍSTICAS Y FACTS
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
  if (/^regreso a/i.test(a)) return false;
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

/* ======================================================
   HEURÍSTICA: inserción de “Regreso a {Ciudad}” y duraciones
====================================================== */
function inferBaseCity(facts, fallback) {
  const b = (facts?.base_city || "").trim();
  return b || (fallback || "Ciudad");
}
function hasReturnRowForDay(rows, day, baseCity) {
  const bc = baseCity.toLowerCase();
  return rows.some(
    (r) =>
      r.day === day &&
      /^regreso a/i.test(String(r.activity || "")) &&
      String(r.to || "").toLowerCase().includes(bc)
  );
}
function guessLastStopOfDay(rows, day) {
  // Último 'to' no vacío del día
  const sameDay = rows.filter((r) => r.day === day);
  for (let i = sameDay.length - 1; i >= 0; i--) {
    const to = (sameDay[i].to || "").trim();
    if (to) return to;
  }
  return "";
}
function durationFromFacts(facts, fromPlace, baseCity) {
  const patterns = Array.isArray(facts?.daytrip_patterns)
    ? facts.daytrip_patterns
    : [];
  const key = `${fromPlace}→${baseCity}`;
  for (const p of patterns) {
    const dur = p?.durations?.[key];
    if (dur) return normalizeDurationToken(dur) || dur;
  }
  return ""; // desconocido
}
function looksLikeDayTrip(rows, day, baseCity) {
  // Si hay "Excursión —" o movimientos fuera de base y no hay regreso
  const bc = baseCity.toLowerCase();
  const sameDay = rows.filter((r) => r.day === day);
  const excursion = sameDay.some((r) => /excursión|day\s*trip/i.test(String(r.activity || "")));
  const leavesBase = sameDay.some((r) => String(r.to || "").toLowerCase() && !String(r.to || "").toLowerCase().includes(bc));
  return excursion || leavesBase;
}
function ensureReturnToBase(rows, facts, destination) {
  const baseCity = inferBaseCity(facts, destination);
  const out = [...rows];
  const days = Array.from(new Set(out.map((r) => r.day))).filter((d) => d != null);
  for (const day of days) {
    if (!looksLikeDayTrip(out, day, baseCity)) continue;
    if (hasReturnRowForDay(out, day, baseCity)) continue;
    // insertar regreso al final del día
    const lastStop = guessLastStopOfDay(out, day) || "Última parada";
    let dur = durationFromFacts(facts, lastStop, baseCity);
    if (!dur) {
      // heurística de respaldo si no hay facts.durations
      // 60m si es cercano; 90m si hay palabras clave largas
      const longish = /gullfoss|seljalandsfoss|skógafoss|reynisfjara|snaefellsnes|blue lagoon|kirkjufell/i.test(lastStop);
      dur = longish ? "90m" : "60m";
    }
    out.push({
      day,
      start: "18:00",
      end: "19:00",
      activity: `Regreso a ${baseCity}`,
      from: lastStop,
      to: baseCity,
      transport: "Vehículo alquilado o Tour guiado",
      duration: dur,
      notes: "Retorno a la ciudad base para cerrar el day-trip.",
    });
  }
  return out;
}

/* ======================================================
   REGLAS DE VENTANAS HORARIAS (other_hints)
====================================================== */
const DEFAULT_WINDOW = { start: "08:30", end: "19:00" };
function parseWindowFromHints(other_hints) {
  if (!Array.isArray(other_hints)) return DEFAULT_WINDOW;
  // Buscar patrones tipo "08:30–19:00"
  for (const h of other_hints) {
    const m = String(h || "").match(/(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})/);
    if (m) return { start: m[1], end: m[2] };
  }
  return DEFAULT_WINDOW;
}
function clampTime(t) {
  // retorna HH:MM si válido, si no, null
  const m = String(t || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  let H = parseInt(m[1], 10);
  let M = parseInt(m[2], 10);
  if (H < 0 || H > 23 || M < 0 || M > 59) return null;
  return `${H.toString().padStart(2, "0")}:${M.toString().padStart(2, "0")}`;
}
function enforceWindow(rows, window) {
  const wStart = clampTime(window.start) || DEFAULT_WINDOW.start;
  const wEnd = clampTime(window.end) || DEFAULT_WINDOW.end;
  return rows.map((r) => {
    const s = clampTime(r.start) || wStart;
    const e = clampTime(r.end) || wEnd;
    return { ...r, start: s, end: e };
  });
}

/* ======================================================
   LÍMITE DE 20 FILAS POR DÍA (compactación soft)
====================================================== */
function enforceMaxPerDay(rows, max = 20) {
  const out = [];
  const byDay = new Map();
  for (const r of rows) {
    const d = r.day ?? 1;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(r);
  }
  for (const [day, list] of byDay.entries()) {
    if (list.length <= max) {
      out.push(...list);
      continue;
    }
    const head = list.slice(0, max - 1);
    const tail = list.slice(max - 1);
    const summary = {
      day,
      start: "17:30",
      end: "19:00",
      activity: "Continuación — Compactación de actividades",
      from: head.at(-1)?.to || "",
      to: head.at(-1)?.to || "",
      transport: "A pie",
      duration: "90m",
      notes: `Se agruparon ${tail.length} actividades adicionales para mantener el límite máximo diario.`,
    };
    out.push(...head, summary);
  }
  // Reordenar por day y por hora (simple)
  out.sort((a, b) => (a.day - b.day) || String(a.start).localeCompare(String(b.start)));
  return out;
}

/* ======================================================
   CONTRATO FINAL
====================================================== */
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
- Máx 20 actividades por día (si tienes más, resume al final).
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

    // Derivar ventana horaria desde other_hints (o default)
    const WINDOW = parseWindowFromHints(facts.other_hints);

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
      // Normalizaciones y reglas
      rows = normalizeDurations(rows);
      rows = coerceTransport(enforceMotherSubstopFormat(rows));
      rows = ensureReturnToBase(rows, facts, seed?.destination || prevState?.destination || "Destino");
      rows = enforceWindow(rows, WINDOW);
      rows = enforceMaxPerDay(rows, 20);

      if (!rows.length)
        rows.push({
          day: 1,
          start: WINDOW.start,
          end: WINDOW.end,
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

    // Normalizaciones y reglas
    rows = normalizeDurations(rows);
    rows = coerceTransport(enforceMotherSubstopFormat(rows));
    rows = ensureReturnToBase(rows, facts, parsed?.destination || seed?.destination || "Destino");
    rows = enforceWindow(rows, WINDOW);
    rows = enforceMaxPerDay(rows, 20);

    if (!rows.length)
      rows.push({
        day: 1,
        start: WINDOW.start,
        end: WINDOW.end,
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
