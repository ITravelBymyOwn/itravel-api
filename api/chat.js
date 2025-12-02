// /api/chat.js — v34.2 (ESM compatible en Vercel)
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

function stripCodeFences(text = "") {
  if (typeof text !== "string") return text;
  // elimina ```json ... ``` o ``` ... ```
  return text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function tryExtractJSONObject(s = "") {
  // Busca el primer bloque {...} balanceado
  const txt = String(s);
  const start = txt.indexOf("{");
  const end = txt.lastIndexOf("}");
  if (start >= 0 && end > start) return txt.slice(start, end + 1);
  return null;
}

function cleanToJSON(raw = "") {
  if (!raw || typeof raw !== "string") return null;

  const candidates = [];
  const stripped = stripCodeFences(raw);
  candidates.push(stripped);

  const fenced = (raw.match(/```(?:json)?([\s\S]*?)```/i) || [])[1];
  if (fenced) candidates.push(fenced.trim());

  const sliced = tryExtractJSONObject(raw);
  if (sliced) candidates.push(sliced);

  for (const c of candidates) {
    try {
      const j = JSON.parse(c);
      if (j && typeof j === "object") return j;
    } catch (_) {}
  }
  return null;
}

function fallbackJSON() {
  return {
    destination: "Desconocido",
    rows: [
      {
        day: 1,
        start: "09:00",
        end: "10:00",
        activity: "Actividad",
        from: "",
        to: "",
        transport: "A pie",
        duration: "1h",
        notes: "Explora un rincón de la ciudad.",
      },
    ],
    followup: "⚠️ Fallback local: revisa configuración de Vercel o API Key.",
  };
}

// ==============================
// Normalización y post-procesos
// ==============================
const OUT_OF_TOWN_RE =
  /\b(thingvellir|þingvellir|gullfoss|geysir|golden\s*circle|círculo\s*dorado|seljalandsfoss|skógafoss|skogafoss|reynisfjara|v[ií]k|sn[aá]efellsnes|kirkjufell|djúpalónssandur|puente\s+entre\s+continentes|sn[aá]efellsj[oö]kull|blue\s*lagoon|laguna\s*azul|reykjanes|costa\s*sur|pen[ií]nsula|fiordo|glaciar|volc[aá]n|cueva\s+de\s+hielo|ice\s*cave|whale\s*watching)\b/i;

const AURORA_RE = /\b(auroras?|northern\s*lights?)\b/i;

function pad(n) { return n.toString().padStart(2, "0"); }

function toMinutes(hhmm = "00:00") {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
function toHHMM(mins = 0) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${pad(h)}:${pad(m)}`;
}

// Ajuste horario para actividades de auroras
function normalizeAuroraWindow(row) {
  if (!AURORA_RE.test(row.activity || "")) return row;
  // ventana plausible 21:30–02:30 (no antes de 21:00 ni después de 03:00)
  let s = toMinutes(row.start || "21:30");
  let e = toMinutes(row.end || "00:30");
  const MIN_START = toMinutes("21:00");
  const PREF_START = toMinutes("21:30");
  const MAX_END = toMinutes("03:00");
  if (s < MIN_START) s = PREF_START;
  if (e <= s) e = s + 120; // mínimo 2h
  if (e > MAX_END) e = MAX_END;
  return {
    ...row,
    start: toHHMM(s),
    end: toHHMM(e),
    transport: row.transport || "Vehículo alquilado o Tour guiado",
  };
}

// Inserta “Regreso a <dest>” si hubo salida fuera de ciudad y el día no cierra con retorno
function ensureReturnLine(destination, rowsOfDay) {
  if (!Array.isArray(rowsOfDay) || !rowsOfDay.length) return rowsOfDay;
  const anyTrip = rowsOfDay.some(r => OUT_OF_TOWN_RE.test(`${r.activity||""} ${r.to||""}`));
  if (!anyTrip) return rowsOfDay;

  const last = rowsOfDay[rowsOfDay.length - 1] || {};
  const alreadyBack =
    /regreso\s+a/i.test(last.activity || "") ||
    new RegExp(destination, "i").test(last.to || "");
  if (alreadyBack) return rowsOfDay;

  // crear regreso con buffer 30m–90m
  const endMins = toMinutes(last.end || "18:00");
  const start = toHHMM(endMins + 20);
  const end = toHHMM(endMins + 90);
  const back = {
    day: last.day,
    start,
    end,
    activity: `Regreso a ${destination}`,
    from: last.to || last.activity || destination,
    to: destination,
    transport:
      /tour|veh[ií]culo|auto/i.test(last.transport || "")
        ? "Vehículo alquilado o Tour guiado"
        : (last.transport || "Vehículo alquilado o Tour guiado"),
    duration: "1h 10m",
    notes: "Retorno a la ciudad base para cerrar el día.",
  };
  return [...rowsOfDay, back];
}

// Detección simple de ciudades aptas para auroras
function isAuroraCity(name = "") {
  const n = String(name || "").toLowerCase();
  return /(reykjav[ií]k|reikiavik|reykiavik|troms[oø]|tromso|abisko|rovaniemi)/i.test(n);
}

// Inyecta auroras si el itinerario plausible no las incluyó (no consecutivas, evitando solo el último día)
function injectAuroraIfMissing(dest, rows) {
  if (!isAuroraCity(dest)) return rows;

  const byDay = rows.reduce((acc, r) => {
    (acc[r.day] = acc[r.day] || []).push(r);
    return acc;
  }, {});
  const days = Object.keys(byDay).map(Number).sort((a, b) => a - b);
  if (!days.length) return rows;

  const totalDays = days.length;
  const hasAurora = rows.some(r => AURORA_RE.test(r.activity || ""));
  if (hasAurora) return rows;

  const lastDay = days[days.length - 1];
  const candidate1 = days.find(d => d !== lastDay) || days[0];
  const candidate2 =
    totalDays >= 4
      ? days.find(d => d !== candidate1 && d !== lastDay)
      : null;

  const makeAuroraRow = (day) => {
    const endLast = toMinutes((byDay[day].slice(-1)[0]?.end) || "20:45");
    const s = Math.max(endLast + 30, toMinutes("21:30"));
    const e = s + 120;
    return normalizeAuroraWindow({
      day,
      start: toHHMM(s),
      end: toHHMM(e),
      activity: "Caza de Auroras Boreales",
      from: dest,
      to: "Zona de caza",
      transport: "Vehículo alquilado o Tour guiado",
      duration: "2h",
      notes: "Salida nocturna para intentar ver auroras (horario orientativo).",
    });
  };

  let augmented = rows.slice();
  augmented.push(makeAuroraRow(candidate1));
  if (candidate2 && Math.abs(candidate2 - candidate1) > 1) {
    augmented.push(makeAuroraRow(candidate2));
  }

  augmented.sort((a, b) => (a.day - b.day) || (toMinutes(a.start) - toMinutes(b.start)));
  return augmented;
}

/** Normaliza una respuesta del modelo:
 *  - Si viene en formato C (destinations[]), lo transforma a formato B
 *  - Garantiza rows con campos mínimos y day numérico
 *  - Post-procesa auroras, transporte y línea de regreso
 */
function normalizeParsed(parsed) {
  if (!parsed || typeof parsed !== "object") return null;

  // Aceptar formato C -> convertir al primero con rows
  if (!parsed.rows && Array.isArray(parsed.destinations)) {
    const first = parsed.destinations.find(
      (d) => Array.isArray(d.rows) && d.rows.length > 0
    );
    if (first) {
      parsed = {
        destination: first.name || first.city || first.destination || "Destino",
        rows: first.rows,
        followup: parsed.followup || "",
      };
    }
  }

  if (!Array.isArray(parsed.rows)) return null;

  // Sanitizar filas (sin cambiar la semántica)
  let rows = parsed.rows
    .map((r, idx) => {
      const dayNum =
        Number.isFinite(+r.day) && +r.day > 0 ? +r.day : 1 + (idx % 7);
      const start = (r.start || "").toString().trim() || "09:00";
      const end = (r.end || "").toString().trim() || "10:00";
      const activity = (r.activity || "").toString().trim() || "Actividad";
      let transport = ((r.transport || "").toString().trim());

      // Fuerza transporte dual en salidas fuera de ciudad si está vacío o no viable
      const isTrip = OUT_OF_TOWN_RE.test(`${activity} ${(r.to || "").toString()}`);
      if (isTrip && (!transport || /a pie|bus|tren/i.test(transport))) {
        transport = "Vehículo alquilado o Tour guiado";
      }

      // En urbano: no priorizar "A pie"—si duraciones largas o clima frío probable, permitir Taxi/Bus
      if (!isTrip && (!transport || /a pie/i.test(transport))) {
        transport = "A pie"; // se mantiene si el modelo lo eligió, pero no lo forzamos por defecto
      }

      return {
        day: dayNum,
        start,
        end,
        activity,
        from: (r.from || "").toString(),
        to: (r.to || "").toString(),
        transport: transport || "Taxi",
        duration: (r.duration || "").toString() || "1h",
        notes: (r.notes || "").toString() || "Una parada ideal para disfrutar.",
      };
    })
    .slice(0, 160); // safety

  // Ajustes de auroras (ventanas plausibles)
  rows = rows.map(normalizeAuroraWindow);

  // Insertar "Regreso a <ciudad>" al final de días con day-trip si falta
  const dest = parsed.destination || "Ciudad";
  const byDay = rows.reduce((acc, r) => {
    (acc[r.day] = acc[r.day] || []).push(r);
    return acc;
  }, {});
  const merged = [];
  Object.keys(byDay)
    .map((d) => +d)
    .sort((a, b) => a - b)
    .forEach((d) => {
      const fixed = ensureReturnLine(dest, byDay[d]);
      merged.push(...fixed);
    });

  // Inyectar auroras si corresponde y no existen
  const withAuroras = injectAuroraIfMissing(dest, merged);

  // Reordenar final por día/hora
  withAuroras.sort((a, b) => (a.day - b.day) || (toMinutes(a.start) - toMinutes(b.start)));

  parsed.rows = withAuroras;
  return parsed;
}

// ==============================
// Prompt base (reglas, sin predefinir rutas)
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido** que describa un itinerario turístico inspirador y funcional.

📌 FORMATOS VÁLIDOS
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos una actividad en "rows".
- Nada de texto fuera del JSON (sin explicaciones).
- Máximo 20 actividades por día.
- Usa horas **realistas con flexibilidad** (no asumas ventana fija). Distribuye mañana/mediodía/tarde y extiende la noche cuando tenga sentido (cenas, shows, auroras).
- La respuesta debe renderizarse directamente en una UI web.
- No devuelvas "seed" ni dejes campos vacíos.

🧭 ESTRUCTURA DE CADA ACTIVIDAD
{
  "day": 1,
  "start": "08:30",
  "end": "10:30",
  "activity": "Nombre claro y específico",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "Transporte realista (A pie, Metro, Taxi, Bus, Auto, Ferry, Tour guiado)",
  "duration": "2h",
  "notes": "Descripción motivadora y breve"
}

🌟 COBERTURA DE IMPERDIBLES (sin listas predefinidas)
- Identifica **recorridos icónicos** del destino consultando tu conocimiento general: day-trips, penínsulas, cascadas, volcanes, parques, rutas escénicas, etc.
- Si la estancia es **≤ 5 días**, prioriza lo mejor dentro de **~2h por trayecto** desde la ciudad base; si es **> 5 días**, puedes llegar hasta **~3h por trayecto**.
- Desglosa tours en **sub-paradas** usando “**Destino — Subparada**” (p.ej., “Costa Sur — Cascada X”).
- No priorices “A pie” por inercia: elige el **medio más conveniente** para maximizar la experiencia (clima, distancias, confort).

🌌 AURORAS (si aplica por destino/temporada)
- Proponlas de forma inteligente (sin noches consecutivas y evitando que solo sea el último día).
- Horarios plausibles: inicio **21:30–22:30**, fin **00:00–02:30**.

🚆 TRANSPORTE Y TIEMPOS
- Horas ordenadas y **sin solaparse**, con buffers razonables.
- En **salidas fuera de la ciudad** cuando el usuario no especifica, usa **"Vehículo alquilado o Tour guiado"** (evita bus/tren si no es viable).
- Incluye tiempos de actividad y traslados.

🔁 REGRESO
- Si el día sale fuera de la ciudad base, **agrega** al final una fila “**Regreso a <Ciudad base>**” con hora realista.

📝 EDICIÓN
- Si el usuario pide agregar/quitar/ajustar, responde con el **JSON actualizado**.

🎨 ESTILO
- Flujo de día como “historia” (inicio, desarrollo, cierre).
- Notas cortas y motivadoras; vocabulario variado.

🚫 EVITA
- “seed”, saludos, explicaciones externas, notas repetidas, frases impersonales.
`.trim();

// ==============================
// Llamada al modelo
// ==============================
async function callStructured(messages, temperature = 0.4) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    input: messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
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
// Exportación ESM
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body || {};
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    // 🧭 MODO INFO CHAT — sin JSON, texto libre
    if (mode === "info") {
      const raw = await callStructured(clientMessages);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // 🧭 MODO PLANNER — con reglas flexibles
    let raw = await callStructured(
      [{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages],
      0.4
    );
    let parsed = normalizeParsed(cleanToJSON(raw));

    // Pass 2: exige al menos 1 row
    let hasRows = parsed && Array.isArray(parsed.rows) && parsed.rows.length > 0;
    if (!hasRows) {
      const strictPrompt =
        SYSTEM_PROMPT +
        `

OBLIGATORIO: Devuelve al menos 1 fila en "rows". Nada de meta.`;
      raw = await callStructured(
        [{ role: "system", content: strictPrompt }, ...clientMessages],
        0.25
      );
      parsed = normalizeParsed(cleanToJSON(raw));
      hasRows = parsed && Array.isArray(parsed.rows) && parsed.rows.length > 0;
    }

    // Pass 3: ejemplo mínimo (sin predefinir destino; solo formato)
    if (!hasRows) {
      const ultraPrompt =
        SYSTEM_PROMPT +
        `
Ejemplo VÁLIDO de formato mínimo:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"Taxi","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
      raw = await callStructured(
        [{ role: "system", content: ultraPrompt }, ...clientMessages],
        0.1
      );
      parsed = normalizeParsed(cleanToJSON(raw));
      hasRows = parsed && Array.isArray(parsed.rows) && parsed.rows.length > 0;
    }

    // Última malla: si sigue sin parsear, sintetiza una fila mínima para NO caer en fallback total
    if (!hasRows) {
      const synth = fallbackJSON();
      // pero sin marcar seguimiento de error duro para no cortar el flujo del planner
      return res.status(200).json({ text: JSON.stringify(synth) });
    }

    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
