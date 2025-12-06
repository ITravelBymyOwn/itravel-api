// /api/chat.js — v30.9 (ESM compatible en Vercel)
// Base exacta: v30.4.
// Reestructuración anti-fallback:
// - response_format con json_schema para garantizar JSON válido.
// - Parser robusto (texto, bloque {...}, json nativo).
// - Triple intento: esquema → esquema estricto → reparación con esquema.
// - Mantiene: auroras (paridad), subparadas (≤8), coerción de transporte,
//   limpieza de notas (incluye eliminación de "valid: ventana nocturna auroral (sujeto a clima)"
//   y duplicidades "min stay ~3h (ajustable)" en Blue Lagoon).

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

// Parser tolerante: acepta string, objeto JSON del SDK, o bloque {...}
function cleanToJSONPlus(raw) {
  if (!raw) return null;
  if (typeof raw === "object") {
    // Ya viene como objeto JSON válido
    if (raw.rows || raw.destinations) return raw;
    try {
      return JSON.parse(JSON.stringify(raw));
    } catch {}
  }
  if (typeof raw !== "string") return null;

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

// Fallback mínimo, pero en formato válido para la UI
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
// LÓGICA POST-PROCESO
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
  if (totalDays <= 6) return 2;
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

function isAuroraRow(r) {
  const t = (r?.activity || "").toLowerCase();
  return t.includes("aurora");
}

// Regla simple: excursiones icónicas fuera de ciudad — no usar “Bus”
const NO_BUS_TOPICS = [
  "círculo dorado", "thingvellir", "þingvellir", "geysir", "geyser",
  "gullfoss", "seljalandsfoss", "skógafoss", "reynisfjara", "vik", "vík",
  "snaefellsnes", "snæfellsnes", "blue lagoon", "reykjanes", "krýsuvík",
  "arnarstapi", "hellnar", "djúpalónssandur", "kirkjufell", "puente entre continentes"
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

// Limpieza específica de notas
function scrubAuroraValid(text = "") {
  if (!text) return text;
  return text.replace(/valid:[^.\n\r]*auroral[^.\n\r]*\.?/gi, "").trim();
}
function scrubBlueLagoon(text = "") {
  if (!text) return text;
  // elimina duplicidades “min stay ~3h (ajustable)”
  return text.replace(/(\s*[-–•·]\s*)?min\s*stay\s*~?3h\s*\(ajustable\)/gi, "").replace(/\s{2,}/g, " ").trim();
}

// Compacta actividad madre con subparadas: "Excursión — A → B → C"
function compactSubstops(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;

    const act = (r.activity || "").toLowerCase();
    if (act.startsWith("excursión") || act.includes("costa sur") || act.includes("península") || act.includes("círculo dorado")) {
      const sub = [];
      let j = i + 1;
      // hasta 8 subparadas
      while (j < rows.length && sub.length < 8) {
        const rj = rows[j];
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
        if (isSub) {
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

  // Normalizaciones y limpiezas
  let base = coerceTransport(compactSubstops(rows))
    .map(r => {
      let notes = scrubAuroraValid(r.notes);
      if ((r.to || "").toLowerCase().includes("blue lagoon") || (r.activity || "").toLowerCase().includes("blue lagoon")) {
        notes = scrubBlueLagoon(notes);
      }
      return { ...r, notes };
    });

  if (!isAuroraPlace) {
    return normalizeShape(parsed, base);
  }

  // Eliminar auroras previas y reinyectar según paridad
  base = base.filter(r => !isAuroraRow(r));

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

  // Orden cronológico por día y hora
  base.sort((a, b) => (a.day - b.day) || (a.start || "").localeCompare(b.start || ""));

  return normalizeShape(parsed, base);
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
// Prompt base con conocimiento turístico global
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn. Eres un experto mundial en turismo.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido**.

📌 FORMATO
{"destination":"City","rows":[{...}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos una actividad en "rows".
- Nada de texto fuera del JSON.
- Máx. 20 actividades por día.
- Usa horas realistas (08:30–19:00 si no hay otras).
- No devuelvas "seed" ni campos vacíos.

🧭 ESTRUCTURA
{
  "day": 1,
  "start": "08:30",
  "end": "10:30",
  "activity": "Nombre claro y específico (permitido: 'Excursión — A → B → C')",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "A pie, Bus, Vehículo alquilado o Tour guiado, etc.",
  "duration": "2h",
  "notes": "Descripción breve y motivadora"
}

🌍 CONOCIMIENTO TURÍSTICO GLOBAL
- Considera siempre tus conocimientos sobre destinos, distancias y tiempos habituales entre lugares turísticos.
- Si el destino no cuenta con red pública eficiente, usa **"Vehículo alquilado o Tour guiado"**.

🏔️ TOURS CLÁSICOS DESDE REYKJAVÍK (duraciones de regreso orientativas reales)
- **Círculo Dorado**: Thingvellir → Geysir → Gullfoss → regreso a Reykjavík (≈1h15m–1h45m).
- **Costa Sur**: Seljalandsfoss → Skógafoss → Reynisfjara → Vík → regreso a Reykjavík (≈2h30m–3h).
- **Snæfellsnes**: Kirkjufell, Arnarstapi, Hellnar, Djúpalónssandur → regreso a Reykjavík (≈2h15m–3h).
- **Reykjanes / Blue Lagoon**: laguna como última parada → regreso a Reykjavík (≈45m–1h).

🌌 AURORAS
- Noches alternas según paridad de días (par→1,3,5…; impar→2,4,6…), nunca el último día.
- Horario 18:00–01:00, transporte "Vehículo alquilado o Tour guiado".
- No incluyas frases como "valid: ventana nocturna auroral (sujeto a clima)".

🧩 DESTINO–SUBPARADAS
- Excursiones con varias paradas: actividad madre “Excursión — …” + hasta 8 subparadas.
`.trim();

// ==============================
// JSON Schema para forzar formato
// ==============================
const ITINERARY_SCHEMA = {
  name: "Itinerary",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      destination: { type: "string" },
      rows: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            day: { type: "integer", minimum: 1 },
            start: { type: "string" },
            end: { type: "string" },
            activity: { type: "string" },
            from: { type: "string" },
            to: { type: "string" },
            transport: { type: "string" },
            duration: { type: "string" },
            notes: { type: "string" }
          },
          required: ["day", "start", "end", "activity", "from", "to", "transport", "duration", "notes"]
        }
      },
      followup: { type: "string" }
    },
    required: ["destination", "rows"]
  },
  strict: true
};

// ==============================
// Llamadas al modelo (con esquema)
// ==============================
async function callWithSchema(messages, { temperature = 0.35 } = {}) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    input: messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
    response_format: { type: "json_schema", json_schema: ITINERARY_SCHEMA },
    max_output_tokens: 3500,
  });

  // Intenta extraer JSON nativo del Responses API
  const c = resp?.output?.[0]?.content?.[0];
  if (c && typeof c === "object" && (c.json || c.parsed || c.object)) {
    return c.json || c.parsed || c.object;
  }

  const text =
    resp?.output_text?.trim() ||
    resp?.output?.[0]?.content?.find?.(x => typeof x.text === "string")?.text?.trim() ||
    "";

  return text;
}

async function callFree(messages, { temperature = 0.4 } = {}) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    input: messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
    max_output_tokens: 3200,
  });
  return (
    resp?.output_text?.trim() ||
    resp?.output?.[0]?.content?.find?.(x => typeof x.text === "string")?.text?.trim() ||
    resp?.output?.[0]?.content?.find?.(x => typeof x.json === "string")?.json?.trim() ||
    ""
  );
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

    // INFO CHAT — texto libre (sin esquema)
    if (mode === "info") {
      const raw = await callFree(clientMessages, { temperature: 0.5 });
      const text = raw || "⚠️ No se obtuvo respuesta.";
      return res.status(200).json({ text });
    }

    // PLANNER — Forzar JSON con esquema
    let raw = await callWithSchema(
      [{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages],
      { temperature: 0.25 }
    );
    let parsed = cleanToJSONPlus(raw);

    // Reintento estricto (misma instrucción + recordatorio)
    const hasRows = parsed && (parsed.rows || parsed.destinations);
    if (!hasRows) {
      const strictPrompt = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve solo JSON con "destination" y una lista "rows" (≥1).`;
      raw = await callWithSchema(
        [{ role: "system", content: strictPrompt }, ...clientMessages],
        { temperature: 0.2 }
      );
      parsed = cleanToJSONPlus(raw);
    }

    // Reparación final bajo el mismo esquema (sin cambiar contenido original del usuario)
    const stillNoRows = !parsed || (!parsed.rows && !parsed.destinations);
    if (stillNoRows) {
      const repair = await callWithSchema(
        [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content:
              "Repara la salida para que cumpla el esquema. Devuelve únicamente el JSON del itinerario con al menos 1 actividad en rows."
          }
        ],
        { temperature: 0.15 }
      );
      parsed = cleanToJSONPlus(repair);
    }

    // Si aún falla, NO rompemos la UI: entregamos base mínima
    if (!parsed) parsed = fallbackJSON();

    // Post-proceso: auroras / transporte / subparadas / limpieza de notas
    const finalJSON = ensureAuroras(parsed);

    return res.status(200).json({ text: JSON.stringify(finalJSON) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    // Nunca rompemos la UI
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
