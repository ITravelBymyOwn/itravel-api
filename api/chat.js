// /api/chat.js — v31.0 (ESM compatible en Vercel)
// Partiendo del v30.0. Cambios quirúrgicos:
// - Reglas concisas de AURORAS en el SYSTEM_PROMPT
// - Post-proceso mínimo: ajustar ventana/duración/transporte de auroras,
//   asegurar "Regreso a hotel" tras auroras con duration: "Depende del tour",
//   y formatear durations < 1h en minutos.

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
// Utilidades mínimas para auroras y tiempos
// ==============================
const AURORA_RE = /aurora|boreal|northern lights|luces del norte/i;

function toMin(hhmm = "00:00") {
  const [h, m] = String(hhmm).split(":").map(Number);
  const hh = Number.isFinite(h) ? h : 0;
  const mm = Number.isFinite(m) ? m : 0;
  return hh * 60 + mm;
}
function fromMin(min) {
  const m = ((min % 1440) + 1440) % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}
function clampAuroraWindow(start = "21:00", end = "23:00") {
  // Ventana preferida 18:00–01:00 (permitir cruce de medianoche) y ≥4h
  const winStart = toMin("18:00");
  const winEnd = toMin("01:00") + 1440;
  let s = toMin(start);
  let e = toMin(end);
  if (e <= s) e = s + 240; // 4h mín
  if (s < winStart) {
    const d = winStart - s;
    s += d; e += d;
  }
  if (e - s < 240) e = s + 240;
  if (e > winEnd) {
    e = winEnd;
    if (e - s < 240) s = e - 240;
  }
  return { start: fromMin(s % 1440), end: fromMin(e % 1440) };
}
function minutesDiff(start, end) {
  const s = toMin(start || "00:00");
  let e = toMin(end || "00:00");
  if (e <= s) e += 1440; // permitir cruce de medianoche
  return e - s;
}

/**
 * Normalización mínima (quirúrgica):
 * - Ajusta actividades de auroras a 18:00–01:00 y ≥4h, y transporte "Tour guiado" si aplica.
 * - Asegura "Regreso a hotel" al final del día con auroras con duration "Depende del tour".
 * - Si cualquier actividad dura < 60 min (según start/end), duration = "<Xm>".
 */
function normalizeAurorasAndDurations(parsed) {
  if (!parsed) return parsed;

  const touchRows = (rows, destination) => {
    if (!Array.isArray(rows)) return rows;
    // Mapear días => filas
    const byDay = new Map();
    for (const r of rows) {
      const d = Number.isInteger(r?.day) && r.day > 0 ? r.day : 1;
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push({ ...r });
    }

    // Procesar por día
    for (const [d, arr] of byDay.entries()) {
      let hadAurora = false;
      // 1) Ajustes por fila (auroras + durations < 1h)
      for (const r of arr) {
        // Duración en minutos si < 1h (cuando existan start/end)
        if (r.start && r.end) {
          const mins = minutesDiff(r.start, r.end);
          if (mins > 0 && mins < 60) {
            r.duration = `${mins}m`;
          }
        }

        // Ajustes específicos de auroras
        if (AURORA_RE.test(r.activity || "")) {
          hadAurora = true;
          const { start, end } = clampAuroraWindow(r.start || "20:30", r.end || "00:30");
          r.start = start;
          r.end = end;
          const mins = minutesDiff(r.start, r.end);
          // Mantener duración ≥ 4h (formato en horas si el modelo ya lo dio; no obligatorio aquí)
          if (!r.duration || /^(?:\d{1,2}m)$/i.test(r.duration) || mins < 240) {
            r.duration = "4h";
          }
          if (!r.transport || /a pie/i.test(r.transport)) {
            r.transport = "Tour guiado";
          }
        }
      }

      // 2) Si hubo auroras, asegurar "Regreso a hotel" al final con duration "Depende del tour"
      if (hadAurora) {
        const sorted = arr.slice().sort((a, b) => {
          const sa = toMin(a.start || "09:00");
          const sb = toMin(b.start || "09:00");
          return sa - sb;
        });
        const last = sorted[sorted.length - 1];
        const alreadyReturn = /Regreso a hotel/i.test(last?.activity || "");
        if (!alreadyReturn) {
          const endRef = last?.end || "00:30";
          const endMin = toMin(endRef);
          arr.push({
            day: d,
            start: fromMin(endMin),
            end: fromMin(endMin), // sin duración definida por reloj; depende del traslado del tour
            activity: "Regreso a hotel",
            from: last?.to || destination || "",
            to: "Hotel",
            transport: "Tour guiado",
            duration: "Depende del tour",
            notes: "Regreso coordinado por el operador tras la experiencia de auroras.",
          });
        } else {
          // Si ya existe, forzar duration "Depende del tour" y transporte si aplica
          last.duration = "Depende del tour";
          if (!last.transport || /a pie/i.test(last.transport)) {
            last.transport = "Tour guiado";
          }
        }
      }

      // Reemplaza el día con la versión ajustada (manteniendo orden aproximado)
      byDay.set(d, arr);
    }

    // Reconstruir plano manteniendo orden por día y start
    const out = [];
    const days = Array.from(byDay.keys()).sort((a, b) => a - b);
    for (const d of days) {
      const arr = byDay.get(d).slice().sort((a, b) => {
        const sa = toMin(a.start || "09:00");
        const sb = toMin(b.start || "09:00");
        return sa - sb;
      });
      out.push(...arr);
    }
    return out;
  };

  // Formato B
  if (Array.isArray(parsed.rows)) {
    parsed.rows = touchRows(parsed.rows, parsed.destination);
    return parsed;
  }
  // Formato C (multi-ciudad)
  if (Array.isArray(parsed.destinations)) {
    parsed.destinations = parsed.destinations.map((d) => {
      if (d && Array.isArray(d.rows)) {
        return { ...d, rows: touchRows(d.rows, d.name || d.city || parsed.destination) };
      }
      return d;
    });
    return parsed;
  }
  return parsed;
}

// ==============================
// Prompt base mejorado ✨
// (añadimos solo un bloque conciso para auroras)
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
- Usa un tono cálido, entusiasta y narrativo.
- Notas: 1–2 líneas, variadas; sin marcas ni precios.

🚆 TRANSPORTE Y TIEMPOS
- Medios coherentes con el contexto.
- Horas ordenadas y sin solapes.
- Incluye tiempos aproximados de actividad y traslados.

🌌 AURORAS (si aplica por destino/temporada)
- Ventana objetivo **18:00–01:00** y **duración mínima 4h**.
- Usa **"Tour guiado"** si no hay transporte claro.
- **Cierra el día** con **"Regreso a hotel"** tras auroras.

💰 MONETIZACIÓN FUTURA (sin marcas)
- Sugiere experiencias con potencial de upsell sin precios ni marcas.

📝 EDICIÓN INTELIGENTE
- Ante “agregar día/quitar/ajustar horarios”, devuelve el JSON actualizado.

🎨 UX Y NARRATIVA
- Cada día fluye como historia (inicio → desarrollo → cierre).

🚫 ERRORES A EVITAR
- No devuelvas “seed”. No saludes ni expliques fuera del JSON.
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

    // 🧭 MODO PLANNER — v30 + normalización mínima de auroras y durations
    let raw = await callStructured([{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages]);
    let parsed = cleanToJSON(raw);

    // Ajuste quirúrgico: auroras + durations < 1h en minutos + regreso a hotel (Depende del tour)
    if (parsed) parsed = normalizeAurorasAndDurations(parsed);

    const hasRows = parsed && (parsed.rows || parsed.destinations);
    if (!hasRows) {
      const strictPrompt = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve al menos 1 fila en "rows". Nada de meta.`;
      raw = await callStructured([{ role: "system", content: strictPrompt }, ...clientMessages], 0.25);
      parsed = cleanToJSON(raw);
      if (parsed) parsed = normalizeAurorasAndDurations(parsed);
    }

    const stillNoRows = !parsed || (!parsed.rows && !parsed.destinations);
    if (stillNoRows) {
      const ultraPrompt = SYSTEM_PROMPT + `
Ejemplo válido:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
      raw = await callStructured([{ role: "system", content: ultraPrompt }, ...clientMessages], 0.1);
      parsed = cleanToJSON(raw);
      if (parsed) parsed = normalizeAurorasAndDurations(parsed);
    }

    if (!parsed) parsed = fallbackJSON();
    return res.status(200).json({ text: JSON.stringify(parsed) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
