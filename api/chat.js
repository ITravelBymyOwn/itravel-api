// /api/chat.js — v31.2
// Corrige fallback inmediato (mensajes → input), sintaxis en ensureAuroras, y robustez de salida.

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

function parseJsonSafe(raw = "") {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  try {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(raw.slice(first, last + 1));
    }
  } catch {}
  try {
    const cleaned = raw.replace(/^[^{]+/, "").replace(/[^}]+$/, "");
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
    followup: "⚠️ Fallback local: sin respuesta válida del agente.",
  };
}

// ==============================
// Postprocesos turísticos
// ==============================
const AURORA_DESTINOS = [
  "reykjavik", "reykjavík", "tromso", "tromsø", "rovaniemi", "kiruna",
  "abisko", "alta", "ivalo", "yellowknife", "fairbanks", "akureyri"
];

function auroraNightsByLength(days) {
  if (days <= 2) return 1;
  if (days <= 4) return 2;
  if (days <= 6) return 2;
  if (days <= 9) return 3;
  return 3;
}

function planAuroraDays(total, count) {
  const start = total % 2 === 0 ? 1 : 2;
  const out = [];
  for (let d = start; out.length < count && d < total; d += 2) out.push(d);
  return out;
}

function isAuroraRow(r) {
  return (r?.activity || "").toLowerCase().includes("aurora");
}

function ensureAuroras(parsed) {
  const dest = (parsed?.destination || parsed?.destinations?.[0]?.name || "").toLowerCase();
  const rows = Array.isArray(parsed?.rows)
    ? parsed.rows
    : Array.isArray(parsed?.destinations?.[0]?.rows)
      ? parsed.destinations[0].rows
      : [];
  if (!rows.length) return parsed;

  const totalDays = Math.max(...rows.map(r => Number(r.day) || 1));
  const isAuroraPlace = AURORA_DESTINOS.some(x => dest.includes(x));
  if (!isAuroraPlace) return parsed;

  const clean = rows.filter(r => !isAuroraRow(r));
  const nights = auroraNightsByLength(totalDays);
  const days = planAuroraDays(totalDays, nights);

  for (const d of days) {
    clean.push({
      day: d,
      start: "18:00",
      end: "01:00",
      activity: "Caza de auroras boreales",
      from: "Hotel",
      to: "Puntos de observación",
      transport: "Vehículo alquilado o Tour guiado",
      duration: "~7h",
      notes:
        "Noche especial de caza de auroras. Con cielos despejados y paciencia podrás presenciar un espectáculo natural inolvidable.",
    });
  }

  return {
    destination: parsed.destination || dest,
    rows: clean.sort((a, b) => a.day - b.day || a.start.localeCompare(b.start)),
    followup: parsed.followup || "",
  };
}

// ==============================
// Prompt reforzado
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, planificador turístico experto de ITravelByMyOwn.
Devuelve SIEMPRE JSON válido con campos: destination, rows[], followup.
Nada de texto fuera del JSON.

Cada actividad debe incluir:
day, start, end, activity, from, to, transport, duration, notes.

Reykjavík y similares:
- Day-trips típicos: Círculo Dorado, Costa Sur, Snæfellsnes, Blue Lagoon.
- Usa "Vehículo alquilado o Tour guiado" si no hay transporte público.
- Regreso realista (≥1h): Dorado 1h30m, Costa Sur 2h45m, Snæfellsnes 2h30m, Blue Lagoon 1h.

Auroras:
- Noches alternas (par → 1,3,5…; impar → 2,4,6…; nunca el último día).
- Horario 18:00–01:00, duración ~7h.
`.trim();

// ==============================
// Llamada al modelo
// ==============================
async function callStructured(messages, forceJson = false) {
  const payload = {
    model: "gpt-4o-mini",
    temperature: 0.35,
    max_output_tokens: 3200,
    messages,
  };
  if (forceJson) payload.response_format = { type: "json_object" };

  const resp = await client.responses.create(payload);
  const text = resp?.output_text?.trim() || "";
  return text;
}

// ==============================
// Handler principal
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = req.body || {};
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    if (mode === "info") {
      const text = await callStructured(clientMessages);
      return res.status(200).json({ text: text || "Sin respuesta del asistente." });
    }

    const fullMessages = [{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages];
    let raw = await callStructured(fullMessages, true);
    let parsed = parseJsonSafe(raw);

    if (!parsed || (!parsed.rows && !parsed.destinations)) {
      raw = await callStructured(fullMessages, true);
      parsed = parseJsonSafe(raw);
    }

    if (!parsed) parsed = fallbackJSON();
    const finalJSON = ensureAuroras(parsed);

    return res.status(200).json({ text: JSON.stringify(finalJSON) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
