// /api/chat.js — v30.15 (ESM compatible en Vercel)
// Base exacta: v30.13 → v30.14 (tuya) → v30.15 (este patch).
// Mantiene TODOS tus nombres, reglas y flujo. Cambios quirúrgicos anti-fallback:
// - Limpieza/parseo JSON más robusta (fences, relleno, primer/último brace, reparación).
// - Retries extra + "modo estricto" y "plantilla mínima" antes de caer en fallback.
// - Normalización final garantizada a {"destination","rows"} para que el planner no caiga.
// - Regex y utilidades endurecidas (durations válidas, sub-paradas ≤ 8, transporte coherente).
// - Se conserva: subparadas≤8, coerción transporte, auroras (paridad), limpieza de notas/duraciones,
//   FACTS locales por defecto (Islandia) y mezcla con investigación.

// ==============================
// Imports y cliente
// ==============================
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

/**
 * Intento robusto de convertir cualquier salida a JSON:
 * - Acepta objeto ya parseado
 * - Quita fences ``` y ```json
 * - Intenta parseo directo
 * - Extrae primer '{' ... último '}'
 * - Limpieza de bordes agresiva
 */
function cleanToJSONPlus(raw) {
  if (raw == null) return null;

  // Ya es objeto
  if (typeof raw === "object") {
    const obj = raw;
    if (obj.rows || obj.destinations || obj.facts || obj.itineraries || obj.destination) return obj;
    try { return JSON.parse(JSON.stringify(obj)); } catch { /* no-op */ }
  }

  if (typeof raw !== "string") return null;
  let s = raw.trim();

  // Quitar fences tipo ```json ... ``` o ``` ... ```
  s = s.replace(/```json\s*([\s\S]*?)```/gi, "$1");
  s = s.replace(/```\s*([\s\S]*?)```/g, "$1");

  // Intento directo
  try { return JSON.parse(s); } catch { /* sigue */ }

  // Primer '{' a último '}' (tolerante a texto alrededor)
  try {
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first >= 0 && last > first) {
      const slice = s.slice(first, last + 1);
      return JSON.parse(slice);
    }
  } catch { /* sigue */ }

  // Limpieza agresiva de bordes
  try {
    const cleaned = s.replace(/^[^{\[]+/, "").replace(/[^}\]]+$/, "");
    return JSON.parse(cleaned);
  } catch { /* no-op */ }

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
        notes: "Explora libremente la ciudad y descubre sus lugares más emblemáticos."
      }
    ],
    followup: "⚠️ Fallback controlado: revisa configuración o API Key."
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
  // en tu regla actual no quieres "valid: ..." para auroras en API (lo maneja el JS si hace falta)
  return text.replace(/valid:[^.\n\r]*auroral[^.\n\r]*\.?/gi, "").trim();
}

function scrubBlueLagoon(text = "") {
  if (!text) return text;
  // elimina duplicaciones del "min stay ~3h (ajustable)"
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
 * Garantiza el formato madre→subparadas SIN colapsar:
 * - Detecta fila madre con "Excursión".
 * - Hasta 8 filas hijas consecutivas → "Excursión — {Ruta} — {Subparada}".
 */
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

// --- FACTS locales por defecto (para evitar tiempos genéricos y asegurar regresos) ---
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

/**
 * Dado rows y FACTS, rellena "Regreso a {Ciudad}" con duración real cuando falte.
 */
function applyReturnDurationsFromFacts(rows, facts) {
  if (!facts || !facts.daytrip_patterns || !facts.base_city) return rows;
  const baseCity = (facts.base_city || "").toLowerCase();

  // Reverse lookup: stop -> duration to base
  const toBase = {};
  for (const p of facts.daytrip_patterns) {
    const from = p.return_to_base_from || (p.stops && p.stops[p.stops.length - 1]);
    const key = `${from}→${facts.base_city}`;
    const dur = p.durations?.[key];
    if (from && dur) toBase[from.toLowerCase()] = dur;
  }

  const DUR_RE = /^(\d+h(?:\d{1,2}m)?)|(^\d{1,2}m)$/i; // 1h, 1h30m, 45m

  return rows.map(r => {
    const act = (r.activity || "").toLowerCase();
    const to = (r.to || "").toLowerCase();
    const isReturn = act.startsWith("regreso a") && to.includes(baseCity);
    if (!isReturn) return r;

    const prevTo = (r.from || "").toLowerCase(); // muchas UIs ponen from=última parada
    const durationKnown = r.duration && DUR_RE.test(r.duration.replace(/\s/g, ""));
    if (!durationKnown) {
      const best = toBase[prevTo] || null;
      if (best) return { ...r, duration: best };
    }
    return r;
  });
}

function ensureAuroras(parsed) {
  const dest =
    (parsed?.destination || parsed?.Destination || parsed?.city || parsed?.name || "") + "";
  const destName = dest || (parsed?.destinations?.[0]?.name || "");
  const low = destName.toLowerCase();

  const rows =
    Array.isArray(parsed?.rows)
      ? parsed.rows
      : Array.isArray(parsed?.destinations?.[0]?.rows)
        ? parsed.destinations[0].rows
        : [];

  if (!rows.length) return parsed;

  const totalDays = Math.max(...rows.map(r => Number(r.day) || 1));
  const isAuroraPlace = AURORA_DESTINOS.some(x => low.includes(x));

  // limpieza común
  let base = rows.map(r => ({
    ...r,
    duration: stripApproxDuration(r.duration),
    notes: scrubBlueLagoon(scrubAuroraValid(r.notes))
  }));

  // transporte coherente + madre→subparadas
  base = coerceTransport(enforceMotherSubstopFormat(base));

  if (!isAuroraPlace) return normalizeShape(parsed, base);

  // reinyectar auroras por paridad (sin última noche)
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
      notes: AURORA_NOTE_SHORT
    });
  }

  base.sort((a, b) => (a.day - b.day) || (a.start || "").localeCompare(b.start || ""));
  return normalizeShape(parsed, base);
}

function normalizeShape(parsed, rowsFixed) {
  if (Array.isArray(parsed?.rows)) {
    return { ...parsed, rows: rowsFixed, destination: parsed.destination || parsed.city || "Destino" };
  }
  if (Array.isArray(parsed?.destinations)) {
    const name = parsed.destinations?.[0]?.name || parsed.destination || "Destino";
    return { destination: name, rows: rowsFixed, followup: parsed.followup || "" };
  }
  return { destination: parsed?.destination || "Destino", rows: rowsFixed, followup: parsed?.followup || "" };
}

// ==============================
// Prompts
// ==============================

// Paso 1: INVESTIGACIÓN (como Info Chat) → FACTS en JSON
const RESEARCH_PROMPT = `
Eres un asistente turístico experto. Analiza el destino y fechas implícitas del mensaje del usuario y devuelve **EXCLUSIVAMENTE JSON** con tiempos realistas de conducción/traslado entre paradas típicas.

Formato:
{
  "facts":{
    "base_city":"<ciudad base si aplica>",
    "daytrip_patterns":[
      {
        "route":"Círculo Dorado",
        "stops":["Þingvellir","Geysir","Gullfoss"],
        "return_to_base_from":"Gullfoss",
        "durations":{
          "Reykjavík→Þingvellir":"1h",
          "Þingvellir→Geysir":"1h15m",
          "Geysir→Gullfoss":"25m",
          "Gullfoss→Reykjavík":"1h30m"
        }
      }
    ],
    "other_hints":[
      "Usa 'Vehículo alquilado o Tour guiado' para day-trips icónicos en Islandia"
    ]
  }
}
No texto fuera del JSON.
`.trim();

// Paso 2: PLANNER (forzamos JSON), conserva TODAS tus reglas
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn. Eres un experto mundial en turismo.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido**.
Dispones de un bloque "FACTS" con tiempos y patrones turísticos investigados previamente: úsalo para establecer **duraciones concretas y realistas** de cada traslado y del "Regreso a {Ciudad}".

📌 FORMATO
{"destination":"City","rows":[{...}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos una actividad en "rows".
- Nada de texto fuera del JSON.
- Máx. 20 actividades por día.
- Usa horas realistas (08:30–19:00 si no hay otras).
- No devuelvas "seed" ni campos vacíos.
- En "duration" escribe valores limpios (por ejemplo "1h45m", "30m"). **No uses** "~" ni "≈".

🧭 ESTRUCTURA DE CADA FILA
{
  "day": 1,
  "start": "08:30",
  "end": "10:30",
  "activity": "Nombre claro y específico (permitido: 'Excursión — Ruta — Subparada')",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "A pie, Metro, Tren, Auto, Taxi, Bus, Ferry, Vehículo alquilado o Tour guiado",
  "duration": "2h",
  "notes": "Descripción breve y motivadora"
}

🌍 CONOCIMIENTO + FACTS
- Usa **FACTS** para los tiempos habituales entre paradas y para el **Regreso a {Ciudad}**.
- Si FACTS no cubre una pareja exacta de lugares, aplica tu conocimiento turístico global para estimar tiempos coherentes.

🚗 TRANSPORTE
- En day-trips icónicos de Islandia (Círculo Dorado, Costa Sur, Snæfellsnes, Reykjanes/Blue Lagoon) usa **"Vehículo alquilado o Tour guiado"** en vez de "Bus".
- Al regresar a la ciudad, NO heredes "Vehículo alquilado o Tour guiado" en las actividades que continúen dentro de ciudad: usa el transporte lógico (A pie/Metro/Taxi/Bus).

🌌 AURORAS
- Noches alternas por paridad (par→1,3,5…; impar→2,4,6…), **nunca el último día**.
- Horario 18:00–01:00; transporte "Vehículo alquilado o Tour guiado".
- No escribas “valid: ventana nocturna auroral (sujeto a clima)”.

🧩 DESTINO–SUBPARADAS
- Usa la convención **"Excursión — {Ruta} — {Subparada}"** en cada parada hija consecutiva (hasta **8**).
- Tras el bloque de sub-paradas, agrega explícitamente una fila **"Regreso a {Ciudad}"** con su duración real (basada en FACTS o estimación razonable).
`.trim();

// ==============================
// Llamadas al modelo (Chat Completions) con retries
// ==============================
async function chatJSON(messages, temperature = 0.35, tries = 3) {
  for (let k = 0; k < Math.max(1, tries); k++) {
    try {
      const resp = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature,
        response_format: { type: "json_object" },
        messages: messages.map(m => ({ role: m.role, content: String(m.content ?? "") })),
        max_tokens: 3200
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
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature,
        messages: messages.map(m => ({ role: m.role, content: String(m.content ?? "") })),
        max_tokens: 3200
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
// Handler (mantiene firma y forma de respuesta)
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
        0.35,
        3
      );
      researchParsed = cleanToJSONPlus(researchRaw);
    } catch {
      // seguimos con defaults
    }

    // Mezcla: FACTS del modelo (si existen) + defaults locales
    const factsMerged = (() => {
      const m = (researchParsed && researchParsed.facts) ? researchParsed.facts : {};
      const out = { ...FACTS_DEFAULT, ...m };
      // merge arrays de daytrip_patterns si ambos existen
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
      // Intento normal
      let raw = await chatJSON(
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "system", content: `FACTS=${FACTS}` },
          ...clientMessages
        ],
        0.35,
        3
      );
      parsed = cleanToJSONPlus(raw);

      // Reintento estricto si no hay rows
      const hasRows = parsed && (parsed.rows || parsed.destinations || parsed.itineraries);
      if (!hasRows) {
        const strict = SYSTEM_PROMPT + "\nOBLIGATORIO: Devuelve un único JSON con \"destination\" y al menos 1 fila en \"rows\".";
        raw = await chatJSON(
          [
            { role: "system", content: strict },
            { role: "system", content: `FACTS=${FACTS}` },
            ...clientMessages
          ],
          0.2,
          2
        );
        parsed = cleanToJSONPlus(raw);
      }

      // Último intento con ejemplo mínimo válido
      const stillNo = !parsed || (!parsed.rows && !parsed.destinations && !parsed.itineraries);
      if (stillNo) {
        const ultra =
          SYSTEM_PROMPT +
          '\nEjemplo válido: {"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"45m","notes":"Explora la ciudad"}]}';
        raw = await chatJSON(
          [
            { role: "system", content: ultra },
            { role: "system", content: `FACTS=${FACTS}` },
            ...clientMessages
          ],
          0.1,
          1
        );
        parsed = cleanToJSONPlus(raw);
      }
    } catch {
      // si la llamada al planner revienta, parsed queda null y caemos al fallback controlado
    }

    if (!parsed) parsed = fallbackJSON();

    // Post-proceso, limpieza y normalización
    let finalJSON = ensureAuroras(parsed);
    // Aplicar duraciones realistas de regreso usando FACTS fusionados
    finalJSON.rows = applyReturnDurationsFromFacts(finalJSON.rows || [], factsMerged);

    // 🔒 Siempre devolver en el mismo envoltorio { text: JSON.stringify(...) } (tu contrato actual)
    return res.status(200).json({ text: JSON.stringify(finalJSON) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    // Entregamos JSON válido para no romper la UI
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
