// /api/chat.js — v30.15 (ESM compatible en Vercel)
// Base exacta: v30.14 (se conservan nombres, flujo y lógica).
// Refuerzos clave:
// - Planificador heurístico local (última red) que usa FACTS_DEFAULT para crear itinerarios válidos sin API.
// - Retries robustos en research/planner + plantilla mínima.
// - Duraciones de regreso desde FACTS + limpieza de notas/duraciones.
// - Estructura "Excursión — Ruta — Subparada" en hijas, máx. 8.

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
    if (obj.rows || obj.destinations || obj.facts) return obj;
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
    rows: [{
      day: 1, start: "08:30", end: "19:00",
      activity: "Itinerario base (fallback)", from: "", to: "",
      transport: "", duration: "", notes: "Explora la ciudad."
    }],
    followup: "⚠️ Fallback local."
  };
}

// ==============================
// LÓGICA POST-PROCESO (auroras, transporte, subparadas, limpieza)
// ==============================
const AURORA_DESTINOS = [
  "reykjavik","reykjavík","tromso","tromsø","rovaniemi","kiruna",
  "abisko","alta","ivalo","yellowknife","fairbanks","akureyri"
];

function auroraNightsByLength(totalDays) {
  if (totalDays <= 2) return 1;
  if (totalDays <= 4) return 2;
  if (totalDays <= 6) return 2;
  if (totalDays <= 9) return 3;
  return 3;
}

function planAuroraDays(totalDays, count) {
  const start = (totalDays % 2 === 0) ? 1 : 2;
  const out = [];
  for (let d = start; out.length < count && d < totalDays; d += 2) out.push(d);
  return out;
}

const AURORA_NOTE_SHORT =
  "Noche especial de caza de auroras. Con cielos despejados y paciencia, podrás presenciar un espectáculo natural inolvidable. " +
  "La hora de regreso al hotel dependerá del tour elegido. " +
  "Puedes optar por tour guiado o movilización por tu cuenta (conducirás de noche y con posible nieve; verifica seguridad para tus fechas).";

function isAuroraRow(r) {
  const t = (r?.activity || "").toLowerCase();
  return t.includes("aurora");
}

const NO_BUS_TOPICS = [
  "círculo dorado","thingvellir","þingvellir","geysir","geyser",
  "gullfoss","seljalandsfoss","skógafoss","reynisfjara",
  "vik","vík","snaefellsnes","snæfellsnes","blue lagoon",
  "reykjanes","krýsuvík","arnarstapi","hellnar","djúpalónssandur",
  "kirkjufell","puente entre continentes","gunnuhver"
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

/** Estructura madre-hijas “Excursión — Ruta — Subparada” (máx. 8 hijas consecutivas). */
function enforceMotherSubstopFormat(rows) {
  const out = [...rows];
  for (let i = 0; i < out.length; i++) {
    const r = out[i];
    const act = (r.activity || "").toLowerCase();
    if (!/excursión/.test(act)) continue;

    const rawName = (r.activity || "").trim();
    const routeBase = rawName
      .replace(/^excursión\s*(a|al)?\s*/i, "")
      .split("—")[0]
      .trim() || "Ruta";

    let count = 0;
    for (let j = i + 1; j < out.length && count < 8; j++) {
      const rj = out[j];
      const aj = (rj?.activity || "").toLowerCase();
      const isSub =
        aj.startsWith("visita") || aj.includes("cascada") || aj.includes("playa") ||
        aj.includes("geysir") || aj.includes("thingvellir") || aj.includes("gullfoss") ||
        aj.includes("kirkjufell") || aj.includes("arnarstapi") || aj.includes("hellnar") ||
        aj.includes("djúpalónssandur") || aj.includes("djupalonssandur") ||
        aj.includes("vík") || aj.includes("vik") || aj.includes("reynisfjara") ||
        aj.includes("blue lagoon") || aj.includes("gunnuhver") || aj.includes("puente entre continentes");
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

// --- FACTS locales por defecto (cobertura Islandia) ---
const FACTS_DEFAULT = {
  base_city: "Reykjavík",
  daytrip_patterns: [
    {
      route: "Círculo Dorado",
      stops: ["Þingvellir","Geysir","Gullfoss"],
      return_to_base_from: "Gullfoss",
      durations: {
        "Reykjavík→Þingvellir": "1h",
        "Þingvellir→Geysir": "1h15m",
        "Geysir→Gullfoss": "25m",
        "Gullfoss→Reykjavík": "1h30m"
      }
    },
    {
      route: "Costa Sur",
      stops: ["Seljalandsfoss","Skógafoss","Reynisfjara","Vík"],
      return_to_base_from: "Vík",
      durations: {
        "Reykjavík→Seljalandsfoss": "1h45m",
        "Seljalandsfoss→Skógafoss": "30m",
        "Skógafoss→Reynisfjara": "45m",
        "Reynisfjara→Vík": "15m",
        "Vík→Reykjavík": "2h45m"
      }
    },
    {
      route: "Snæfellsnes",
      stops: ["Kirkjufell","Arnarstapi","Hellnar","Djúpalónssandur"],
      return_to_base_from: "Djúpalónssandur",
      durations: {
        "Reykjavík→Kirkjufell": "2h10m",
        "Kirkjufell→Arnarstapi": "45m",
        "Arnarstapi→Hellnar": "10m",
        "Hellnar→Djúpalónssandur": "20m",
        "Djúpalónssandur→Reykjavík": "2h30m"
      }
    },
    {
      route: "Reykjanes / Blue Lagoon",
      stops: ["Blue Lagoon","Gunnuhver","Puente entre continentes"],
      return_to_base_from: "Puente entre continentes",
      durations: {
        "Reykjavík→Blue Lagoon": "50m",
        "Blue Lagoon→Gunnuhver": "20m",
        "Gunnuhver→Puente entre continentes": "15m",
        "Puente entre continentes→Reykjavík": "50m"
      }
    }
  ],
  other_hints: [
    "Usa 'Vehículo alquilado o Tour guiado' para day-trips icónicos en Islandia"
  ]
};

/** Fija duración en filas “Regreso a {base}” usando FACTS. */
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
    const durationKnown = r.duration && /^[0-9]+h([0-5][0-9]m)?$|^[0-9]+m$/i.test(r.duration.replace(/\s/g,""));

    if (!durationKnown) {
      const best = toBase[prevTo] || null;
      if (best) return { ...r, duration: best };
    }
    return r;
  });
}

function ensureAuroras(parsed) {
  const dest =
    (parsed?.destination || parsed?.Destination || parsed?.city || parsed?.name || "").toString();
  const destName = dest || (parsed?.destinations?.[0]?.name || "");
  const low = destName.toLowerCase();

  const rows = Array.isArray(parsed?.rows)
    ? parsed.rows
    : Array.isArray(parsed?.destinations?.[0]?.rows)
      ? parsed.destinations[0].rows
      : [];

  if (!rows.length) return parsed;

  const totalDays = Math.max(...rows.map(r => Number(r.day) || 1));
  const isAuroraPlace = AURORA_DESTINOS.some(x => low.includes(x));

  let base = rows.map(r => ({
    ...r,
    duration: stripApproxDuration(r.duration),
    notes: scrubBlueLagoon(scrubAuroraValid(r.notes))
  }));

  // Transporte coherente y formato madre-subparadas
  base = coerceTransport(enforceMotherSubstopFormat(base));

  if (!isAuroraPlace) return normalizeShape(parsed, base);

  base = base.filter(r => !isAuroraRow(r));
  const targetCount = auroraNightsByLength(totalDays);
  const targetDays = planAuroraDays(totalDays, targetCount);

  for (const d of targetDays) {
    base.push({
      day: d,
      start: "18:00",
      end: "01:00",
      activity: "Caza de auroras boreales",
      from: "Hotel",
      to: "Puntos de observación (variable)",
      transport: "Vehículo alquilado o Tour guiado",
      duration: "7h",
      notes: AURORA_NOTE_SHORT,
    });
  }

  base.sort((a, b) => (a.day - b.day) || (a.start || "").localeCompare(b.start || ""));
  return normalizeShape(parsed, base);
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
// Prompts
// ==============================
const RESEARCH_PROMPT = `
Eres un asistente turístico experto. Analiza el destino y devuelve **solo JSON** con tiempos realistas de traslado.
Formato:
{"facts":{"base_city":"<ciudad>","daytrip_patterns":[{"route":"Círculo Dorado","stops":["Þingvellir","Geysir","Gullfoss"],"return_to_base_from":"Gullfoss","durations":{"Reykjavík→Þingvellir":"1h"}}],"other_hints":[]}}
`.trim();

const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn. Salida: **solo JSON válido**.

Dispones de un bloque FACTS con tiempos y patrones turísticos (investigación previa). Úsalo para
establecer **duraciones concretas** entre paradas y en "Regreso a {Ciudad}".

Formato:
{"destination":"City","rows":[{...}],"followup":"texto breve"}

Reglas:
- Al menos 1 actividad en "rows". Sin texto fuera de JSON.
- Máx. 20 actividades por día. Horas realistas (08:30–19:00 si no se especifica).
- "duration" sin "~" ni "≈" (usa "1h45m", "30m", etc.).
- Transporte coherente (en day-trips de Islandia: "Vehículo alquilado o Tour guiado").
- AURORAS: noches alternas por paridad; 18:00–01:00; sin “valid: ventana…”.
- DESTINO–SUBPARADAS: usa "Excursión — {Ruta} — {Subparada}" en cada hija (hasta 8) y luego "Regreso a {Ciudad}" con el tiempo real de FACTS.
`.trim();

// ==============================
// Llamadas al modelo con retries
// ==============================
async function chatJSON(messages, temperature = 0.35, tries = 2) {
  for (let k = 0; k < Math.max(1, tries); k++) {
    try {
      const resp = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature,
        response_format: { type: "json_object" },
        messages: messages.map(m => ({ role: m.role, content: String(m.content ?? "") })),
        max_tokens: 3200,
      });
      const text = resp?.choices?.[0]?.message?.content?.trim();
      if (text) return text;
    } catch (e) {
      if (k === tries - 1) throw e;
    }
  }
  return "";
}

async function chatFree(messages, temperature = 0.5, tries = 2) {
  for (let k = 0; k < Math.max(1, tries); k++) {
    try {
      const resp = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature,
        messages: messages.map(m => ({ role: m.role, content: String(m.content ?? "") })),
        max_tokens: 3200,
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
// Planificador heurístico local (última red — sin API)
// Usa FACTS (defaults o investigados) y genera 4–5 días desde Reykjavík.
// ==============================
function localHeuristicPlan(facts, wantedDestination = "Reykjavík", days = 5) {
  const base = facts?.base_city || "Reykjavík";
  const patterns = Array.isArray(facts?.daytrip_patterns) ? facts.daytrip_patterns : [];
  const rows = [];
  let day = 1;

  // Día 1: ciudad (walk)
  rows.push(
    { day, start:"08:30", end:"10:30", activity:"Visita a Hallgrímskirkja", from:"Hotel", to:"Hallgrímskirkja", transport:"A pie", duration:"2h", notes:"Sube a la torre para vistas." },
    { day, start:"10:45", end:"12:15", activity:"Paseo por Laugavegur", from:"Hallgrímskirkja", to:"Laugavegur", transport:"A pie", duration:"1h30m", notes:"Calle comercial y cafés." },
    { day, start:"12:30", end:"13:30", activity:"Almuerzo en restaurante local", from:"Laugavegur", to:"Restaurante local", transport:"A pie", duration:"1h", notes:"Prueba platos islandeses." },
    { day, start:"13:45", end:"15:45", activity:"Visita al Museo Nacional", from:"Restaurante local", to:"Museo Nacional", transport:"A pie", duration:"2h", notes:"Historia y cultura islandesa." },
    { day, start:"16:00", end:"17:30", activity:"Paseo por el puerto antiguo", from:"Museo Nacional", to:"Puerto antiguo", transport:"A pie", duration:"1h30m", notes:"Vistas al mar y montañas." },
    { day, start:"17:45", end:"19:00", activity:"Cena en restaurante del puerto", from:"Puerto antiguo", to:"Restaurante del puerto", transport:"A pie", duration:"1h15m", notes:"Mariscos frescos." },
  );

  // Días siguientes: usar hasta 3 patrones (Círculo Dorado, Costa Sur, Snæfellsnes o Reykjanes).
  const pick = (name) => patterns.find(p => p.route.toLowerCase().includes(name.toLowerCase()));
  const order = [ "Círculo Dorado", "Costa Sur", "Snæfellsnes", "Reykjanes" ];
  for (let idx = 0; idx < order.length && day < Math.min(days, 5); idx++) {
    const pat = pick(order[idx]) || null;
    if (!pat) continue;
    day += 1;
    const route = pat.route;
    // Madre
    rows.push({ day, start:"08:30", end:"10:30", activity:`Excursión — ${route}`, from: base, to: pat.stops?.[0] || route, transport:"Vehículo alquilado o Tour guiado", duration:"2h", notes:`Ruta de día completo por ${route}.` });
    // Hijas (subparadas)
    let tstart = 10*60 + 45; // 10:45 en minutos
    for (let i = 0; i < Math.min(8, (pat.stops || []).length); i++) {
      const stop = pat.stops[i];
      rows.push({
        day,
        start: minutesToHHMM(tstart),
        end: minutesToHHMM(tstart + 90),
        activity: `Excursión — ${route} — ${stop}`,
        from: i === 0 ? (pat.stops[0] || base) : (pat.stops[i-1]),
        to: stop,
        transport: "Vehículo alquilado o Tour guiado",
        duration: "1h30m",
        notes: "Parada dentro de la ruta."
      });
      tstart += 90;
      if (i === 0) { // slot para almuerzo hacia mediodía
        rows.push({
          day, start: "12:30", end: "13:30",
          activity: "Almuerzo en ruta", from: stop, to: "Restaurante local",
          transport: "A pie", duration: "1h", notes: "Descanso de mediodía."
        });
        tstart = 13*60 + 45;
      }
    }
    // Regreso
    rows.push({
      day, start: "17:15", end: "19:00",
      activity: `Regreso a ${base}`, from: pat.return_to_base_from || (pat.stops?.slice(-1)[0] || route),
      to: base, transport: "Vehículo alquilado o Tour guiado",
      duration: pat.durations?.[`${pat.return_to_base_from || (pat.stops?.slice(-1)[0] || route)}→${base}`] || "",
      notes: "Regreso a la ciudad."
    });
  }

  // Inserta noche de auroras por paridad (si aplica)
  const parsed = ensureAuroras({ destination: wantedDestination || base, rows });
  // Ajusta duraciones de regreso con FACTS
  parsed.rows = applyReturnDurationsFromFacts(parsed.rows, facts || FACTS_DEFAULT);
  return parsed;
}

function minutesToHHMM(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
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

    // ===== INFO MODE =====
    if (mode === "info") {
      try {
        const raw = await chatFree(clientMessages, 0.5, 2);
        return res.status(200).json({ text: raw || "⚠️ No se obtuvo respuesta." });
      } catch {
        return res.status(200).json({ text: "⚠️ No se obtuvo respuesta." });
      }
    }

    // ===== Paso 1: INVESTIGACIÓN (FACTS) =====
    let researchParsed = null;
    try {
      const researchRaw = await chatJSON(
        [{ role: "system", content: RESEARCH_PROMPT }, ...clientMessages],
        0.4, 2
      );
      researchParsed = cleanToJSONPlus(researchRaw);
    } catch {}
    // Merge con defaults (si hay colisión, mantenemos defaults + añadimos extras)
    const factsMerged = (() => {
      const m = (researchParsed && researchParsed.facts) ? researchParsed.facts : {};
      const out = { ...FACTS_DEFAULT, ...m };
      if (FACTS_DEFAULT.daytrip_patterns && m?.daytrip_patterns) {
        const titles = new Set(FACTS_DEFAULT.daytrip_patterns.map(p => p.route));
        const extra = m.daytrip_patterns.filter(p => !titles.has(p.route));
        out.daytrip_patterns = [...FACTS_DEFAULT.daytrip_patterns, ...extra];
      }
      return out;
    })();
    const FACTS = JSON.stringify(factsMerged);

    // ===== Paso 2: PLANNER (forzamos JSON e inyectamos FACTS) =====
    let parsed = null;
    try {
      let raw = await chatJSON(
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "system", content: `FACTS=${FACTS}` },
          ...clientMessages
        ],
        0.35, 2
      );
      parsed = cleanToJSONPlus(raw);

      const hasRows = parsed && (parsed.rows || parsed.destinations);
      if (!hasRows) {
        const strict = SYSTEM_PROMPT + `\nOBLIGATORIO: JSON único con "destination" y ≥1 fila en "rows".`;
        raw = await chatJSON(
          [
            { role: "system", content: strict },
            { role: "system", content: `FACTS=${FACTS}` },
            ...clientMessages
          ],
          0.2, 2
        );
        parsed = cleanToJSONPlus(raw);
      }

      const stillNo = !parsed || (!parsed.rows && !parsed.destinations);
      if (stillNo) {
        const ultra = SYSTEM_PROMPT + `\n{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora"}]}`;
        raw = await chatJSON(
          [
            { role: "system", content: ultra },
            { role: "system", content: `FACTS=${FACTS}` },
            ...clientMessages
          ],
          0.1, 1
        );
        parsed = cleanToJSONPlus(raw);
      }
    } catch {}

    // ===== Última red: plan local sin API =====
    if (!parsed || (!parsed.rows && !parsed.destinations)) {
      // Intenta inferir destino del último mensaje del usuario
      const lastUser = [...clientMessages].reverse().find(m => m.role === "user")?.content || "";
      const guess = /reykjav/i.test(lastUser) ? "Reykjavík" : (factsMerged.base_city || "Destino");
      parsed = localHeuristicPlan(factsMerged, guess, 5);
    }

    // Post-proceso general
    let finalJSON = ensureAuroras(parsed);
    finalJSON.rows = applyReturnDurationsFromFacts(finalJSON.rows || [], factsMerged);

    return res.status(200).json({ text: JSON.stringify(finalJSON) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    // Devuelve JSON válido para no romper la UI
    return res.status(200).json({ text: JSON.stringify(localHeuristicPlan(FACTS_DEFAULT, "Reykjavík", 5)) });
  }
}
