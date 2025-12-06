// /api/chat.js — v30.4 (ESM compatible en Vercel) — basado en v30.2
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

// Busca el primer bloque JSON balanceando llaves
function looseJsonFind(raw = "") {
  if (!raw || typeof raw !== "string") return null;
  let start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0) {
      const slice = raw.slice(start, i + 1);
      try {
        return JSON.parse(slice);
      } catch {
        // continuar
      }
    }
  }
  return null;
}

function cleanToJSON(raw = "") {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    const looser = looseJsonFind(raw);
    if (looser) return looser;
    try {
      const cleaned = raw.replace(/^[^\{]+/, "").replace(/[^\}]+$/, "");
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }
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
        notes:
          "Explora libremente la ciudad y descubre sus lugares más emblemáticos.",
      },
    ],
    followup:
      "⚠️ Fallback local: revisa configuración de Vercel o API Key.",
  };
}

// ==============================
// Reglas y post-proceso
// ==============================

// --- AURORAS ---
function isAuroraEligibleName(name = "") {
  const n = (name || "").toLowerCase();
  const hits = [
    "reykjavik","reykjavík","iceland","islandia","tromsø","tromso","norway","noruega",
    "lapland","laponia","rovaniemi","abisko","fairbanks","yellowknife","alta","kiruna",
  ];
  return hits.some((h) => n.includes(h));
}

function computeAuroraNights(totalDays) {
  const nights = [];
  if (!totalDays || totalDays < 2) return nights;
  const start = totalDays % 2 === 0 ? 1 : 2; // par→1,3,5 / impar→2,4,6
  for (let d = start; d <= totalDays - 1; d += 2) nights.push(d); // nunca el último día
  return nights;
}

const AURORA_ACTIVITY_NAME = "Caza de auroras boreales";
const AURORA_NOTE_COMPACTA =
  "Noche especial de caza de auroras. Con cielos despejados y paciencia, podrás presenciar un espectáculo natural inolvidable. La hora de regreso al hotel dependerá del tour que elijas. Puedes optar por tour guiado o movilizarte por tu cuenta; infórmate sobre seguridad invernal y conducción nocturna.";

function ensureAuroras(parsed) {
  const injectInRows = (rows, totalDays, destName) => {
    if (!Array.isArray(rows) || !rows.length) return rows;
    if (!isAuroraEligibleName(destName)) return rows;

    const maxDay =
      totalDays ||
      rows.reduce((acc, r) => Math.max(acc, Number(r.day) || 0), 0);

    const targetDays = computeAuroraNights(maxDay);
    if (!targetDays.length) return rows;

    const hasAuroraForDay = (d) =>
      rows.some(
        (r) =>
          Number(r.day) === d &&
          (r.activity || "").toLowerCase().includes("aurora")
      );

    const newRows = [...rows];
    for (const d of targetDays) {
      if (hasAuroraForDay(d)) continue;
      newRows.push({
        day: d,
        start: "18:00",
        end: "01:00",
        activity: AURORA_ACTIVITY_NAME,
        from: "Hotel",
        to: "Puntos de observación (variable)",
        transport: "Vehículo alquilado o Tour guiado",
        duration: "≈7h",
        notes: AURORA_NOTE_COMPACTA,
      });
    }

    newRows.sort((a, b) => {
      const da = Number(a.day) || 0;
      const db = Number(b.day) || 0;
      if (da !== db) return da - db;
      return (a.start || "").localeCompare(b.start || "");
    });

    return newRows;
  };

  if (parsed?.destinations?.length) {
    parsed.destinations = parsed.destinations.map((d) => ({
      ...d,
      rows: injectInRows(d.rows, undefined, d.name || parsed.destination || ""),
    }));
    return parsed;
  }
  if (parsed?.rows?.length) {
    parsed.rows = injectInRows(
      parsed.rows,
      undefined,
      parsed.destination || ""
    );
    return parsed;
  }
  return parsed;
}

// --- Transporte/regresos ---
const OUT_OF_CITY_HINTS = [
  "thingvellir","þingvellir","gullfoss","geysir","geysers","vik","vík","reynisfjara",
  "snæfells","snaefells","dyrhólaey","dyrholaey","seljalandsfoss","skogafoss","skógafoss",
  "blue lagoon","península","peninsula","glaciar","kirkjufell","arfnes","arfnastapi","arna",
];

function isExcursionLike(row) {
  const act = (row.activity || "").toLowerCase();
  const to = (row.to || "").toLowerCase();
  const combo = `${act} ${to}`;
  const clues =
    act.includes("excursión") ||
    act.includes("excursion") ||
    act.includes("península") ||
    act.includes("peninsula") ||
    act.includes("cascada") ||
    act.includes("glaciar") ||
    act.includes("parque") ||
    act.includes("playa") ||
    OUT_OF_CITY_HINTS.some((h) => combo.includes(h));
  return clues;
}

function parseMinutes(dur = "") {
  if (!dur) return 0;
  const s = dur.toLowerCase().replace(/[≈~]/g, "").trim();
  let mins = 0;
  const hm = s.match(/(\d+(?:[.,]\d+)?)\s*h/);
  const mm = s.match(/(\d+)\s*m/);
  if (hm) mins += Math.round(parseFloat(hm[1].replace(",", ".")) * 60);
  if (mm) mins += parseInt(mm[1], 10);
  if (!hm && !mm) {
    // soporta “1h30m”, “1h30”, “90m”
    const h30 = s.match(/(\d+)\s*h\s*(\d+)\s*m?/);
    if (h30) {
      mins += parseInt(h30[1], 10) * 60 + parseInt(h30[2], 10);
    }
  }
  return mins || 0;
}

function prettyMinutes(mins) {
  const round15 = Math.round(mins / 15) * 15;
  const h = Math.floor(round15 / 60);
  const m = round15 % 60;
  if (h && m) return `≈ ${h}h ${m}m`;
  if (h) return `≈ ${h}h`;
  return `≈ ${m}m`;
}

// Suma lógicas de traslado del día y ajusta la fila de “Regreso a … Reykjavik”
function fixReturnsForDay(dayRows) {
  if (!Array.isArray(dayRows) || !dayRows.length) return dayRows;

  const rows = [...dayRows];
  // índice de “Regreso … Reykjavik”
  const idxRegreso = rows.findIndex((r) => {
    const act = (r.activity || "").toLowerCase();
    const to = (r.to || "").toLowerCase();
    return act.startsWith("regreso") && to.includes("reykjav");
  });
  if (idxRegreso === -1) return rows;

  // Detecta el bloque de excursión (desde la primera fila “excursionLike” hasta antes del regreso)
  let startIdx = rows.findIndex((r) => isExcursionLike(r));
  if (startIdx === -1) return rows;

  const endIdx = idxRegreso - 1;
  if (endIdx <= startIdx) return rows;

  // Suma minutos de filas “de trayecto/excursión” dentro del bloque
  let sum = 0;
  for (let i = startIdx; i <= endIdx; i++) {
    const r = rows[i];
    // contamos duraciones de filas de movimiento/actividad interurbana
    const isMove =
      (r.transport || "").toLowerCase().includes("vehículo") ||
      (r.transport || "").toLowerCase().includes("auto") ||
      (r.transport || "").toLowerCase().includes("tour") ||
      isExcursionLike(r);
    if (!isMove) continue;

    // evitamos sumar almuerzos estáticos en ciudad
    const act = (r.activity || "").toLowerCase();
    const staticStop =
      act.includes("almuerzo") ||
      act.includes("cena") ||
      act.includes("caf") ||
      act.includes("paseo por el centro") ||
      act.includes("museo") ||
      act.includes("parque") ||
      act.includes("mercado");
    if (staticStop) continue;

    sum += parseMinutes(r.duration);
  }

  // Mínimo ≈ 1h
  if (sum < 60) sum = 60;

  // Aplica sólo si es mayor a lo que trae el modelo
  const current = parseMinutes(rows[idxRegreso].duration);
  if (sum > current) {
    rows[idxRegreso] = {
      ...rows[idxRegreso],
      duration: prettyMinutes(sum),
    };
  }
  return rows;
}

function normalizeTransportAndReturns(parsed) {
  const fixOne = (rows) => {
    if (!Array.isArray(rows)) return rows;

    // 1) Normalizar transporte en excursiones
    const normalized = rows.map((r) => {
      const rr = { ...r };
      if (
        isExcursionLike(rr) &&
        (rr.transport || "").toLowerCase() === "bus"
      ) {
        rr.transport = "Vehículo alquilado o Tour guiado";
      }
      return rr;
    });

    // 2) Ajustar “Regreso … Reykjavik” sumando traslados previos del día
    const days = [...new Set(normalized.map((r) => Number(r.day) || 0))].filter(
      (d) => d > 0
    );
    let out = [];
    for (const d of days) {
      const dayRows = normalized.filter((r) => Number(r.day) === d);
      const fixed = fixReturnsForDay(dayRows);
      out = out.concat(fixed);
    }

    // Orden cronológico por seguridad
    out.sort((a, b) => {
      const da = Number(a.day) || 0;
      const db = Number(b.day) || 0;
      if (da !== db) return da - db;
      return (a.start || "").localeCompare(b.start || "");
    });
    return out;
  };

  if (parsed?.destinations?.length) {
    parsed.destinations = parsed.destinations.map((d) => ({
      ...d,
      rows: fixOne(d.rows),
    }));
    return parsed;
  }
  if (parsed?.rows?.length) {
    parsed.rows = fixOne(parsed.rows);
    return parsed;
  }
  return parsed;
}

// ==============================
// Prompt base ✨
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido** que describa un itinerario turístico inspirador y funcional.

📌 FORMATOS VÁLIDOS DE RESPUESTA
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos una actividad en "rows".
- Nada de texto fuera del JSON.
- 20 actividades máximo por día.
- Usa horas realistas (o 08:30–19:00 si no se indica nada).
- La respuesta debe poder renderizarse directamente en una UI web.
- Nunca devuelvas "seed" ni dejes campos vacíos.

🧭 ESTRUCTURA OBLIGATORIA DE CADA ACTIVIDAD
{
  "day": 1,
  "start": "08:30",
  "end": "10:30",
  "activity": "Nombre claro y específico",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "Transporte realista (A pie, Metro, Tren, Auto, etc.)",
  "duration": "2h",
  "notes": "Descripción motivadora y breve"
}

🧠 ESTILO Y EXPERIENCIA DE USUARIO
- Tono cálido y entusiasta.
- Notas breves (1–2 líneas), sin repeticiones textuales.

🚆 TRANSPORTE Y TIEMPOS
- En áreas sin transporte público eficiente (p.ej., Islandia: Círculo Dorado, Costa Sur, Snæfellsnes) usa **"Vehículo alquilado o Tour guiado"**.
- Ordena horas sin superposición e incluye traslados.
- En los **regresos a la ciudad** de un day-trip, usa una duración realista (≈1–2h) y evita subestimaciones.

🌌 AURORAS (REGLA GLOBAL)
- Si el destino/temporada permiten auroras, actividad **"Caza de auroras boreales"**, de **18:00–01:00**, con **"Vehículo alquilado o Tour guiado"** y nota **compacta** (sin meta).
- Distribución por número de días:
  • Total par → noches 1,3,5,… (nunca el último día).
  • Total impar → noches 2,4,6,… (nunca el último día).
- Evita poner auroras el último día.

🧩 DESTINO–SUBPARADAS
- Para excursiones con varias paradas, representa el flujo con varias filas consecutivas (p.ej., Thingvellir → Geysir → Gullfoss → Regreso).

💰 MONETIZACIÓN FUTURA (sin marcas)
- Sugerencias “upsellables” sin precios ni enlaces.

📝 EDICIÓN INTELIGENTE
- Ante cambios del usuario, devuelve SIEMPRE el JSON actualizado (sin meta).

🚫 ERRORES A EVITAR
- No devuelvas “seed”.
- No incluyas saludos ni explicaciones fuera del JSON.
`.trim();

// ==============================
// Llamada al modelo
// ==============================
async function callStructured(messages, temperature = 0.4) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    input: messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
    max_output_tokens: 2200,
  });

  const text =
    resp?.output_text?.trim() ||
    resp?.output?.[0]?.content?.[0]?.text?.trim() ||
    "";

  console.log("🛰️ RAW RESPONSE:", text);
  return text;
}

// ==============================
// Exportación ESM correcta
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body;
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    // MODO INFO
    if (mode === "info") {
      const raw = await callStructured(clientMessages);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // MODO PLANNER — reintentos controlados
    const sysMsg = { role: "system", content: SYSTEM_PROMPT };

    // intento 1
    let raw = await callStructured([sysMsg, ...clientMessages]);
    let parsed = cleanToJSON(raw);

    // intento 2
    const hasRows = parsed && (parsed.rows || parsed.destinations);
    if (!hasRows) {
      const strictPrompt = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve al menos 1 fila en "rows". Nada de meta.`;
      raw = await callStructured([{ role: "system", content: strictPrompt }, ...clientMessages], 0.25);
      parsed = cleanToJSON(raw);
    }

    // intento 3 con ejemplo mínimo
    const stillNoRows = !parsed || (!parsed.rows && !parsed.destinations);
    if (stillNoRows) {
      const ultraPrompt = SYSTEM_PROMPT + `
Ejemplo válido:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
      raw = await callStructured([{ role: "system", content: ultraPrompt }, ...clientMessages], 0.1);
      parsed = cleanToJSON(raw);
    }

    if (!parsed) parsed = fallbackJSON();

    // Post-proceso: auroras y transporte/regresos
    parsed = ensureAuroras(parsed);
    parsed = normalizeTransportAndReturns(parsed);

    return res.status(200).json({ text: JSON.stringify(parsed) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
