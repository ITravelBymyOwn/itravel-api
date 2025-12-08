// /api/chat.js — v42.3 (ESM, Vercel)
// Base: v42.2 + PRE-RESEARCH info + regreso basado en investigación (sin heurísticos).
// Mantiene: paridad de auroras, “Destino — Sub-paradas”, coacción de transporte fuera de ciudad.

import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==============================
// Utilidades
// ==============================
function extractMessages(body = {}) {
  const { messages, input, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;
  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";
  return [...prev, { role: "user", content: userText }];
}

// Parser tolerante: intenta extraer el primer bloque {...} válido
function cleanToJSONPlus(raw = "") {
  if (!raw || typeof raw !== "string") return null;
  try { return JSON.parse(raw); } catch {}
  try {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      const sliced = raw.slice(first, last + 1);
      return JSON.parse(sliced);
    }
  } catch {}
  try {
    const cleaned = raw.replace(/^[^{]+/, "").replace(/[^}]+$/, "");
    return JSON.parse(cleaned);
  } catch {}
  return null;
}

// Fallback mínimo pero válido para la UI
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
    followup: "⚠️ Fallback local: revisa configuración de Vercel o API Key."
  };
}

// ==============================
// Post-proceso (sin heurísticos de tiempo)
// ==============================

// Destinos típicos de auroras
const AURORA_DESTINOS = [
  "reykjavik","reykjavík","tromso","tromsø","rovaniemi","kiruna",
  "abisko","alta","ivalo","yellowknife","fairbanks","akureyri"
];

// Cap recomendado de noches de auroras según duración
function auroraNightsByLength(totalDays) {
  if (totalDays <= 2) return 1;
  if (totalDays <= 4) return 2;
  if (totalDays <= 6) return 2;
  if (totalDays <= 9) return 3;
  return 3;
}

// Paridad: pares→1,3,5… ; impares→2,4,6… (nunca último día)
function planAuroraDays(totalDays, count) {
  const start = (totalDays % 2 === 0) ? 1 : 2;
  const out = [];
  for (let d = start; out.length < count && d < totalDays; d += 2) out.push(d);
  return out;
}

const AURORA_NOTE_SHORT =
  "Noche especial de caza de auroras. Con cielos despejados y paciencia, podrás presenciar un espectáculo natural inolvidable. " +
  "La hora de regreso al hotel dependerá del tour de auroras que se tome. " +
  "Puedes optar por tour guiado o movilización por tu cuenta (es probable que debas conducir con nieve y de noche; investiga seguridad para tus fechas).";

function isAuroraRow(r) {
  const t = (r?.activity || "").toLowerCase();
  return t.includes("aurora");
}

// Tópicos fuera de ciudad donde el bus público no es la opción eficiente por defecto
const NO_BUS_TOPICS = [
  "círculo dorado","thingvellir","þingvellir","geysir","geyser","gullfoss",
  "seljalandsfoss","skógafoss","reynisfjara","vik","vík",
  "snaefellsnes","snæfellsnes","kirkjufell","reykjanes","krýsuvík","arnarstapi",
  "blue lagoon","laguna azul","dyrhólaey","hellnar","djúpalónssandur"
];

function needsVehicleOrTour(row) {
  const a = (row.activity || "").toLowerCase();
  const to = (row.to || "").toLowerCase();
  return NO_BUS_TOPICS.some(k => a.includes(k) || to.includes(k));
}

function coerceTransport(rows) {
  return rows.map(r => {
    const t = (r.transport || "").toLowerCase();
    if ((!t || t.includes("bus")) && needsVehicleOrTour(r)) {
      return { ...r, transport: "Vehículo alquilado o Tour guiado" };
    }
    return r;
  });
}

// Compacta actividad madre con sub-paradas: "Excursión — A → B → C"
function compactSubstops(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;

    const act = (r.activity || "").toLowerCase();
    const isExcursion =
      act.startsWith("excursión") ||
      act.includes("costa sur") ||
      act.includes("península") ||
      act.includes("círculo dorado");

    if (isExcursion) {
      const sub = [];
      let j = i + 1;
      // Toma hasta 3 sub-paradas inmediatas si parecen POI
      while (j < rows.length && sub.length < 3) {
        const rj = rows[j];
        const aj = (rj?.activity || "").toLowerCase();
        if (
          aj.startsWith("visita") ||
          aj.includes("cascada") ||
          aj.includes("playa") ||
          aj.includes("geysir") ||
          aj.includes("thingvellir") ||
          aj.includes("gullfoss") ||
          aj.includes("kirkjufell") ||
          aj.includes("dyrhólaey")
        ) {
          sub.push(rj?.to || rj?.activity || "");
          j++;
        } else break;
      }
      if (sub.length) {
        const pretty = sub
          .filter(Boolean)
          .map(s => s.replace(/^visita (a |al )?/i, "").trim())
          .join(" → ");
        const merged = {
          ...r,
          activity: (r.activity || "").replace(/\s—.*$/, "") + (pretty ? ` — ${pretty}` : "")
        };
        out.push(merged);
        // Conservamos también las sub-filas (con nota breve)
        for (let k = i + 1; k < i + 1 + sub.length; k++) {
          const rr = rows[k];
          out.push({ ...rr, notes: (rr.notes || "Parada dentro de la ruta.") });
        }
        i = i + sub.length;
        continue;
      }
    }
    out.push(r);
  }
  return out;
}

// Asegura reglas de auroras y normaliza forma; NO agrega "regreso" si falta
function ensureAurorasAndNormalize(parsed) {
  const dest =
    (parsed?.destination || parsed?.Destination || parsed?.city || parsed?.name || "").toString();
  const destName = dest || (parsed?.destinations?.[0]?.name || "");
  const low = destName.toLowerCase();

  const rowsIn = Array.isArray(parsed?.rows)
    ? parsed.rows
    : Array.isArray(parsed?.destinations?.[0]?.rows)
      ? parsed.destinations[0].rows
      : [];

  if (!rowsIn.length) return parsed;

  // Normalizaciones base (transporte/sub-paradas)
  let rows = coerceTransport(compactSubstops(rowsIn));

  // Si el destino no es de auroras, solo normalizamos forma y orden
  const totalDays = Math.max(...rows.map(r => Number(r.day) || 1));
  const isAuroraPlace = AURORA_DESTINOS.some(x => low.includes(x));

  if (!isAuroraPlace) {
    rows.sort((a,b)=>(a.day - b.day) || (a.start||"").localeCompare(b.start||""));
    return normalizeShape(parsed, rows);
  }

  // Reinyectar auroras con paridad (quitamos las mal ubicadas)
  rows = rows.filter(r => !isAuroraRow(r));
  const targetCount = auroraNightsByLength(totalDays);
  const targetDays = planAuroraDays(totalDays, targetCount);

  for (const d of targetDays) {
    rows.push({
      day: d,
      start: "18:00",
      end: "01:00",
      activity: "Caza de auroras boreales",
      from: "Hotel",
      to: "Puntos de observación (variable)",
      transport: "Vehículo alquilado o Tour guiado",
      duration: "~7h",
      notes: AURORA_NOTE_SHORT
    });
  }

  rows.sort((a,b)=>(a.day - b.day) || (a.start||"").localeCompare(b.start||""));
  return normalizeShape(parsed, rows);
}

// Uniforma salida al formato B preferido
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
/* SYSTEM PROMPT — 42.3
   - Investigación previa (texto libre) se pasa como CONTEXTO.
   - El modelo debe devolver el REGRESO A CIUDAD con duración calculada a partir de la investigación (no heurísticos del servidor).
*/
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido**.

📌 FORMATOS
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos una actividad en "rows".
- Nada de texto fuera del JSON.
- Máx. 20 actividades por día.
- Libertad total para proponer horarios realistas; evita solapes.
- No dejes campos vacíos ni devuelvas "seed".

🧭 ESTRUCTURA DE ACTIVIDAD
{
  "day": 1,
  "start": "08:30",
  "end": "10:30",
  "activity": "Nombre claro (permite 'Excursión — A → B → C')",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "A pie, Metro, Tren, Auto, Taxi, Bus, Ferry, Vehículo alquilado o Tour guiado",
  "duration": "2h",
  "notes": "Descripción breve, motivadora"
}

🚐 FORMATO DESTINO—SUB-PARADAS
- Para tours icónicos (p.ej., Círculo Dorado, Costa Sur, Reykjanes, Snæfellsnes),
  usar título madre + sub-paradas en el mismo título: "Excursión — Þingvellir → Geysir → Gullfoss".
- Además, puedes listar sub-paradas como filas consecutivas con notas breves.

🚆 TRANSPORTE
- Para salidas fuera de ciudad en destinos sin red pública eficiente, **no** priorices "Bus":
  usa "Vehículo alquilado o Tour guiado", salvo que la investigación demuestre lo contrario.

🌌 AURORAS (si aplica por destino/temporada)
- Distribuye noches **no consecutivas** según paridad (pares→1,3,5… ; impares→2,4,6…).
- **Nunca** programes auroras en el último día.
- Horario predefinido **18:00–01:00**; transporte **"Vehículo alquilado o Tour guiado"**.
- Nota breve predefinida.

↩️ REGRESO A LA CIUDAD (obligatorio tras day trips)
- **Incluye una fila explícita** "Regreso a <Ciudad>" **después de la última parada fuera de ciudad**
  con **duración y horario calculados a partir de la INVESTIGACIÓN PREVIA** (NO inventes sin base).
- Si la investigación no provee un rango/tiempo confiable, devuelve una duración aproximada con
  texto en "notes" que cite la fuente o la inferencia (p.ej., "según guías locales/operadores").

📝 EDICIÓN
- Si el usuario pide cambios, responde con el JSON completo y actualizado.
`.trim();

// ==============================
// Llamadas OpenAI
// ==============================
async function callStructured(messages, temperature = 0.5) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    input: messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
    max_output_tokens: 3000
  });

  const text =
    resp?.output_text?.trim() ||
    resp?.output?.[0]?.content?.[0]?.text?.trim() ||
    "";

  console.log("🛰️ RAW RESPONSE:", text);
  return text;
}

// ==============================
// Handler ESM
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body;
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    // --- MODO INFO (texto libre) ---
    if (mode === "info") {
      const raw = await callStructured(clientMessages, 0.7);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // --- PRE-RESEARCH (se usa como contexto, no se devuelve) ---
    let research = "";
    try {
      const researchRaw = await callStructured(clientMessages, 0.8);
      research = (researchRaw || "").slice(0, 2200); // contexto razonable
    } catch { /* no-op */ }

    const researchWrapped = research
      ? `\n\n=== INVESTIGACIÓN PREVIA (no la devuelvas; úsala para calcular duraciones/regresos y ordenar paradas) ===\n${research}\n\n=== FIN INVESTIGACIÓN ===\n`
      : "";

    // --- MODO PLANNER (JSON estricto) ---
    let raw = await callStructured(
      [{ role: "system", content: SYSTEM_PROMPT + researchWrapped }, ...clientMessages],
      0.45
    );
    let parsed = cleanToJSONPlus(raw);

    // Reintento estricto si faltan filas
    const hasRows = parsed && (parsed.rows || parsed.destinations);
    if (!hasRows) {
      const strict = SYSTEM_PROMPT + researchWrapped +
        `\nOBLIGATORIO: Devuelve solo JSON y al menos 1 fila en "rows". Sin explicaciones.`;
      raw = await callStructured([{ role: "system", content: strict }, ...clientMessages], 0.3);
      parsed = cleanToJSONPlus(raw);
    }

    // Último intento con ejemplo mínimo
    if (!parsed || (!parsed.rows && !parsed.destinations)) {
      const ultra = SYSTEM_PROMPT + researchWrapped +
        `\nEjemplo mínimo válido:\n{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único"}]}`;
      raw = await callStructured([{ role: "system", content: ultra }, ...clientMessages], 0.2);
      parsed = cleanToJSONPlus(raw);
    }

    if (!parsed) parsed = fallbackJSON();

    // Post-proceso SIN heurísticos de tiempos de regreso:
    // - coacción de transporte fuera de ciudad
    // - compactado de sub-paradas en título madre
    // - auroras con paridad/ventana/nota
    // - normalización de salida
    const finalJSON = ensureAurorasAndNormalize(parsed);

    return res.status(200).json({ text: JSON.stringify(finalJSON) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
