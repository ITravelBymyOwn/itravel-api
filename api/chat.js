// /api/chat.js — v31.0 (ESM compatible en Vercel)
// Basado en v30.0 con integración quirúrgica de:
// - response_format: { type: "json_object" } para modo planner
// - Conversión formato C (multi-ciudad) → B (primera ciudad con rows)
// - Pipeline robusto: 3 intentos + normalización + guardas anti-vaciado
// - Heurísticas ciudad vs day-trips y reglas específicas de auroras
// - Transporte realista y cierres de día (regreso a ciudad + hotel)
// - Dedupe y siembra urbana mínima si todo falla

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ==============================
// Helpers I/O
// ==============================
function extractMessages(body = {}) {
  const { messages, input, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;
  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";
  return [...prev, { role: "user", content: userText }];
}

function isPlainObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function cleanToJSON(raw) {
  // Acepta objeto directo (Responses API), string JSON, y fenced con basura
  if (isPlainObject(raw)) return raw;
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    try {
      // Recorta basura fuera del primer {...} o [...]
      const start = raw.indexOf("{") >= 0 ? raw.indexOf("{") : raw.indexOf("[");
      const end = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"));
      if (start >= 0 && end > start) {
        const cleaned = raw.slice(start, end + 1);
        return JSON.parse(cleaned);
      }
      return null;
    } catch {
      return null;
    }
  }
}

function fallbackJSON(dest = "Desconocido") {
  return {
    destination: dest || "Desconocido",
    rows: [
      {
        day: 1,
        start: "09:00",
        end: "18:00",
        activity: "Paseo urbano esencial",
        from: "",
        to: dest || "Centro histórico",
        transport: "A pie",
        duration: "9h",
        notes:
          "Descubre los imprescindibles del destino a tu ritmo y siente la atmósfera local.",
      },
    ],
    followup: "Se usó un seed urbano mínimo coherente para evitar vacío.",
    replace: false,
  };
}

// ==============================
// Reglas — Prompt base ✨
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido** que describa un itinerario turístico inspirador y funcional.

📌 FORMATOS VÁLIDOS DE RESPUESTA
B) {"destination":"City","rows":[{...}],"followup":"texto breve","replace":false}
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
  "transport": "Transporte realista (A pie, Metro, Tren, Auto, Taxi, Bus, Ferry, Vehículo alquilado o Tour guiado)",
  "duration": "2h",
  "notes": "Descripción motivadora breve (sin marcas ni precios)"
}

🧠 ESTILO Y EXPERIENCIA DE USUARIO
- Tono cálido, entusiasta y narrativo.
- Notas: 1–2 líneas; motivadoras; vocabulario variado.

🚆 TRANSPORTE Y TIEMPOS
- Medios coherentes con el contexto.
- Horas ordenadas y sin solapes (cruce de medianoche permitido si aporta valor).
- Incluye tiempos aproximados de actividad y traslados.

💰 MONETIZACIÓN FUTURA (sin marcas)
- Sugiere actividades con potencial de upsell (cafés, museos, experiencias) sin precios ni marcas.

📝 EDICIÓN INTELIGENTE
- Ante pedidos de "agregar día/quitar/ajustar horarios": responde con el itinerario JSON actualizado.
- Si no hay horas: distribuye mañana/mediodía/tarde lógicamente.

🎨 UX Y NARRATIVA
- Cada día fluye como una historia (inicio → desarrollo → cierre).

🌌 REGLAS DE AURORAS (si aplica por latitud/temporada)
- Ventana 18:00–01:00, duración ≥4h.
- Evitar noches consecutivas y que la única sea el último día.
- El día siguiente inicia ≥10:30 y cercano/urbano.
- Cierra con "Regreso a hotel" (Tour guiado si aplica).

🏙️ CIUDAD vs DAY-TRIPS (explica la decisión en followup)
- Prioriza imperdibles urbanos antes de excursiones.
- 1–2 días: 0 day-trips (salvo caso extraordinario).
- 3–4 días: máx. 1 day-trip.
- ≥5 días: 1–2 day-trips si agregan valor.
- Traslado ideal ≤2h30 (≤3h si estadía larga).
- Ejemplos guía: Madrid (Toledo/Segovia), Roma/París, Islandia (Círculo Dorado, etc.).

🚫 ERRORES A EVITAR
- No "seed".
- No precios ni marcas.
- Nada de texto fuera del JSON.
`.trim();

// ==============================
// Heurísticas y regex
// ==============================
const AURORA_CITY_RE = new RegExp(
  [
    "Reykjavik",
    "Reikiavik",
    "Akureyri",
    "Tromsø",
    "Tromso",
    "Abisko",
    "Rovaniemi",
    "Ivalo",
    "Kiruna",
    "Fairbanks",
    "Yellowknife",
    "Svalbard",
    "Ísafjörður",
    "Isafjordur",
  ].join("|"),
  "i"
);

// Actividades típicas fuera de ciudad (listado no exhaustivo y ampliable)
const OUT_OF_TOWN_TERMS = [
  // Islandia
  "Þingvellir",
  "Thingvellir",
  "Geysir",
  "Gullfoss",
  "Kerið",
  "Kerid",
  "Reynisfjara",
  "Vík",
  "Vik",
  "Snæfellsnes",
  "Snaefellsnes",
  "Kirkjufell",
  "Kirkjufellsfoss",
  "Snæfellsjökull",
  "Snaefellsjokull",
  "Arnarstapi",
  "Hellnar",
  "Seljalandsfoss",
  "Skógafoss",
  "Skogafoss",
  "Reykjanes",
  "Kleifarvatn",
  "Krýsuvík",
  "Krysuvik",
  "Seltún",
  "Seltun",
  "Puente entre Continentes",
  "Reykjanesviti",
  "Gunnuhver",
  // Madrid
  "Toledo",
  "Segovia",
  "Ávila",
  "Avila",
  "El Escorial",
  "Aranjuez",
];

const OUT_OF_TOWN_RE = new RegExp(OUT_OF_TOWN_TERMS.join("|"), "i");

// Rutas sin transporte público eficiente → forzar “Vehículo alquilado o Tour guiado”
const NO_PUBLIC_EFFICIENT = [
  // Islandia: la mayoría de rutas naturales fuera de área metropolitana
  "Þingvellir",
  "Thingvellir",
  "Gullfoss",
  "Geysir",
  "Kerið",
  "Kerid",
  "Snæfellsnes",
  "Snaefellsnes",
  "Reynisfjara",
  "Kirkjufell",
  "Kirkjufellsfoss",
  "Snæfellsjökull",
  "Snaefellsjokull",
  "Seljalandsfoss",
  "Skógafoss",
  "Skogafoss",
  "Reykjanes",
  "Kleifarvatn",
  "Krýsuvík",
  "Krysuvik",
  "Seltún",
  "Seltun",
  "Gunnuhver",
];
const NO_PUBLIC_RE = new RegExp(NO_PUBLIC_EFFICIENT.join("|"), "i");

const AURORA_RE = /aurora|northern lights|luces del norte|boreal/i;

// ==============================
// Utilidades de tiempo y orden
// ==============================
function toMinutes(hhmm = "00:00") {
  const [h, m] = String(hhmm).split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return h * 60 + m;
}
function fromMinutes(mins = 0) {
  const m = ((mins % 1440) + 1440) % 1440;
  const h = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${h}:${mm}`;
}
function clampAuroraWindow(start, end) {
  // Ventana preferida 18:00–01:00, duración ≥ 240 min
  const minStart = toMinutes("18:00");
  const maxEnd = toMinutes("01:00") + 1440; // permitir cruce medianoche
  let s = toMinutes(start);
  let e = toMinutes(end);
  if (e <= s) e = s + 240; // mínimo 4h si venía invertido o igual
  // Acomoda en ventana
  if (s < minStart) {
    const delta = minStart - s;
    s += delta;
    e += delta;
  }
  if (e < s + 240) e = s + 240;
  // Si sobrepasa 01:00, recorta a 01:00 como límite "extendido"
  if (e > maxEnd) {
    e = maxEnd;
    if (e < s + 240) s = e - 240;
  }
  return { start: fromMinutes(s % 1440), end: fromMinutes(e % 1440) };
}
function sortKeyMinutes(row) {
  const base = row.day || 1;
  const s = toMinutes(row.start || "09:00");
  return base * 10000 + s;
}

// ==============================
// Normalizadores y post-procesos
// ==============================
function coerceToFormatB(parsed) {
  // Acepta B o C; convierte C → B tomando la primera ciudad con rows
  if (!parsed) return null;
  if (Array.isArray(parsed.destinations)) {
    const first = parsed.destinations.find(
      (d) => d && (Array.isArray(d.rows) ? d.rows.length : 0)
    );
    if (first) {
      return {
        destination: first.name || first.city || "Desconocido",
        rows: first.rows || [],
        followup: parsed.followup || "",
        replace: !!parsed.replace,
      };
    }
    // si no hay rows en destinos, cae a null para reintento
  }
  if (Array.isArray(parsed.rows) || isPlainObject(parsed.rows)) {
    return {
      destination: parsed.destination || parsed.city || "Desconocido",
      rows: parsed.rows || [],
      followup: parsed.followup || "",
      replace: !!parsed.replace,
    };
  }
  return null;
}

function normalizeTransportTrip(row) {
  const t = (row.transport || "").trim();
  const toText = `${row.to || ""} ${row.activity || ""}`;
  const isOut = OUT_OF_TOWN_RE.test(toText);
  const hasPublic =
    /metro|tren|bus|autob[uú]s|ferry|tranv[ií]a/i.test(t) || /p[úu]blico/i.test(t);
  const looksWalk = /a pie|caminar/i.test(t);

  if (isOut) {
    // Si es day-trip y sin público claro o "A pie" → Vehículo alquilado o Tour guiado
    if (!t || looksWalk || NO_PUBLIC_RE.test(toText) || (!hasPublic && !/taxi/i.test(t))) {
      row.transport = "Vehículo alquilado o Tour guiado";
    }
  } else {
    if (!t) {
      // En ciudad, default Taxi; si “from” y “to” son el mismo barrio o vacío, A pie
      const samePlace =
        (row.from || "").toLowerCase().trim() === (row.to || "").toLowerCase().trim();
      row.transport = samePlace ? "A pie" : "Taxi";
    }
  }
}

function ensureReturnToCity(destination, rowsOfDay) {
  const outDuringDay = rowsOfDay.some((r) =>
    OUT_OF_TOWN_RE.test(`${r.to || ""} ${r.activity || ""}`)
  );
  if (!outDuringDay) return;

  const last = rowsOfDay[rowsOfDay.length - 1];
  const lastEnd = toMinutes(last?.end || "18:00");
  const retStart = fromMinutes(lastEnd);
  const retEnd = fromMinutes(lastEnd + 30);

  rowsOfDay.push({
    day: last?.day || 1,
    start: retStart,
    end: retEnd,
    activity: `Regreso a ${destination}`,
    from: last?.to || destination,
    to: destination,
    transport: "Taxi",
    duration: "30m",
    notes: `Vuelta a la ciudad base para cerrar la jornada.`,
  });
}

function ensureEndReturnToHotel(rowsOfDay) {
  const last = rowsOfDay[rowsOfDay.length - 1];
  if (!last) return;
  const lastIsReturnHotel = /Regreso a hotel/i.test(last.activity || "");
  if (lastIsReturnHotel) return;

  const lastEnd = toMinutes(last.end || "20:00");
  const start = fromMinutes(lastEnd);
  const end = fromMinutes(lastEnd + 20);

  rowsOfDay.push({
    day: last.day || 1,
    start,
    end,
    activity: "Regreso a hotel",
    from: last.to || "",
    to: "Hotel",
    transport: AURORA_RE.test(last.activity || "") ? "Tour guiado" : "Taxi",
    duration: "20m",
    notes: "Cierre del día para descansar y prepararse para mañana.",
  });
}

function normalizeAuroraWindow(row) {
  if (!AURORA_RE.test(row.activity || "")) return;
  const s = row.start || "21:00";
  const e = row.end || "23:00";
  const { start, end } = clampAuroraWindow(s, e);
  row.start = start;
  row.end = end;
  const dur = toMinutes(end) - toMinutes(start);
  row.duration = `${Math.max(240, dur)}m`;
  if (!row.transport || /a pie/i.test(row.transport)) {
    row.transport = "Tour guiado";
  }
}

function relaxNextMorningIfAurora(byDay) {
  // Si día D tiene auroras, el D+1 inicia ≥10:30 y cercano/urbano
  const days = Array.from(byDay.keys()).sort((a, b) => a - b);
  for (let i = 0; i < days.length - 1; i++) {
    const d = days[i];
    const next = days[i + 1];
    const rowsD = byDay.get(d) || [];
    const hadAurora = rowsD.some((r) => AURORA_RE.test(r.activity || ""));
    if (!hadAurora) continue;

    const nextRows = (byDay.get(next) || []).slice().sort((a, b) => sortKeyMinutes(a) - sortKeyMinutes(b));
    let minStart = toMinutes("10:30");
    for (const r of nextRows) {
      const s = toMinutes(r.start || "09:00");
      if (s < minStart) {
        const delta = minStart - s;
        const newS = fromMinutes(s + delta);
        const newE = fromMinutes(toMinutes(r.end || "10:30") + delta);
        r.start = newS;
        r.end = newE;
      }
    }
    byDay.set(next, nextRows);
  }
}

function injectAuroraIfMissing(destination, rows) {
  // Inserta 1–2 noches no consecutivas si el destino permite auroras
  if (!AURORA_CITY_RE.test(destination || "")) return rows;
  const byDay = groupByDay(rows);
  const days = Array.from(byDay.keys()).sort((a, b) => a - b);
  if (!days.length) return rows;

  const totalDays = days.length;
  const existingAuroraDays = days.filter((d) =>
    (byDay.get(d) || []).some((r) => AURORA_RE.test(r.activity || ""))
  );

  const cap = totalDays <= 2 ? 0 : totalDays <= 4 ? 1 : 2;
  const need = Math.max(0, cap - existingAuroraDays.length);
  if (need <= 0) return rows;

  // Evitar única en último día y evitar consecutivas
  const candidateDays = days.filter((d) => d !== days[days.length - 1]);
  const toAdd = [];
  for (const d of candidateDays) {
    if (toAdd.length >= need) break;
    if (existingAuroraDays.includes(d)) continue;
    if (existingAuroraDays.some((ad) => Math.abs(ad - d) === 1)) continue;
    if (toAdd.some((ad) => Math.abs(ad - d) === 1)) continue;
    toAdd.push(d);
  }

  for (const d of toAdd) {
    const rowsD = (byDay.get(d) || []).slice().sort((a, b) => sortKeyMinutes(a) - sortKeyMinutes(b));
    const start = "20:30";
    const end = "00:30";
    rowsD.push({
      day: d,
      start,
      end,
      activity: "Caza de auroras boreales",
      from: destination,
      to: "Miradores oscuros",
      transport: "Tour guiado",
      duration: "4h",
      notes:
        "Explora cielos despejados y aumenta tus probabilidades de ver el baile verde en el firmamento.",
    });
    byDay.set(d, rowsD);
  }

  return flattenByDay(byDay);
}

function enforceAuroraCapGlobal(rows) {
  const byDay = groupByDay(rows);
  const days = Array.from(byDay.keys()).sort((a, b) => a - b);
  const totalDays = days.length;
  const cap = totalDays <= 2 ? 0 : totalDays <= 4 ? 1 : 2;

  // Recolecta días con aurora
  let auroraDays = days.filter((d) =>
    (byDay.get(d) || []).some((r) => AURORA_RE.test(r.activity || ""))
  );

  // Quita consecutivas
  auroraDays = auroraDays.filter(
    (d, i, arr) => !(i > 0 && Math.abs(d - arr[i - 1]) === 1)
  );

  // Evita “solo el último día”
  if (auroraDays.length === 1 && auroraDays[0] === days[days.length - 1]) {
    // moverla al penúltimo si existe
    const newD = days.length >= 2 ? days[days.length - 2] : auroraDays[0];
    moveAuroraDay(byDay, auroraDays[0], newD);
    auroraDays = [newD];
  }

  // Aplica tope
  while (auroraDays.length > cap) {
    const d = auroraDays.pop();
    const rowsD = (byDay.get(d) || []).filter((r) => !AURORA_RE.test(r.activity || ""));
    byDay.set(d, rowsD);
  }

  return flattenByDay(byDay);
}

function moveAuroraDay(byDay, fromD, toD) {
  const fromRows = byDay.get(fromD) || [];
  const kept = [];
  const moved = [];
  for (const r of fromRows) {
    if (AURORA_RE.test(r.activity || "")) {
      moved.push({ ...r, day: toD });
    } else {
      kept.push(r);
    }
  }
  byDay.set(fromD, kept);
  byDay.set(toD, [...(byDay.get(toD) || []), ...moved]);
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
function flattenByDay(byDay) {
  const days = Array.from(byDay.keys()).sort((a, b) => a - b);
  const out = [];
  for (const d of days) {
    const arr = (byDay.get(d) || []).slice().sort((a, b) => sortKeyMinutes(a) - sortKeyMinutes(b));
    out.push(...arr);
  }
  return out;
}

function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = [
      r.day,
      (r.activity || "").toLowerCase(),
      (r.to || "").toLowerCase(),
      r.start,
      r.end,
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function normalizeParsed(parsed0) {
  if (!parsed0) return null;

  // C → B
  const parsed = coerceToFormatB(parsed0);
  if (!parsed) return null;

  const destination = parsed.destination || "Desconocido";
  const inputRows = Array.isArray(parsed.rows) ? parsed.rows.slice(0, 999) : [];

  // 1) Normalización por fila
  const rows = inputRows.map((row, i) => {
    const r = { ...row };
    // day
    if (!Number.isInteger(r.day) || r.day < 1) r.day = 1 + (i % 7);

    // start/end defaults
    if (!r.start) r.start = "09:00";
    if (!r.end || toMinutes(r.end) <= toMinutes(r.start)) {
      if (AURORA_RE.test(r.activity || "")) {
        const w = clampAuroraWindow(r.start, fromMinutes(toMinutes(r.start) + 240));
        r.start = w.start;
        r.end = w.end;
        r.duration = "4h";
      } else {
        r.end = fromMinutes(toMinutes(r.start) + 90);
        r.duration = r.duration || "90m";
      }
    }

    // Transporte
    normalizeTransportTrip(r);

    // Auroras: ajustar ventana y transporte
    normalizeAuroraWindow(r);

    // Campos mínimos
    r.activity = r.activity || "Actividad";
    r.from = r.from || "";
    r.to = r.to || destination;

    return r;
  });

  // 2) Agrupar por día y ordenar
  const byDay = groupByDay(rows);
  for (const d of Array.from(byDay.keys())) {
    const arr = (byDay.get(d) || []).slice().sort((a, b) => sortKeyMinutes(a) - sortKeyMinutes(b));
    byDay.set(d, arr);
  }

  // 3) Retornos (si hubo salida fuera) + regreso a hotel
  for (const d of Array.from(byDay.keys())) {
    const arr = byDay.get(d) || [];
    ensureReturnToCity(destination, arr);
    ensureEndReturnToHotel(arr);
    byDay.set(d, arr);
  }

  // 4) Reordenar y podar retornos iniciales espurios
  for (const d of Array.from(byDay.keys())) {
    let arr = (byDay.get(d) || []).slice().sort((a, b) => sortKeyMinutes(a) - sortKeyMinutes(b));
    // Quita "Regreso a ..." que accidentalmente haya quedado al inicio
    while (arr.length && /Regreso a/i.test(arr[0].activity || "")) {
      arr.shift();
    }
    if (arr.length === 0) {
      // guarda anti-vaciado por día: si quedó vacío, siembra una pieza urbana
      arr.push({
        day: d,
        start: "09:00",
        end: "10:30",
        activity: "Paseo urbano",
        from: "",
        to: destination,
        transport: "A pie",
        duration: "90m",
        notes: "Una parada ideal para conectar con la esencia del destino.",
      });
    }
    byDay.set(d, arr);
  }

  // 5) Relajar mañana tras auroras
  relaxNextMorningIfAurora(byDay);

  // 6) Reconstrucción y dedupe
  let flat = flattenByDay(byDay);
  flat = dedupeRows(flat);

  // 7) Inyección/cap de auroras
  flat = injectAuroraIfMissing(destination, flat);
  flat = enforceAuroraCapGlobal(flat);

  // 8) Orden final + tope 20 actividades por día
  const byDay2 = groupByDay(flat);
  const finalDays = Array.from(byDay2.keys()).sort((a, b) => a - b);
  const finalRows = [];
  for (const d of finalDays) {
    const dayRows = (byDay2.get(d) || [])
      .slice()
      .sort((a, b) => sortKeyMinutes(a) - sortKeyMinutes(b))
      .slice(0, 20);
    finalRows.push(...dayRows);
  }

  // Guardas globales anti-vaciado
  if (finalRows.length === 0) {
    return fallbackJSON(destination);
  }

  return {
    destination,
    rows: finalRows,
    followup: parsed.followup || "",
    replace: !!parsed.replace,
  };
}

// ==============================
// Llamadas al modelo
// ==============================
async function callResponses(messages, { temperature = 0.4, forceJSON = false } = {}) {
  // Construye input como transcripción corta role:content
  const inputStr = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");

  const payload = {
    model: "gpt-4o-mini",
    temperature,
    max_output_tokens: 2200,
    input: inputStr,
  };

  if (forceJSON) {
    payload.response_format = { type: "json_object" };
  }

  const resp = await client.responses.create(payload);

  // Preferir output_text si existe; si viene content estructurado, intentar extraer
  const text =
    resp?.output_text?.trim() ||
    resp?.output?.[0]?.content?.[0]?.text?.trim() ||
    null;

  // Si forceJSON, a veces viene como objeto ya parseado en resp.output[0].content[0].json
  const asJSON =
    resp?.output?.[0]?.content?.find?.((c) => c?.type === "output_text")?.json ??
    resp?.output?.[0]?.content?.find?.((c) => c?.type === "json")?.json ??
    null;

  return asJSON ?? text;
}

// ==============================
// Handler ESM
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body || {};
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    // ── MODO INFO (texto libre) ────────────────────────────────────────────────
    if (mode === "info") {
      const raw = await callResponses(clientMessages, { temperature: 0.6, forceJSON: false });
      const text =
        (typeof raw === "string" && raw) ||
        "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // ── MODO PLANNER (JSON estructurado) ─────────────────────────────────────
    // Intento 1: prompt base + JSON forzado
    let raw = await callResponses(
      [{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages],
      { temperature: 0.4, forceJSON: true }
    );
    let parsed = cleanToJSON(raw);
    let normalized = normalizeParsed(parsed);

    // Guardas anti-vaciado
    let snapshot = normalized && normalized.rows && normalized.rows.length ? { ...normalized } : null;

    // Si no hay rows → Intento 2 (refuerzo)
    const hasRows = normalized && Array.isArray(normalized.rows) && normalized.rows.length > 0;
    if (!hasRows) {
      const strictPrompt =
        SYSTEM_PROMPT +
        `\n\nOBLIGATORIO: Devuelve al menos 1 fila en "rows". Solo JSON, sin meta.`;
      raw = await callResponses(
        [{ role: "system", content: strictPrompt }, ...clientMessages],
        { temperature: 0.25, forceJSON: true }
      );
      parsed = cleanToJSON(raw);
      normalized = normalizeParsed(parsed);
      if (!snapshot && normalized && normalized.rows && normalized.rows.length) {
        snapshot = { ...normalized };
      }
    }

    // Si aún no hay filas → Intento 3 (plantilla mínima)
    const stillNoRows = !normalized || !Array.isArray(normalized.rows) || !normalized.rows.length;
    if (stillNoRows) {
      const ultraPrompt =
        SYSTEM_PROMPT +
        `
Ejemplo válido mínimo:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
      raw = await callResponses(
        [{ role: "system", content: ultraPrompt }, ...clientMessages],
        { temperature: 0.1, forceJSON: true }
      );
      parsed = cleanToJSON(raw);
      normalized = normalizeParsed(parsed);
      if (!snapshot && normalized && normalized.rows && normalized.rows.length) {
        snapshot = { ...normalized };
      }
    }

    // Guardas finales: si post-procesos dejan 0 filas, restaura snapshot o siembra seed urbano
    let finalOut = normalized;
    if (!finalOut || !Array.isArray(finalOut.rows) || !finalOut.rows.length) {
      finalOut = snapshot || fallbackJSON(parsed?.destination || "Desconocido");
    }

    // Log útil en Vercel
    try {
      console.log("🛰️ RAW RESPONSE (planner):", typeof raw === "string" ? raw.slice(0, 2000) : raw);
      if (finalOut?.followup) console.log("ℹ️ FOLLOWUP:", finalOut.followup);
    } catch {}

    return res.status(200).json({ text: JSON.stringify(finalOut) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
