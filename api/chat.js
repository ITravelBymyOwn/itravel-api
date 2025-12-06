// /api/chat.js — v31.0 (ESM compatible en Vercel)
// Base: v30.3 tuya. Reestructuración anti-fallback + lógica turística completa.
// Cambios clave:
// 1) Forzar JSON nativo sólo en modo "planner" con response_format: { type: "json_object" }.
// 2) Parser triple (json nativo → bloque {...} → limpieza de bordes).
// 3) Prompt reforzado con conocimiento turístico (day-trips y regresos realistas).
// 4) Post-proceso: subparadas (hasta 8), transporte, regresos, auroras por paridad,
//    y eliminación de “valid: ventana nocturna auroral (sujeto a clima)”.

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

// Parser robusto
function parseJsonSafe(raw = "") {
  if (!raw) return null;
  // 1) intento directo
  try { return JSON.parse(raw); } catch {}
  // 2) buscar primer {...} último }
  try {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      const slice = raw.slice(first, last + 1);
      return JSON.parse(slice);
    }
  } catch {}
  // 3) limpieza de bordes (caracteres antes/después)
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
    followup: "⚠️ Fallback local: revisa configuración de Vercel o API Key.",
  };
}

// ==============================
// Lógica turística (post-proceso)
// ==============================

// Destinos de auroras (heurística)
const AURORA_DESTINOS = [
  "reykjavik", "reykjavík", "tromso", "tromsø", "rovaniemi", "kiruna",
  "abisko", "alta", "ivalo", "yellowknife", "fairbanks", "akureyri"
];

function auroraNightsByLength(totalDays) {
  if (totalDays <= 2) return 1;
  if (totalDays <= 4) return 2;
  if (totalDays <= 6) return 2;   // 5–6 días → 2 noches
  if (totalDays <= 9) return 3;
  return 3;
}

/**
 * Paridad de auroras:
 * - total PAR  → 1,3,5,… (nunca último día)
 * - total IMPAR→ 2,4,6,… (nunca último día)
 */
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

function scrubAuroraValid(text = "") {
  if (!text) return text;
  // elimina “valid: ventana nocturna auroral (sujeto a clima)” u otras variantes
  return text.replace(/valid:[^.\n\r]*auroral[^.\n\r]*\.?/gi, "").trim();
}

function isAuroraRow(r) {
  const t = (r?.activity || "").toLowerCase();
  return t.includes("aurora");
}

// Lugares sin bus público eficiente para day-trips típicos de Islandia
const NO_BUS_TOPICS = [
  "círculo dorado", "thingvellir", "þingvellir", "geysir", "geyser",
  "gullfoss", "seljalandsfoss", "skógafoss", "skogafoss", "reynisfjara",
  "vik", "vík",
  "snaefellsnes", "snæfellsnes", "kirkjufell", "djúpalónssandur", "djupalonssandur",
  "arnarstapi", "hellnar",
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
    const maritime = /ballena|ballenas|whale|barco|boat|avistamiento/i.test((r.activity || ""));
    if (!maritime && transport.includes("bus") && needsVehicleOrTour(r)) {
      return { ...r, transport: "Vehículo alquilado o Tour guiado" };
    }
    return r;
  });
}

// Compactar sub-paradas (máx 8) manteniendo filas hijas (para notas/tiempos)
function compactSubstops(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;

    const act = (r.activity || "").toLowerCase();
    const isExcursion = act.startsWith("excursión") || act.includes("costa sur") || act.includes("península") || act.includes("círculo dorado");
    if (isExcursion) {
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
          || aj.includes("djupalonssandur")
          || aj.includes("vík") || aj.includes("vik")
          || aj.includes("reynisfjara");
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

// Ajuste de “Regreso a Reykjavík” según ruta del día
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
    : Array.isArray(parsed?.destinations?.[0]?.rows])
      ? parsed.destinations[0].rows
      : [];

  if (!rows.length) return parsed;

  const totalDays = Math.max(...rows.map(r => Number(r.day) || 1));
  const isAuroraPlace = AURORA_DESTINOS.some(x => low.includes(x));

  // Normalizaciones comunes
  let base = coerceTransport(compactSubstops(rows));
  base = base.map(r => ({ ...r, notes: scrubAuroraValid(r.notes) }));

  if (!isAuroraPlace) {
    const withReturns = adjustDayTripReturns(base);
    return normalizeShape(parsed, withReturns);
  }

  // Eliminar auroras previas y reinyectar según paridad
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
// Prompt base (reforzado)
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes de ITravelByMyOwn. Eres un experto mundial en turismo.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido**, listo para renderizar en una UI.

📌 FORMATOS VÁLIDOS
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos una actividad en "rows".
- Nada de texto fuera del JSON. Cero explicaciones externas.
- Máximo 20 actividades por día.
- Usa horas ordenadas y realistas (o 08:30–19:00 si no se indica nada).
- No devuelvas "seed" ni campos vacíos.

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

🧠 CONTEXTO TURÍSTICO (Islandia y similares)
- Identifica correctamente **day-trips** clásicos desde Reykjavík:
  • Círculo Dorado (Þingvellir → Geysir → Gullfoss)
  • Costa Sur (Seljalandsfoss → Skógafoss → Reynisfjara → Vík)
  • Península de Snæfellsnes (Kirkjufell, Arnarstapi, Hellnar, Djúpalónssandur)
  • Reykjanes / Blue Lagoon
- Si el destino no tiene transporte público eficiente para estas rutas,
  usa **"Vehículo alquilado o Tour guiado"** en lugar de "Bus".

🚗 REGRESO A LA CIUDAD (MUY IMPORTANTE)
- Para la fila **"Regreso a {Ciudad}"** en **day-trips**:
  • **NO** reutilices la duración de la última parada ni un traslado interno.
  • Calcula el trayecto real desde el **último punto** visitado hasta la ciudad base.
  • Usa valores realistas (redondeo 15min) y **≥ 1h**:
    - Círculo Dorado ↔ Reykjavík: **1h15m–1h45m**
    - Costa Sur (Vík/Reynisfjara) ↔ Reykjavík: **2h30m–3h**
    - Snæfellsnes ↔ Reykjavík: **2h15m–3h**
    - Reykjanes/Blue Lagoon ↔ Reykjavík: **45m–1h**
  • En caso de duda, **sobreestima** ligeramente.

🌌 AURORAS (si el destino/época lo permiten)
- Noches **no consecutivas** por **paridad**:
  • Total **par** → 1, 3, 5, … (nunca el último día)
  • Total **impar** → 2, 4, 6, … (nunca el último día)
- Horario fijo **18:00–01:00**; transporte **"Vehículo alquilado o Tour guiado"**.
- **No escribas** la frase “valid: ventana nocturna auroral (sujeto a clima)”.

🧩 DESTINO–SUBPARADAS
- Puedes modelar una excursión como actividad madre y hasta **8 sub-paradas** antes del regreso.

📝 EDICIÓN INTELIGENTE
- Si el usuario pide cambios, devuelve el JSON completo actualizado.
`.trim();

// ==============================
// Llamada al modelo
// ==============================
async function callStructured(messages, { temperature = 0.4, forceJson = false } = {}) {
  const payload = {
    model: "gpt-4o-mini",
    temperature,
    input: messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
    max_output_tokens: 3200,
  };
  if (forceJson) payload.response_format = { type: "json_object" };

  const resp = await client.responses.create(payload);

  // Intentos de extracción (algunos SDKs exponen diferentes rutas)
  const text =
    resp?.output_text?.trim()
    || resp?.output?.[0]?.content?.find?.(c => typeof c.text === "string")?.text?.trim()
    || resp?.output?.[0]?.content?.find?.(c => typeof c.json === "string")?.json?.trim()
    || "";

  return text;
}

// ==============================
// Handler
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body;
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    // INFO CHAT — texto libre, sin JSON estricto
    if (mode === "info") {
      const raw = await callStructured(clientMessages, { forceJson: false });
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // PLANNER — JSON estricto
    let raw = await callStructured(
      [{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages],
      { forceJson: true, temperature: 0.35 }
    );
    let parsed = parseJsonSafe(raw);

    // Reintentos con temperatura baja si no hay rows
    const hasRows = parsed && (parsed.rows || parsed.destinations);
    if (!hasRows) {
      const strictPrompt = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve solo JSON y al menos 1 fila en "rows". Sin explicaciones.`;
      raw = await callStructured(
        [{ role: "system", content: strictPrompt }, ...clientMessages],
        { forceJson: true, temperature: 0.2 }
      );
      parsed = parseJsonSafe(raw);
    }

    // Última plantilla mínima (aún JSON estricto)
    const stillNoRows = !parsed || (!parsed.rows && !parsed.destinations);
    if (stillNoRows) {
      const ultraPrompt = SYSTEM_PROMPT + `
Ejemplo válido estrictamente:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
      raw = await callStructured(
        [{ role: "system", content: ultraPrompt }, ...clientMessages],
        { forceJson: true, temperature: 0.1 }
      );
      parsed = parseJsonSafe(raw);
    }

    // Garantizar salida válida
    if (!parsed) parsed = fallbackJSON();

    // Post-proceso y normalización
    const finalJSON = ensureAuroras(parsed);

    return res.status(200).json({ text: JSON.stringify(finalJSON) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    // Nunca rompemos la UI
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
