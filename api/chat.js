// /api/chat.js — v30.3.2 (ESM compatible en Vercel)
// Base exacta: v30.3 que enviaste.
// Cambios mínimos para evitar fallback:
// 1) JSON mode SOLO en modo "planner" usando response_format: { type: "json_object" }.
// 2) callStructured ahora acepta { forceJson } para no afectar el modo "info".
// 3) Parser se mantiene pero casi no será necesario gracias a JSON mode.
//
// Se conservan íntegros: paridad de auroras, subparadas (hasta 8), coerción de transporte,
// ajustes de "Regreso a Reykjavík", y limpieza de nota de auroras.

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

// Parser tolerante (respaldo si el modelo ignorara JSON mode)
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

// Fallback mínimo, válido para la UI
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

const AURORA_DESTINOS = [
  "reykjavik", "reykjavík", "tromso", "tromsø", "rovaniemi", "kiruna",
  "abisko", "alta", "ivalo", "yellowknife", "fairbanks", "akureyri"
];

function auroraNightsByLength(totalDays) {
  if (totalDays <= 2) return 1;
  if (totalDays <= 4) return 2;
  if (totalDays <= 6) return 2;
  if (totalDays <= 9) return 3;
  return 3;
}

function planAuroraDays(totalDays, count) {
  const start = (totalDays % 2 === 0) ? 1 : 2; // par→1, impar→2
  const out = [];
  let d = start;
  while (out.length < count && d < totalDays) {
    out.push(d);
    d += 2;
  }
  return out;
}

const AURORA_NOTE_SHORT =
  "Noche especial de caza de auroras. Con cielos despejados y paciencia, podrás presenciar un espectáculo natural inolvidable. " +
  "La hora de regreso al hotel dependerá del tour de auroras que se tome. " +
  "Puedes optar por tour guiado o movilización por tu cuenta (es probable que debas conducir con nieve y de noche; investiga seguridad para tus fechas).";

function scrubAuroraValid(text = "") {
  if (!text) return text;
  return text.replace(/valid:[^.\n\r]*auroral[^.\n\r]*\.?/gi, "").trim();
}

function isAuroraRow(r) {
  const t = (r?.activity || "").toLowerCase();
  return t.includes("aurora");
}

const NO_BUS_TOPICS = [
  "círculo dorado", "thingvellir", "þingvellir", "geysir", "geyser",
  "gullfoss", "seljalandsfoss", "skógafoss", "reynisfjara", "vik", "vík",
  "snaefellsnes", "snæfellsnes", "blue lagoon", "reykjanes", "krýsuvík",
  "krysuvik", "arnarstapi", "hellnar", "kirkjufell", "djúpalónssandur", "djupalonssandur", "grindavik"
];

function needsVehicleOrTour(row) {
  const a = (row.activity || "").toLowerCase();
  const to = (row.to || "").toLowerCase();
  return NO_BUS_TOPICS.some(k => a.includes(k) || to.includes(k));
}

function coerceTransport(rows) {
  return rows.map(r => {
    const transport = (r.transport || "").toLowerCase();
    const maritime = /ballena|ballenas|whale|barco|boat/.test((r.activity || "").toLowerCase());
    if (!maritime && transport.includes("bus") && needsVehicleOrTour(r)) {
      return { ...r, transport: "Vehículo alquilado o Tour guiado" };
    }
    return r;
  });
}

function compactSubstops(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;

    const act = (r.activity || "").toLowerCase();
    if (act.startsWith("excursión") || act.includes("costa sur") || act.includes("península") || act.includes("círculo dorado")) {
      const sub = [];
      let j = i + 1;
      while (j < rows.length && sub.length < 8) {
        const rj = rows[j];
        const aj = (rj?.activity || "").toLowerCase();
        const isSub = aj.startsWith("visita")
          || aj.includes("cascada")
          || aj.includes("playa")
          || aj.includes("geysir")
          || aj.includes("thingvellir")
          || aj.includes("gullfoss")
          || aj.includes("kirkjufell")
          || aj.includes("arnarstapi")
          || aj.includes("hellnar")
          || aj.includes("djúpalónssandur")
          || aj.includes("djupalonssandur");
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

function adjustDayTripReturns(rows) {
  const days = {};
  for (const r of rows) {
    const d = Number(r.day) || 1;
    if (!days[d]) days[d] = [];
    days[d].push(r);
  }

  const contains = (arr, regex) =>
    arr.some(x => regex.test(((x.activity || "") + " " + (x.to || "")).toLowerCase()));

  const setReturnDuration = (row, txt) => {
    row.duration = txt;
    if (needsVehicleOrTour(row) || !row.transport) {
      row.transport = "Vehículo alquilado o Tour guiado";
    }
  };

  Object.values(days).forEach(dayRows => {
    const returns = dayRows.filter(r => /regreso a reykjav[ií]k/.test((r.activity || "").toLowerCase()));
    if (!returns.length) return;

    const isSouth = contains(dayRows, /(vik|vík|reynisfjara|seljalandsfoss|skógafoss|skogafoss)/i);
    const isGolden = contains(dayRows, /(gullfoss|geysir|geyser|þingvellir|thingvellir|círculo dorado)/i);
    const isSnaef = contains(dayRows, /(snæfellsnes|snaefellsnes|kirkjufell|djúpalónssandur|djupalonssandur|arnarstapi|hellnar)/i);
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
    : Array.isArray(parsed?.destinations?.[0]?.rows)
      ? parsed.destinations[0].rows
      : [];

  if (!rows.length) return parsed;

  const totalDays = Math.max(...rows.map(r => Number(r.day) || 1));
  const isAuroraPlace = AURORA_DESTINOS.some(x => low.includes(x));

  // Normalizar transporte y subparadas
  let base = coerceTransport(compactSubstops(rows));

  // Limpiar “valid: … auroral …” de cualquier nota
  base = base.map(r => ({ ...r, notes: scrubAuroraValid(r.notes) }));

  if (!isAuroraPlace) {
    const withReturns = adjustDayTripReturns(base);
    return normalizeShape(parsed, withReturns);
  }

  // Eliminar auroras preexistentes
  base = base.filter(r => !isAuroraRow(r));

  // Paridad y noches objetivo
  const targetCount = auroraNightsByLength(totalDays);
  const targetDays = planAuroraDays(totalDays, targetCount);

  // Inyectar auroras
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

  base.sort((a, b) => (a.day - b.day) || (a.start || "").localeCompare(b.start || ""));

  const withReturns = adjustDayTripReturns(base);
  return normalizeShape(parsed, withReturns);
}

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

🚆 TRANSPORTE Y TIEMPOS (MUY IMPORTANTE)
- En destinos sin red pública eficiente (p. ej., Islandia para Círculo Dorado, Costa Sur/Reynisfjara/Vík y Snæfellsnes),
  usa **"Vehículo alquilado o Tour guiado"** en lugar de "Bus".
- Para la fila **"Regreso a {Ciudad}"** de un **day-trip**:
  • **NO** reutilices la duración de la última parada ni un traslado interno como si fuera el regreso.
  • Estima el **trayecto real** desde el **último punto visitado** hasta la ciudad base.
  • Usa valores **conservadores y realistas**, redondeados a **15 min** y **nunca menores a 1h**.
  • Guías orientativas (no rígidas):
    - **Círculo Dorado ↔ Reykjavík**: aprox. **1h15m–1h45m**.
    - **Costa Sur (Vík/Reynisfjara) ↔ Reykjavík**: aprox. **2h30m–3h**.
    - **Snæfellsnes (Arnarstapi/Ólafsvík) ↔ Reykjavík**: aprox. **2h15m–3h**.
    - **Reykjanes/Blue Lagoon ↔ Reykjavík**: aprox. **45m–1h**.
  • Si dudas, **prefiere sobreestimar** ligeramente el regreso.

🌌 AURORAS (si aplica por destino/temporada)
- Distribuye noches **no consecutivas** según la **paridad**:
  • Total **par** → noches **1, 3, 5, …** (nunca el último día).
  • Total **impar** → noches **2, 4, 6, …** (nunca el último día).
- Horario predefinido **18:00–01:00**; transporte **"Vehículo alquilado o Tour guiado"**.
- **Nunca escribas** la frase “valid: ventana nocturna auroral (sujeto a clima)”.

🧩 DESTINO–SUBPARADAS
- Representa excursiones con varias paradas como una **actividad madre** (“Excursión — …”) seguida de subparadas,
  pudiendo mostrar hasta **8** paradas (p. ej., Þingvellir → Geysir → Gullfoss → …) antes del regreso.

📝 EDICIÓN INTELIGENTE
- Si el usuario pide ajustes, responde con el JSON completo y actualizado.
- Mantén narrativa corta y variada.
`.trim();

// ==============================
// Llamada al modelo
// ==============================
async function callStructured(messages, { temperature = 0.4, forceJson = false } = {}) {
  const payload = {
    model: "gpt-4o-mini",
    temperature,
    input: messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
    max_output_tokens: 3000,
  };
  // JSON estricto solo cuando lo pedimos (planner)
  if (forceJson) {
    payload.response_format = { type: "json_object" };
  }

  const resp = await client.responses.create(payload);

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

    // MODO INFO CHAT — sin JSON mode
    if (mode === "info") {
      const raw = await callStructured(clientMessages, { forceJson: false });
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // MODO PLANNER — forzamos JSON nativo
    let raw = await callStructured(
      [{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages],
      { forceJson: true, temperature: 0.4 }
    );
    let parsed = cleanToJSONPlus(raw);

    const hasRows = parsed && (parsed.rows || parsed.destinations);
    if (!hasRows) {
      const strictPrompt = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve solo JSON y al menos 1 fila en "rows". Sin explicaciones.`;
      raw = await callStructured(
        [{ role: "system", content: strictPrompt }, ...clientMessages],
        { forceJson: true, temperature: 0.25 }
      );
      parsed = cleanToJSONPlus(raw);
    }

    // Último intento (aún en JSON mode) con plantilla mínima
    const stillNoRows = !parsed || (!parsed.rows && !parsed.destinations);
    if (stillNoRows) {
      const ultraPrompt = SYSTEM_PROMPT + `
Ejemplo válido estrictamente:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
      raw = await callStructured(
        [{ role: "system", content: ultraPrompt }, ...clientMessages],
        { forceJson: true, temperature: 0.1 }
      );
      parsed = cleanToJSONPlus(raw);
    }

    if (!parsed) parsed = fallbackJSON();

    const finalJSON = ensureAuroras(parsed);

    return res.status(200).json({ text: JSON.stringify(finalJSON) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
