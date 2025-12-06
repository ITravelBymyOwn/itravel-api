// /api/chat.js — v30.13 (ESM compatible en Vercel)
// Base exacta: v30.12.
// Cambios clave:
// - Paso de INVESTIGACIÓN previo (como Info Chat) -> obtiene "FACTS" turísticos en JSON
//   y se inyectan al prompt del planner para que use tiempos/distancias realistas.
// - Formato destino–subparadas: garantiza "Excursión — {Ruta} — {Subparada}" en cada fila hija
//   (sin colapsar la actividad madre; máximo 8 subparadas contiguas).
// - Limpieza agresiva de notas y duraciones (elimina "≈", "~", "valid: ..." y duplicados Blue Lagoon).
// - Parser y triple intento se mantienen (anti-fallback).
// - Mantiene coerción de transporte y paridad de auroras.

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

  // 0) ya viene objeto
  if (typeof raw === "object") {
    const obj = raw;
    if (obj.rows || obj.destinations || obj.facts) return obj;
    try { return JSON.parse(JSON.stringify(obj)); } catch {}
  }
  if (typeof raw !== "string") return null;

  let s = raw.trim();
  // quitar fences
  s = s.replace(/^```json/i, "```").replace(/^```/, "").replace(/```$/, "").trim();

  // 1) intento directo
  try { return JSON.parse(s); } catch {}

  // 2) primer {...} último }
  try {
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(s.slice(first, last + 1));
    }
  } catch {}

  // 3) limpieza de bordes agresiva
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
 * Garantiza el formato destino–subparadas SIN colapsar:
 * - Detecta bloque que inicia con actividad que contiene "Excursión".
 * - Hasta 8 filas siguientes que sean visitas/paradas típicas se renombran a:
 *   "Excursión — {RutaBase} — {SubparadaBonita}"
 * - No elimina filas; solo renombra y añade una nota breve si falta.
 */
function enforceMotherSubstopFormat(rows) {
  const out = [...rows];
  for (let i = 0; i < out.length; i++) {
    const r = out[i];
    const act = (r.activity || "").toLowerCase();
    if (!/excursión/.test(act)) continue;

    // Determinar "RutaBase": tomamos la porción después de "Excursión" y antes de "—" o fin
    const rawName = (r.activity || "").trim();
    const routeBase = rawName
      .replace(/^excursión\s*(a|al)?\s*/i, "")
      .split("—")[0]
      .trim() || "Ruta";

    // Renombrar hasta 8 subparadas siguientes
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
        aj.includes("vík") || aj.includes("vik") ||
        aj.includes("reynisfjara");

      if (!isSub) break;

      // nombre bonito de subparada
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

  // Reinyectar auroras por paridad
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

// Paso 1: INVESTIGACIÓN (como Info Chat) -> devuelve FACTS en JSON
const RESEARCH_PROMPT = `
Eres un asistente turístico experto. Analiza el destino y el rango de días implícito en el mensaje del usuario y
devuelve **EXCLUSIVAMENTE JSON** con tiempos realistas de conducción/traslado entre paradas típicas.

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
          "Þingvellir→Geysir":"1h-1h15m",
          "Geysir→Gullfoss":"15m-30m",
          "Gullfoss→Reykjavík":"1h30m-1h45m"
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

// Paso 2: PLANNER (forzamos JSON)
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn. Eres un experto mundial en turismo.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido**.

Dispones de un bloque "FACTS" con tiempos y patrones turísticos investigados previamente: úsalo para
establecer **duraciones concretas y realistas** de cada traslado y del "Regreso a {Ciudad}".

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
- En day-trips icónicos de Islandia (Círculo Dorado, Costa Sur, Snæfellsnes, Reykjanes/Blue Lagoon) usa
  **"Vehículo alquilado o Tour guiado"** en vez de "Bus".

🌌 AURORAS
- Noches alternas por paridad (par→1,3,5…; impar→2,4,6…), nunca el último día.
- Horario 18:00–01:00; transporte "Vehículo alquilado o Tour guiado".
- **No** escribas “valid: ventana nocturna auroral (sujeto a clima)”.

🧩 DESTINO–SUBPARADAS
- Usa la convención **"Excursión — {Ruta} — {Subparada}"** en cada parada hija consecutiva (hasta 8),
  y luego agrega explícitamente la fila **"Regreso a {Ciudad}"** con el tiempo real de vuelta.
`.trim();

// ==============================
// Llamadas al modelo (Chat Completions)
// ==============================
async function chatJSON(messages, temperature = 0.35) {
  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature,
    response_format: { type: "json_object" },
    messages: messages.map(m => ({ role: m.role, content: String(m.content ?? "") })),
    max_tokens: 3200,
  });
  return resp?.choices?.[0]?.message?.content?.trim() || "";
}

async function chatFree(messages, temperature = 0.5) {
  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature,
    messages: messages.map(m => ({ role: m.role, content: String(m.content ?? "") })),
    max_tokens: 3200,
  });
  return resp?.choices?.[0]?.message?.content?.trim() || "";
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
      const raw = await chatFree(clientMessages);
      return res.status(200).json({ text: raw || "⚠️ No se obtuvo respuesta." });
    }

    // ===== Paso 1: INVESTIGACIÓN (obtener FACTS en JSON) =====
    // Usamos el mensaje del usuario como contexto para que la investigación sea relevante.
    const researchRaw = await chatJSON(
      [
        { role: "system", content: RESEARCH_PROMPT },
        ...clientMessages
      ],
      0.4
    );
    const researchParsed = cleanToJSONPlus(researchRaw);
    const FACTS = researchParsed?.facts ? JSON.stringify(researchParsed.facts) : "{}";

    // ===== Paso 2: PLANNER (forzamos JSON e inyectamos FACTS) =====
    let raw = await chatJSON(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "system", content: `FACTS=${FACTS}` },
        ...clientMessages
      ],
      0.35
    );
    let parsed = cleanToJSONPlus(raw);

    // Reintento estricto
    const hasRows = parsed && (parsed.rows || parsed.destinations);
    if (!hasRows) {
      const strict = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve un único JSON con "destination" y al menos 1 fila en "rows".`;
      raw = await chatJSON(
        [
          { role: "system", content: strict },
          { role: "system", content: `FACTS=${FACTS}` },
          ...clientMessages
        ],
        0.2
      );
      parsed = cleanToJSONPlus(raw);
    }

    // Último intento (plantilla mínima)
    const stillNo = !parsed || (!parsed.rows && !parsed.destinations);
    if (stillNo) {
      const ultra = SYSTEM_PROMPT + `
Ejemplo válido:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora la ciudad"}]}`;
      raw = await chatJSON(
        [
          { role: "system", content: ultra },
          { role: "system", content: `FACTS=${FACTS}` },
          ...clientMessages
        ],
        0.1
      );
      parsed = cleanToJSONPlus(raw);
    }

    if (!parsed) parsed = fallbackJSON();

    // Post-proceso y normalización
    const finalJSON = ensureAuroras(parsed);
    return res.status(200).json({ text: JSON.stringify(finalJSON) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
