// /api/chat.js — v30.3 (ESM compatible en Vercel)
// Base exacta: v30.2 estable. Cambios:
// - Limpieza estricta de nota de auroras (sin "valid: ...").
// - Mejora Destino-Subparadas (sin sobre-aplicar).
// - Corrección de transporte en day-trips sin bus.
// - Ajuste de DURACIÓN del regreso en day-trips (mapeos realistas).
// - Prompt reforzado para identificar tours clásicos y separar el regreso.

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

// Parser tolerante: toma el primer bloque {...} completo
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

// Fallback mínimo válido para la UI
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
// LÓGICA POST-PROCESO (auroras, transporte, subparadas, regresos)
// ==============================

// Heurística rápida de destinos clásicos de auroras
const AURORA_DESTINOS = [
  "reykjavik", "reykjavík", "tromso", "tromsø", "rovaniemi", "kiruna",
  "abisko", "alta", "ivalo", "yellowknife", "fairbanks", "akureyri"
];

// número recomendado de noches según días de viaje (cap sensato)
function auroraNightsByLength(totalDays) {
  if (totalDays <= 2) return 1;
  if (totalDays <= 4) return 2;
  if (totalDays <= 6) return 2;   // p.ej., 5 días → 2 noches (d2 y d4)
  if (totalDays <= 9) return 3;
  return 3;
}

/**
 * PARIDAD solicitada:
 * - totalDays PAR  → empezar en día 1 e ir 1,3,5,… (< totalDays)
 * - totalDays IMPAR→ empezar en día 2 e ir 2,4,6,… (< totalDays)
 * - Nunca usar el último día.
 */
function planAuroraDays(totalDays, count) {
  const start = (totalDays % 2 === 0) ? 1 : 2; // par→1, impar→2
  const out = [];
  let d = start;
  while (out.length < count && d < totalDays) { // d < totalDays evita el último día
    out.push(d);
    d += 2;
  }
  return out;
}

const AURORA_NOTE_SHORT =
  "Noche especial de caza de auroras. Con cielos despejados y paciencia, podrás presenciar un espectáculo natural inolvidable. " +
  "La hora de regreso al hotel dependerá del tour de auroras que se tome. " +
  "Puedes optar por tour guiado o movilización por tu cuenta (es probable que debas conducir con nieve y de noche; investiga seguridad para tus fechas).";

// eliminar cualquier rastro tipo “valid: ventana nocturna auroral…”
function scrubAuroraValid(text = "") {
  if (!text) return text;
  return text.replace(/valid:[^.\n\r]*auroral[^.\n\r]*\.?/gi, "").trim();
}

function isAuroraRow(r) {
  const t = (r?.activity || "").toLowerCase();
  return t.includes("aurora");
}

// zonas típicas de day-trip donde no usar “Bus”
const NO_BUS_TOPICS = [
  "círculo dorado", "thingvellir", "þingvellir", "geysir", "geyser",
  "gullfoss", "seljalandsfoss", "skógafoss", "reynisfjara", "vik", "vík",
  "snaefellsnes", "snæfellsnes", "kirkjufell", "djúpalónssandur", "arnarstapi", "hellnar",
  "blue lagoon", "reykjanes", "krýsuvík", "krysuvik", "grindavik"
];

function needsVehicleOrTour(row) {
  const a = (row.activity || "").toLowerCase();
  const to = (row.to || "").toLowerCase();
  return NO_BUS_TOPICS.some(k => a.includes(k) || to.includes(k));
}

function coerceTransport(rows) {
  return rows.map(r => {
    const transport = (r.transport || "").toLowerCase();
    // excepciones marítimas (p.ej., ballenas)
    const maritime = /ballena|ballenas|whale|barco|boat/.test((r.activity || "").toLowerCase());
    if (!maritime && transport.includes("bus") && needsVehicleOrTour(r)) {
      return { ...r, transport: "Vehículo alquilado o Tour guiado" };
    }
    return r;
  });
}

// Compacta actividad madre con subparadas: sólo si viene precedida por “Excursión …”
function compactSubstops(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;

    const act = (r.activity || "").toLowerCase();

    const isExcursionTrigger =
      act.startsWith("excursión") ||
      act.includes("costa sur") ||
      act.includes("península") ||
      act.includes("círculo dorado");

    if (isExcursionTrigger) {
      const sub = [];
      let j = i + 1;
      while (j < rows.length && sub.length < 3) {
        const rj = rows[j]; if (!rj) break;
        // subparadas típicas de estas rutas
        const aj = (rj.activity || "").toLowerCase();
        const isSub =
          aj.startsWith("visita") ||
          /cascada|playa|geysir|þingvellir|thingvellir|gullfoss|kirkjufell|djúpalónssandur|arnarstapi|hellnar/.test(aj);
        if (isSub) {
          sub.push(rj.to || rj.activity || "");
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
        for (let k = i + 1; k < i + 1 + sub.length; k++) {
          const rr = rows[k];
          out.push({ ...rr, notes: (rr?.notes || "Parada dentro de la ruta.") });
        }
        i = i + sub.length;
        continue;
      }
    }
    out.push(r);
  }
  return out;
}

// Ajusta DURACIONES de “Regreso a Reykjavík” según las paradas del día
function adjustDayTripReturns(rows) {
  // índices por día
  const days = {};
  for (const r of rows) {
    const d = Number(r.day) || 1;
    if (!days[d]) days[d] = [];
    days[d].push(r);
  }

  const contains = (arr, regex) =>
    arr.some(x => regex.test((x.activity || "") + " " + (x.to || "")));

  const setReturnDuration = (row, txt) => {
    row.duration = txt;
    // refuerza transporte correcto en regreso
    if (needsVehicleOrTour(row)) {
      row.transport = "Vehículo alquilado o Tour guiado";
    } else if (!row.transport) {
      row.transport = "Vehículo alquilado o Tour guiado";
    }
  };

  Object.values(days).forEach(dayRows => {
    // detectar el último “Regreso a Reykjavík”
    const returns = dayRows.filter(r => /regreso a reykjav[ií]k/.test((r.activity || "").toLowerCase()));
    if (!returns.length) return;

    // señales del tipo de ruta en el día
    const isSouth = contains(dayRows, /(vik|vík|reynisfjara|seljalandsfoss|skógafoss)/i);
    const isGolden = contains(dayRows, /(gullfoss|geysir|geyser|þingvellir|thingvellir|círculo dorado)/i);
    const isSnaef = contains(dayRows, /(snæfellsnes|snaefellsnes|kirkjufell|djúpalónssandur|arnarstapi|hellnar)/i);
    const isReykjanes = contains(dayRows, /(blue lagoon|reykjanes|krýsuvík|krysuvik|grindavik)/i);

    const target =
      isSouth ? "≈ 2h 45m" :
      isGolden ? "≈ 1h 45m" :
      isSnaef ? "≈ 2h 40m" :
      isReykjanes ? "≈ 45m–1h" :
      "≈ 1h+";

    returns.forEach(r => setReturnDuration(r, target));
  });

  return rows;
}

function ensureAuroras(parsed) {
  const dest =
    (parsed?.destination || parsed?.Destination || parsed?.city || parsed?.name || "").toString();
  const destName = dest || (parsed?.destinations?.[0]?.name || "");
  const low = destName.toLowerCase();

  const rows = Array.isArray(parsed?.rows)
    ? parsed.rows
    : Array.isArray(parsed?.destinations?.[0]?.rows])
      ? parsed.destinations[0].rows
      : [];

  if (!rows.length) return parsed;

  const totalDays = Math.max(...rows.map(r => Number(r.day) || 1));
  const isAuroraPlace = AURORA_DESTINOS.some(x => low.includes(x));

  // Normalizar transporte, subparadas
  let base = coerceTransport(compactSubstops(rows));

  // Limpieza de "valid: ..." en todas las notas
  base = base.map(r => ({ ...r, notes: scrubAuroraValid(r.notes) }));

  if (!isAuroraPlace) {
    // Ajustar regresos aunque no haya auroras
    const withReturns = adjustDayTripReturns(base);
    return normalizeShape(parsed, withReturns);
  }

  // Eliminar auroras preexistentes (para reinyectar en los días correctos)
  base = base.filter(r => !isAuroraRow(r));

  // Paridad + conteo recomendado
  const targetCount = auroraNightsByLength(totalDays);
  const targetDays = planAuroraDays(totalDays, targetCount);

  // Inyectar auroras 18:00–01:00
  for (const d of targetDays) {
    base.push({
      day: d,
      start: "18:00",
      end: "01:00",
      activity: "Caza de auroras boreales",
      from: "Hotel",
      to: "Puntos de observación (variable)",
      transport: "Vehículo alquilado o Tour guiado",
      duration: "~7h",
      notes: AURORA_NOTE_SHORT,
    });
  }

  // Orden por día/hora
  base.sort((a, b) => (a.day - b.day) || (a.start || "").localeCompare(b.start || ""));

  // Ajustar regresos en day-trips
  const withReturns = adjustDayTripReturns(base);

  return normalizeShape(parsed, withReturns);
}

// Uniformar salida al formato B) preferido
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
// Prompt base mejorado ✨
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido**.

📌 FORMATOS VÁLIDOS
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos una actividad en "rows".
- Nada de texto fuera del JSON.
- 20 actividades máximo por día.
- Usa horas realistas (o 08:30–19:00 si no se indica nada).
- Nunca devuelvas "seed" ni dejes campos vacíos.

🧭 ESTRUCTURA DE CADA ACTIVIDAD
{
  "day": 1,
  "start": "08:30",
  "end": "10:30",
  "activity": "Nombre claro y específico (permitido: 'Excursión — A → B → C')",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "A pie, Metro, Tren, Auto, Taxi, Bus, Ferry, Vehículo alquilado o Tour guiado",
  "duration": "2h",
  "notes": "Descripción breve y motivadora"
}

🚆 TRANSPORTE Y DAY-TRIPS (Reykjavík)
- Identifica los day-trips clásicos:
  • Círculo Dorado (Þingvellir — Geysir — Gullfoss)
  • Costa Sur (Seljalandsfoss — Skógafoss — Reynisfjara — **Vík**)
  • Península de Snæfellsnes (Kirkjufell — Djúpalónssandur — Arnarstapi/Hellnar)
  • Reykjanes / Blue Lagoon (Blue Lagoon — Krýsuvík — Grindavík)
- En estas rutas evita "Bus" y usa "Vehículo alquilado o Tour guiado".
- SEPARA el **regreso a Reykjavík** como una actividad propia. La **duración del regreso** debe ser el tiempo de trayecto real desde la última parada a Reykjavík (NO sumes paradas).
  • Referencias de trayecto (aprox.): Vík↔Reykjavík ≈ 2h45; Geysir↔Reykjavík ≈ 1h45; Arnarstapi/Hellnar↔Reykjavík ≈ 2h40; Blue Lagoon↔Reykjavík ≈ 45m–1h.
  • Si dudas, usa una estimación conservadora (nunca < 1h).

🌌 AURORAS (si aplica por destino/temporada)
- Distribuye noches **no consecutivas** según la paridad (pares→1,3,5… ; impares→2,4,6…).
- **Nunca** programes auroras en el último día.
- Horario fijo **18:00–01:00**; transporte **"Vehículo alquilado o Tour guiado"**.
- Nota breve SIN la frase “valid: ventana nocturna auroral…”.

📝 EDICIÓN INTELIGENTE
- Si el usuario pide ajustes, responde con el JSON completo y actualizado.
- Mantén narrativa corta y variada.
`.trim();

// ==============================
// Llamada al modelo
// ==============================
async function callStructured(messages, temperature = 0.4) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    input: messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
    max_output_tokens: 3000,
  });

  const text =
    resp?.output_text?.trim() ||
    resp?.output?.[0]?.content?.[0]?.text?.trim() ||
    "";

  console.log("🛰️ RAW RESPONSE:", text);
  return text;
}

// ==============================
// Exportación ESM
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body;
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    // MODO INFO CHAT — sin JSON
    if (mode === "info") {
      const raw = await callStructured(clientMessages);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // MODO PLANNER — JSON
    let raw = await callStructured([{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages]);
    let parsed = cleanToJSONPlus(raw);

    const hasRows = parsed && (parsed.rows || parsed.destinations);
    if (!hasRows) {
      const strictPrompt = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve solo JSON y al menos 1 fila en "rows". Sin explicaciones.`;
      raw = await callStructured([{ role: "system", content: strictPrompt }, ...clientMessages], 0.25);
      parsed = cleanToJSONPlus(raw);
    }

    // Último intento con plantilla mínima
    const stillNoRows = !parsed || (!parsed.rows && !parsed.destinations);
    if (stillNoRows) {
      const ultraPrompt = SYSTEM_PROMPT + `
Ejemplo válido estrictamente:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
      raw = await callStructured([{ role: "system", content: ultraPrompt }, ...clientMessages], 0.1);
      parsed = cleanToJSONPlus(raw);
    }

    // Si aún falla, NO rompemos la UI: base mínima
    if (!parsed) parsed = fallbackJSON();

    // Post-proceso integral (auroras / transporte / subparadas / regresos + normalización)
    const finalJSON = ensureAuroras(parsed);

    return res.status(200).json({ text: JSON.stringify(finalJSON) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
