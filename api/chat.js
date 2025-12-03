// /api/chat.js — v36.6 (ESM compatible en Vercel)
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
  return text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function tryExtractJSONObject(s = "") {
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
  if (stripped) candidates.push(stripped);

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
        transport: "Taxi",
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

const AURORA_CITY_RE =
  /(reykjav[ií]k|reikiavik|reykiavik|akureyri|troms[oø]|tromso|alta|bod[oø]|narvik|lofoten|abisko|kiruna|rovaniemi|yellowknife|fairbanks|murmansk|iceland|islandia|lapland|laponia)/i;

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

// *** NUEVO: clave de orden por minuto que respeta actividades nocturnas ***
function sortKeyMinutes(row) {
  const s = toMinutes(row.start || "00:00");
  const e = toMinutes(row.end || row.start || "00:00");
  let key = s;

  // Auroras que cruzan medianoche: end < start → empújalas al final (+24h)
  if (AURORA_RE.test(row.activity || "") && e < s) key = s + 1440;

  // "Regreso a hotel" tras auroras: si empieza de madrugada (<04:00), va después (+24h)
  if (/regreso\s+a\s+hotel/i.test(row.activity || "") && s < 240) key = s + 1440;

  return key;
}

// Ajuste horario para auroras (18:00–01:00; preferencia 21:30–00:30)
function normalizeAuroraWindow(row) {
  if (!AURORA_RE.test(row.activity || "")) return row;
  const MIN_EVENING = toMinutes("18:00");
  const PREF_START = toMinutes("21:30");
  const PREF_END = toMinutes("00:30");
  const MAX_END = toMinutes("01:00");

  let s = toMinutes(row.start || "21:30");
  let e = toMinutes(row.end || "00:30");

  if (s < MIN_EVENING) s = PREF_START;
  if (e <= s) e = s + 120;
  if (e > MAX_END) e = Math.min(PREF_END, MAX_END);

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

  const anyTrip = rowsOfDay.some(r =>
    OUT_OF_TOWN_RE.test(`${r.activity||""} ${r.to||""}`)
  );
  if (!anyTrip) return rowsOfDay;

  const last = rowsOfDay[rowsOfDay.length - 1] || {};
  const alreadyBack =
    /regreso\s+a/i.test(last.activity || "") ||
    new RegExp(destination, "i").test(last.to || "");
  if (alreadyBack) return rowsOfDay;

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
    transport: "Vehículo alquilado o Tour guiado",
    duration: "1h 10m",
    notes: "Retorno a la ciudad base para cerrar el día.",
  };
  return [...rowsOfDay, back];
}

// Regreso a hotel tras auroras si no existe
function ensureHotelReturnAfterAurora(rowsOfDay) {
  if (!Array.isArray(rowsOfDay) || !rowsOfDay.length) return rowsOfDay;
  const last = rowsOfDay[rowsOfDay.length - 1] || {};
  if (!AURORA_RE.test(last.activity || "")) return rowsOfDay;

  const alreadyBack = /regreso\s+a\s+(hotel|alojamiento)/i.test(last.activity || "");
  if (alreadyBack) return rowsOfDay;

  const endMins = toMinutes(last.end || "00:30");
  const start = toHHMM(endMins + 5);
  const end = toHHMM(endMins + 45);

  const back = {
    day: last.day,
    start,
    end,
    activity: "Regreso a hotel",
    from: last.to || "Zona de observación",
    to: "Hotel",
    transport: "Tour guiado",
    duration: "0.75h",
    notes: "Finaliza la noche con un retorno cómodo al alojamiento.",
  };
  return [...rowsOfDay, back];
}

function isAuroraEligibleCity(name = "") {
  return AURORA_CITY_RE.test(String(name || ""));
}

function injectAuroraIfMissing(dest, rows) {
  if (!isAuroraEligibleCity(dest)) return rows;

  const byDay = rows.reduce((acc, r) => {
    (acc[r.day] = acc[r.day] || []).push(r);
    return acc;
  }, {});
  const days = Object.keys(byDay).map(Number).sort((a, b) => a - b);
  if (!days.length) return rows;

  const hasAurora = rows.some(r => AURORA_RE.test(r.activity || ""));
  if (hasAurora) return rows;

  const last = days[days.length - 1];
  const d1 = days.find(d => d !== last) || days[0];
  const d2 = days.length >= 4
    ? days.find(d => d !== d1 && d !== last && Math.abs(d - d1) > 1)
    : null;

  const makeAuroraRow = (day) => {
    const endLast = toMinutes((byDay[day].slice(-1)[0]?.end) || "20:30");
    const s = Math.max(endLast + 30, toMinutes("21:30"));
    const e = s + 120;
    return normalizeAuroraWindow({
      day,
      start: toHHMM(s),
      end: toHHMM(e),
      activity: "Caza de Auroras Boreales",
      from: dest,
      to: "Zona de observación",
      transport: "Vehículo alquilado o Tour guiado",
      duration: "2h",
      notes: "Salida nocturna para intentar ver auroras (horario orientativo).",
    });
  };

  const augmented = rows.slice();
  augmented.push(makeAuroraRow(d1));
  if (d2) augmented.push(makeAuroraRow(d2));

  augmented.sort((a, b) => (a.day - b.day) || (sortKeyMinutes(a) - sortKeyMinutes(b)));
  return augmented;
}

function relaxNextMorningIfAurora(byDay) {
  const dayNums = Object.keys(byDay).map(Number).sort((a,b)=>a-b);
  const auroraDays = new Set(
    dayNums.filter(d => (byDay[d]||[]).some(r => AURORA_RE.test(r.activity||"")))
  );
  const MIN_START = toMinutes("10:30");

  for (const d of dayNums) {
    if (!auroraDays.has(d - 1)) continue;
    const rows = byDay[d];
    if (!rows || !rows.length) continue;

    let firstStart = Math.min(...rows.map(r => toMinutes(r.start || "23:59")));
    if (firstStart >= MIN_START) continue;
    const shift = MIN_START - firstStart;

    for (const r of rows) {
      const s = toMinutes(r.start || "00:00") + shift;
      const e = toMinutes(r.end || r.start || "00:00") + shift;
      r.start = toHHMM(s);
      r.end = toHHMM(e);
    }
  }
}

/** Normaliza la respuesta del modelo */
function normalizeParsed(parsed) {
  if (!parsed || typeof parsed !== "object") return null;

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

  let rows = parsed.rows
    .map((r, idx) => {
      const dayNum = Number.isFinite(+r.day) && +r.day > 0 ? +r.day : 1 + (idx % 7);
      const start = (r.start || "").toString().trim() || "09:00";
      const end = (r.end || "").toString().trim() || "10:00";
      const activity = (r.activity || "").toString().trim() || "Actividad";
      let transport = ((r.transport || "").toString().trim());

      // *** AJUSTE: sólo fuerzo la dupla si está vacío o "A pie"; respeto Bus/Tren/Metro si el modelo lo eligió ***
      const isTrip = OUT_OF_TOWN_RE.test(`${activity} ${(r.to || "").toString()}`);
      if (isTrip && (!transport || /a pie/i.test(transport))) {
        transport = "Vehículo alquilado o Tour guiado";
      } else if (!isTrip && !transport) {
        transport = "Taxi";
      }

      return {
        day: dayNum,
        start,
        end,
        activity,
        from: (r.from || "").toString(),
        to: (r.to || "").toString(),
        transport,
        duration: (r.duration || "").toString(),
        notes: (r.notes || "").toString() || "Una parada ideal para disfrutar.",
      };
    })
    .slice(0, 120);

  rows = rows.map(normalizeAuroraWindow);

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
      byDay[d].sort((a,b) => sortKeyMinutes(a) - sortKeyMinutes(b));
      let fixed = ensureReturnLine(dest, byDay[d]);
      fixed = ensureHotelReturnAfterAurora(fixed);
      byDay[d] = fixed;
      merged.push(...fixed);
    });

  relaxNextMorningIfAurora(byDay);

  const shifted = [];
  Object.keys(byDay)
    .map(Number)
    .sort((a,b)=>a-b)
    .forEach(d => {
      byDay[d].sort((a,b) => sortKeyMinutes(a) - sortKeyMinutes(b));
      shifted.push(...byDay[d]);
    });

  const withAuroras = injectAuroraIfMissing(dest, shifted);

  withAuroras.sort((a, b) => (a.day - b.day) || (sortKeyMinutes(a) - sortKeyMinutes(b)));

  parsed.rows = withAuroras;
  return parsed;
}

// ==============================
// Prompt base (reglas del agente)
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido** con un itinerario inspirador y funcional.

📌 FORMATOS VÁLIDOS
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos 1 actividad en "rows".
- Cero texto fuera del JSON (sin explicaciones).
- Máximo 20 actividades por día.
- Horarios **flexibles y realistas** (no asumas ventana fija). Distribuye mañana/mediodía/tarde y extiende la noche cuando aporte valor (cenas, shows, auroras).
- Cenas **opcionales**, no obligatorias.
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

🌟 IMPERDIBLES Y RADIO DE COBERTURA
- Identifica **recorridos icónicos** del destino (day-trips, penínsulas, cascadas, volcanes, rutas escénicas).
- Si la estancia es **≤ 5 días**, prioriza lo mejor dentro de **~2h–2h30 por trayecto**; si es **> 5 días**, permite **~3h**.
- Desglosa en **sub-paradas** con el formato **"Destino — Subparada"** (p.ej., "Costa Sur — Seljalandsfoss", "Círculo Dorado — Geysir").
- **No priorices "A pie" por inercia**: elige el medio que maximiza experiencia (clima, distancia, confort).
- Si existe **transporte público eficiente** para un day trip, puedes usarlo; si no, usa **"Vehículo alquilado o Tour guiado"**.

🌌 AURORAS — **REGLA DURA**
- Sugiere auroras sólo si latitud ≥ ~55°N y fecha en temporada (fin de ago–mediados de abr).
- Horarios **≥ 18:00**, ideal **21:30–00:30** (no más tarde de ~01:00).
- Evita noches consecutivas y que la única sea el último día.
- Tras una noche de auroras, **día siguiente inicia ≥10:30** con plan urbano/cercano.

🚆 TRANSPORTE Y TIEMPOS
- Horas ordenadas, sin solapes, con buffers razonables.
- En day trips sin preferencia explícita del usuario, usa **"Vehículo alquilado o Tour guiado"** salvo que el transporte público sea **claramente** eficiente.
- Incluye tiempos aproximados de actividad y traslados.

🔁 REGRESO
- Si hubo salida fuera de la ciudad base, agrega **"Regreso a <Ciudad base>"** al final.
- En noches de auroras, finaliza con **"Regreso a hotel"**.

📝 EDICIÓN
- Si el usuario pide agregar/quitar/ajustar, responde con el **JSON actualizado**.

🎨 ESTILO
- Cada día fluye como una historia; notas cortas y motivadoras.
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

    if (mode === "info") {
      const raw = await callStructured(clientMessages);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    let raw = await callStructured(
      [{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages],
      0.4
    );
    let parsed = normalizeParsed(cleanToJSON(raw));

    const hasRows = parsed && Array.isArray(parsed.rows) && parsed.rows.length > 0;
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
    }

    const stillNoRows = !parsed || !Array.isArray(parsed.rows) || parsed.rows.length === 0;
    if (stillNoRows) {
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
    }

    if (!parsed) parsed = fallbackJSON();
    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
