// /api/chat.js — v31.0 (ESM compatible en Vercel)
// Partiendo del v30.0 original, se agrega exclusivamente:
// - Reglas de AURORAS en el SYSTEM_PROMPT
// - Normalización post-proceso de auroras (ventana 18:00–01:00, ≥4h)
// - Evitar noches consecutivas y que la única sea el último día
// - Relajar mañana siguiente (inicio ≥10:30)
// - Cierre con "Regreso a hotel" tras actividad de auroras
// Mantiene el resto del pipeline intacto.

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

function cleanToJSON(raw = "") {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
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
        notes: "Explora libremente la ciudad y descubre sus lugares más emblemáticos.",
      },
    ],
    followup: "⚠️ Fallback local: revisa configuración de Vercel o API Key.",
  };
}

// ==============================
// Utilidades auroras (mínimas y autocontenidas)
// ==============================
const AURORA_RE = /aurora|boreal|northern lights|luces del norte/i;

function toMin(hhmm = "00:00") {
  const [h, m] = String(hhmm).split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}
function fromMin(min) {
  const m = ((min % 1440) + 1440) % 1440;
  const h = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${h}:${mm}`;
}

function clampAuroraWindow(start = "21:00", end = "23:00") {
  // Ventana preferida: 18:00–01:00 (permite cruce de medianoche)
  const winStart = toMin("18:00");
  const winEnd = toMin("01:00") + 1440;
  let s = toMin(start);
  let e = toMin(end);
  if (e <= s) e = s + 240; // ≥4h
  // Ajustar dentro de ventana
  if (s < winStart) {
    const d = winStart - s;
    s += d;
    e += d;
  }
  if (e - s < 240) e = s + 240;
  if (e > winEnd) {
    e = winEnd;
    if (e - s < 240) s = e - 240;
  }
  return { start: fromMin(s % 1440), end: fromMin(e % 1440) };
}

function groupByDay(rows) {
  const map = new Map();
  for (const r of rows) {
    const d = Number.isInteger(r.day) && r.day > 0 ? r.day : 1;
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(r);
  }
  return map;
}

function sortRows(arr) {
  return arr
    .slice()
    .sort((a, b) => (a.day - b.day) || (toMin(a.start || "09:00") - toMin(b.start || "09:00")));
}

function ensureReturnHotelAtEnd(dayRows) {
  const last = dayRows[dayRows.length - 1];
  if (!last) return;
  const already = /Regreso a hotel/i.test(last.activity || "");
  if (already) return;
  const s = toMin(last.end || "23:30");
  dayRows.push({
    day: last.day || 1,
    start: fromMin(s),
    end: fromMin(s + 20),
    activity: "Regreso a hotel",
    from: last.to || "",
    to: "Hotel",
    transport: AURORA_RE.test(last.activity || "") ? "Tour guiado" : (last.transport || "Taxi"),
    duration: "20m",
    notes: "Descanso tras una jornada intensa.",
  });
}

function relaxNextMorning(byDay, d) {
  const next = d + 1;
  if (!byDay.has(next)) return;
  const rows = sortRows(byDay.get(next) || []);
  let minStart = toMin("10:30");
  const shifted = [];
  for (const r of rows) {
    const s = toMin(r.start || "09:00");
    const e = toMin(r.end || fromMin(s + 90));
    if (s < minStart) {
      const delta = minStart - s;
      r.start = fromMin(s + delta);
      r.end = fromMin(e + delta);
    }
    shifted.push(r);
  }
  byDay.set(next, shifted);
}

function enforceAuroraCaps(rows) {
  // Reglas: evitar consecutivas; evitar "única" en último día; cap: 1 noche si 3–4 días, 2 noches si ≥5
  const byDay = groupByDay(rows);
  const days = Array.from(byDay.keys()).sort((a, b) => a - b);
  if (!days.length) return rows;

  // Detectar días con auroras
  let auroraDays = days.filter((d) => (byDay.get(d) || []).some((r) => AURORA_RE.test(r.activity || "")));

  const totalDays = days.length;
  const cap = totalDays <= 2 ? 0 : totalDays <= 4 ? 1 : 2;

  // Quitar consecutivas manteniendo primeras
  auroraDays = auroraDays.filter((d, i, arr) => !(i > 0 && Math.abs(d - arr[i - 1]) === 1));

  // Evitar única en último día
  if (auroraDays.length === 1 && auroraDays[0] === days[days.length - 1] && days.length > 1) {
    const fallbackDay = days[days.length - 2];
    const src = byDay.get(auroraDays[0]) || [];
    const kept = [];
    const moved = [];
    for (const r of src) {
      if (AURORA_RE.test(r.activity || "")) moved.push({ ...r, day: fallbackDay });
      else kept.push(r);
    }
    byDay.set(auroraDays[0], kept);
    byDay.set(fallbackDay, [...(byDay.get(fallbackDay) || []), ...moved]);
    auroraDays = [fallbackDay];
  }

  // Aplicar tope global
  while (auroraDays.length > cap) {
    const d = auroraDays.pop();
    const rowsD = (byDay.get(d) || []).filter((r) => !AURORA_RE.test(r.activity || ""));
    byDay.set(d, rowsD);
  }

  // Relajar mañana siguiente a cada noche de auroras
  for (const d of auroraDays) relaxNextMorning(byDay, d);

  // Cerrar con regreso a hotel en días con auroras
  for (const d of auroraDays) {
    const arr = sortRows(byDay.get(d) || []);
    if (arr.length) {
      // Ajustar ventana de la(s) actividad(es) de auroras y cerrar día
      for (const r of arr) {
        if (AURORA_RE.test(r.activity || "")) {
          const { start, end } = clampAuroraWindow(r.start, r.end);
          r.start = start;
          r.end = end;
          if (!r.transport || /a pie/i.test(r.transport)) r.transport = "Tour guiado";
          r.duration = `${Math.max(240, toMin(r.end) - toMin(r.start))}m`;
        }
      }
      ensureReturnHotelAtEnd(arr);
      byDay.set(d, sortRows(arr));
    }
  }

  // Reconstruir plano
  const out = [];
  for (const d of Array.from(byDay.keys()).sort((a, b) => a - b)) {
    out.push(...sortRows(byDay.get(d) || []));
  }
  return out;
}

function normalizeAurorasInPlace(parsed) {
  if (!parsed) return parsed;

  // Formato B (destination/rows) o C (destinations[])
  if (Array.isArray(parsed.rows)) {
    parsed.rows = enforceAuroraCaps(parsed.rows);
    return parsed;
  }
  if (Array.isArray(parsed.destinations)) {
    // Ajuste por cada destino sin cambiar el formato original
    parsed.destinations = parsed.destinations.map((d) => {
      if (d && Array.isArray(d.rows)) {
        return { ...d, rows: enforceAuroraCaps(d.rows) };
      }
      return d;
    });
    return parsed;
  }
  return parsed;
}

// ==============================
// Prompt base mejorado ✨ (solo se añaden reglas de AURORAS)
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido** que describa un itinerario turístico inspirador y funcional.

📌 FORMATOS VÁLIDOS DE RESPUESTA
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[...]}],"followup":"texto breve"}

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
  "transport": "A pie, Metro, Bus, Taxi, Vehículo alquilado o Tour guiado, Ferry, Tren…",
  "duration": "2h",
  "notes": "Breve, motivadora; sin marcas ni precios"
}

🧠 ESTILO Y EXPERIENCIA DE USUARIO
- Tono cálido y narrativo; notas cortas y variadas.

🚆 TRANSPORTE Y TIEMPOS
- Medios coherentes con el contexto; horas ordenadas y sin solapes.
- Incluye tiempos aproximados de actividad y traslados.

🌌 REGLAS DE AURORAS (aplícalas solo si el destino/temporada lo amerita)
- Ventana objetivo: 18:00–01:00 y **duración mínima 4h**.
- Evita noches **consecutivas** y evita que la **única** noche sea el **último día**.
- Tras una noche de auroras, el día siguiente inicia **≥10:30** y con plan cercano/urbano.
- Cierra la jornada con **"Regreso a hotel"** (usa "Tour guiado" si corresponde).

🚫 ERRORES A EVITAR
- No "seed", no marcas, no precios, nada fuera del JSON.
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
    const mode = body.mode || "planner"; // 👈 mantiene parámetro
    const clientMessages = extractMessages(body);

    // 🧭 MODO INFO CHAT — sin JSON, texto libre
    if (mode === "info") {
      const raw = await callStructured(clientMessages);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // 🧭 MODO PLANNER — comportamiento original + normalización de auroras
    let raw = await callStructured([{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages]);
    let parsed = cleanToJSON(raw);

    // 🔧 Normalización de auroras (quirúrgica, no altera otras lógicas)
    if (parsed) parsed = normalizeAurorasInPlace(parsed);

    const hasRows = parsed && (parsed.rows || parsed.destinations);
    if (!hasRows) {
      const strictPrompt = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve al menos 1 fila en "rows". Nada de meta.`;
      raw = await callStructured([{ role: "system", content: strictPrompt }, ...clientMessages], 0.25);
      parsed = cleanToJSON(raw);
      if (parsed) parsed = normalizeAurorasInPlace(parsed);
    }

    const stillNoRows = !parsed || (!parsed.rows && !parsed.destinations);
    if (stillNoRows) {
      const ultraPrompt = SYSTEM_PROMPT + `
Ejemplo válido:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
      raw = await callStructured([{ role: "system", content: ultraPrompt }, ...clientMessages], 0.1);
      parsed = cleanToJSON(raw);
      if (parsed) parsed = normalizeAurorasInPlace(parsed);
    }

    if (!parsed) parsed = fallbackJSON();
    return res.status(200).json({ text: JSON.stringify(parsed) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
