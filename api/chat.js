// =====================================================
// /api/chat.js — v36.8 (ESM compatible en Vercel)
// Correcciones: anti-fallback robusto, auroras 18:00–01:00,
// regreso a hotel al final de TODOS los días,
// transporte dual agresivo para day trips,
// poda de "regresos" al inicio del día, deduplicación fuerte,
// refuerzo de subparadas y formato "Ruta — Subparada".
// =====================================================

/* ────────────────────────────────────────────────────
   SECCIÓN 1 · Import y cliente OpenAI
────────────────────────────────────────────────────── */
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ────────────────────────────────────────────────────
   SECCIÓN 2 · Helpers de parsing y fallback
────────────────────────────────────────────────────── */
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
  const txt = String(s || "");
  const start = txt.indexOf("{");
  const end = txt.lastIndexOf("}");
  if (start >= 0 && end > start) return txt.slice(start, end + 1);
  return null;
}

function tryRepairJsonMinor(raw = "") {
  // Reparaciones mínimas seguras
  let t = String(raw || "");
  t = stripCodeFences(t);
  // Comas antes de ] o } (trailing commas)
  t = t.replace(/,\s*([\]}])/g, "$1");
  // Comillas simples a dobles en pares obvios (muy conservador)
  t = t.replace(/"rows":\s*\[\s*'([^"]+)'/g, (_, g1) => `"rows":["${g1.replace(/"/g, '\\"')}"]`);
  return t;
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
    try {
      const repaired = tryRepairJsonMinor(c);
      const j2 = JSON.parse(repaired);
      if (j2 && typeof j2 === "object") return j2;
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
    replace: false,
    followup: "⚠️ Fallback local: revisa configuración de Vercel o API Key.",
  };
}

/* ────────────────────────────────────────────────────
   SECCIÓN 3 · Constantes, utilidades de tiempo y regex
────────────────────────────────────────────────────── */
const OUT_OF_TOWN_RE =
  /\b(thingvellir|þingvellir|gullfoss|geysir|golden\s*circle|círculo\s*dorado|seljalandsfoss|skógafoss|skogafoss|reynisfjara|v[ií]k|sn[aá]efellsnes|snaefellsnes|kirkjufell|kirkjufellsfoss|djúpalónssandur|dritv[ií]k|arnarstapi|hellnar|b[uú]ð(i|ir)|puente\s+entre\s+continentes|bridge\s+between\s+continents|sn[aá]efellsj[oö]kull|blue\s*lagoon|laguna\s*azul|reykjanes|kr[ýy]suv[ií]k|selt[uú]n|kleifarvatn|reykjanesviti|fagradalsfjall|costa\s*sur|pen[ií]nsula|fiordo|glaciar|volc[aá]n|cueva\s+de\s+hielo|ice\s*cave|whale\s*watching|toledo|segovia)\b/i;

const AURORA_RE = /\b(auroras?|northern\s*lights?)\b/i;

const AURORA_CITY_RE =
  /(reykjav[ií]k|reikiavik|reykiavik|akureyri|troms[oø]|tromso|alta|bod[oø]|narvik|lofoten|abisko|kiruna|rovaniemi|yellowknife|fairbanks|murmansk|iceland|islandia|lapland|laponia)/i;

// Lista conservadora de rutas SIN transporte público eficiente habitual
const NO_PUBLIC_EFFICIENT = [
  "círculo dorado", "golden circle",
  "snæfellsnes", "snaefellsnes",
  "costa sur", "reynisfjara", "vík", "vik",
  "reykjanes", "kirkjufell", "kirkjufellsfoss",
  "kleifarvatn", "krýsuvík", "seltún", "reykjanesviti", "fagradalsfjall"
];

function pad(n) { return n.toString().padStart(2, "0"); }
function toMinutes(hhmm = "00:00") {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
function toHHMM(mins = 0) {
  const mm = ((mins % (24 * 60)) + (24 * 60)) % (24 * 60);
  const h = Math.floor(mm / 60);
  const m = mm % 60;
  return `${pad(h)}:${pad(m)}`;
}

/* ────────────────────────────────────────────────────
   SECCIÓN 4 · Post-procesos (orden, auroras, retornos, dedupe)
────────────────────────────────────────────────────── */
function sortKeyMinutes(row) {
  const s = toMinutes(row.start || "00:00");
  const e = toMinutes(row.end || row.start || "00:00");
  let key = s;

  if (AURORA_RE.test(row.activity || "") && e <= s) key = s + 1440;
  if (/regreso\s+a\s+hotel/i.test(row.activity || "") && s < 240) key = s + 1440;

  return key;
}

// Ventana de auroras: **entre 18:00 y 01:00** (mínimo 2h, preferible 3–4h)
function normalizeAuroraWindow(row) {
  if (!AURORA_RE.test(row.activity || "")) return row;
  const MIN = toMinutes("18:00");
  const MAX = toMinutes("01:00") + 24 * 60; // permitir 00:xx–01:00 cruzando medianoche

  let s = toMinutes(row.start || "20:30");
  let e = toMinutes(row.end || "23:30");
  if (s < MIN) s = MIN;
  if (e <= s) e = s + 180; // 3h por defecto
  const sAdj = s;
  let eAdj = e;
  if (eAdj - sAdj < 120) eAdj = sAdj + 120;
  if (eAdj > MAX) eAdj = MAX;

  const dur = Math.max(120, eAdj - sAdj);
  const durTxt = dur >= 60 ? `${Math.floor(dur/60)}h${dur%60 ? " "+(dur%60)+"m" : ""}` : `${dur}m`;

  return {
    ...row,
    start: toHHMM(sAdj),
    end: toHHMM(eAdj),
    transport: row.transport || "Vehículo alquilado o Tour guiado",
    duration: row.duration || durTxt,
  };
}

// Heurística transporte: forcemos “Vehículo alquilado o Tour guiado” en day trips
function normalizeTransportTrip(activity = "", to = "", transport = "") {
  const txt = `${activity} ${to}`.toLowerCase();
  const isTrip = OUT_OF_TOWN_RE.test(txt);
  if (!isTrip) return transport || "Taxi";

  const t = (transport || "").toLowerCase();
  const alreadyOK = /tour|alquilad|veh[ií]culo|auto|carro|coche/.test(t);
  if (alreadyOK) return transport;

  const usedPublic = /(metro|bus|autob|tren|p[uú]blico)/.test(t);
  const mentionsNoPublic = NO_PUBLIC_EFFICIENT.some(w => txt.includes(w));
  if (!t || usedPublic || mentionsNoPublic) {
    return "Vehículo alquilado o Tour guiado";
  }
  return transport || "Vehículo alquilado o Tour guiado";
}

// Si hubo salida fuera de ciudad, aseguramos “Regreso a <Ciudad>”
function ensureReturnToCity(destination, rowsOfDay) {
  if (!Array.isArray(rowsOfDay) || !rowsOfDay.length) return rowsOfDay;
  const anyTrip = rowsOfDay.some(r => OUT_OF_TOWN_RE.test(`${r.activity||""} ${r.to||""}`));
  if (!anyTrip) return rowsOfDay;

  const last = rowsOfDay[rowsOfDay.length - 1] || {};
  const alreadyBack =
    /regreso\s+a/i.test(last.activity || "") ||
    new RegExp(destination, "i").test(last.to || "");
  if (alreadyBack) return rowsOfDay;

  const endM = toMinutes(last.end || "18:00");
  const back = {
    day: last.day,
    start: toHHMM(endM + 20),
    end: toHHMM(endM + 90),
    activity: `Regreso a ${destination}`,
    from: last.to || last.activity || destination,
    to: destination,
    transport: "Vehículo alquilado o Tour guiado",
    duration: "1h 10m",
    notes: "Retorno a la ciudad base para cerrar el día.",
  };
  return [...rowsOfDay, back];
}

// Siempre terminar con “Regreso a hotel”
function ensureEndReturnToHotel(rowsOfDay) {
  if (!Array.isArray(rowsOfDay) || !rowsOfDay.length) return rowsOfDay;
  const last = rowsOfDay[rowsOfDay.length - 1];
  if (/regreso\s+a\s+(hotel|alojamiento)/i.test(last.activity || "")) return rowsOfDay;

  const endM = toMinutes(last.end || "19:00");
  let transport = "Taxi";
  if (AURORA_RE.test(last.activity || "")) transport = "Tour guiado";

  const back = {
    day: last.day,
    start: toHHMM(endM + 5),
    end: toHHMM(endM + 45),
    activity: "Regreso a hotel",
    from: last.to || last.activity || "Ciudad",
    to: "Hotel",
    transport,
    duration: "0.75h",
    notes: "Cierre del día con retorno cómodo al alojamiento.",
  };
  return [...rowsOfDay, back];
}

// Podar “regresos” inválidos al inicio del día
function pruneLeadingReturns(rowsOfDay) {
  if (!Array.isArray(rowsOfDay) || !rowsOfDay.length) return rowsOfDay;
  return rowsOfDay.filter((r, idx) => {
    if (idx > 0) return true;
    const a = (r.activity || "").toLowerCase();
    if (/^regreso a (hotel|ciudad)/.test(a)) return false;
    return true;
  });
}

// Deduplicación fuerte por día + (actividad, to) y por ventana idéntica
function dedupeRows(rows = []) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = `${r.day}|${(r.activity||"").toLowerCase()}|${(r.to||"").toLowerCase()}|${r.start}-${r.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// ¿ciudad apta para auroras?
function isAuroraEligibleCity(name = "") { return AURORA_CITY_RE.test(String(name || "")); }

/** Inyecta auroras hasta alcanzar el mínimo requerido:
 *  - Estancia ≥3 días: objetivo = 2 noches
 *  - Evita última noche y noches consecutivas
 *  - Mantiene cualquier noche ya existente
 */
function injectAurorasToReachMinimum(dest, rows) {
  if (!isAuroraEligibleCity(dest)) return rows;

  const byDay = rows.reduce((acc, r) => ((acc[r.day] = acc[r.day] || []).push(r), acc), {});
  const days = Object.keys(byDay).map(Number).sort((a,b)=>a-b);
  if (!days.length) return rows;

  const stay = days.length;
  const target = stay >= 3 ? 2 : 1;

  const existing = days.filter(d => (byDay[d]||[]).some(r => AURORA_RE.test(r.activity||"")));
  if (existing.length >= target) return rows;

  const forbidden = new Set([days[days.length-1], ...existing, ...existing.map(d=>d-1), ...existing.map(d=>d+1)]);
  const choices = [];
  for (const d of days) {
    if (forbidden.has(d)) continue;
    if (choices.length && Math.abs(d - choices[choices.length-1]) <= 1) continue;
    choices.push(d);
    if (existing.length + choices.length >= target) break;
  }
  if (!choices.length) return rows;

  const mk = (day) => normalizeAuroraWindow({
    day,
    start: "20:30",
    end: "23:30",
    activity: "Caza de Auroras Boreales",
    from: dest,
    to: "Zona de observación",
    transport: "Vehículo alquilado o Tour guiado",
    duration: "3h",
    notes: "Salida nocturna (si las condiciones lo permiten).",
  });

  const out = rows.slice();
  choices.forEach(d => out.push(mk(d)));
  out.sort((a,b)=>(a.day-b.day)||(sortKeyMinutes(a)-sortKeyMinutes(b)));
  return out;
}

function relaxNextMorningIfAurora(byDay) {
  const days = Object.keys(byDay).map(Number).sort((a,b)=>a-b);
  const auroraDays = new Set(days.filter(d => (byDay[d]||[]).some(r => AURORA_RE.test(r.activity||""))));
  const MIN_START = toMinutes("10:30");
  for (const d of days) {
    if (!auroraDays.has(d - 1)) continue;
    const rows = byDay[d]; if (!rows?.length) continue;
    const first = Math.min(...rows.map(r => toMinutes(r.start || "23:59")));
    if (first >= MIN_START) continue;
    const shift = MIN_START - first;
    for (const r of rows) {
      const s = toMinutes(r.start || "00:00") + shift;
      const e = toMinutes(r.end || r.start || "00:00") + shift;
      r.start = toHHMM(s); r.end = toHHMM(e);
    }
  }
}

// Máximo global de auroras (no consecutivas; nunca dejar solo la última noche)
function enforceAuroraCapGlobal(rows) {
  const byDay = rows.reduce((acc, r) => ((acc[r.day] = acc[r.day] || []).push(r), acc), {});
  const days = Object.keys(byDay).map(Number).sort((a,b)=>a-b);
  const stay = days.length;
  const cap = stay >= 3 ? 2 : 1; // ← permite hasta 2 noches desde 3 días de estancia

  let auroraDays = days.filter(d => (byDay[d]||[]).some(r => AURORA_RE.test(r.activity||"")));
  auroraDays.sort((a,b)=>a-b);

  // evitar consecutivas
  for (let i=1; i<auroraDays.length; i++){
    if (auroraDays[i] === auroraDays[i-1] + 1) {
      byDay[auroraDays[i]] = (byDay[auroraDays[i]]||[]).filter(r=>!AURORA_RE.test(r.activity||""));
    }
  }

  // recalcular
  auroraDays = days.filter(d => (byDay[d]||[]).some(r => AURORA_RE.test(r.activity||"")));

  // evitar que la ÚNICA sea el último día
  if (auroraDays.length === 1 && auroraDays[0] === days[days.length-1]) {
    const last = days[days.length-1];
    byDay[last] = (byDay[last]||[]).filter(r=>!AURORA_RE.test(r.activity||""));
  }

  // aplicar tope (máx 2)
  auroraDays = days.filter(d => (byDay[d]||[]).some(r => AURORA_RE.test(r.activity||"")));
  if (auroraDays.length > cap) {
    const keep = auroraDays.slice(0, cap);
    for (const d of auroraDays) {
      if (!keep.includes(d)) byDay[d] = (byDay[d]||[]).filter(r=>!AURORA_RE.test(r.activity||""));
    }
  }

  const merged = [];
  days.forEach(d => (byDay[d]||[]).forEach(r=>merged.push(r)));
  return merged;
}

/* ────────────────────────────────────────────────────
   SECCIÓN 5 · Normalización integral de la respuesta
────────────────────────────────────────────────────── */
function normalizeParsed(parsed) {
  if (!parsed || typeof parsed !== "object") return null;

  // Acepta formato C → convertir a B
  if (!parsed.rows && Array.isArray(parsed.destinations)) {
    const first = parsed.destinations.find(d => Array.isArray(d.rows) && d.rows.length);
    if (first) {
      parsed = {
        destination: first.name || first.city || first.destination || "Destino",
        rows: first.rows,
        followup: parsed.followup || "",
        replace: parsed.replace ?? false,
      };
    }
  }
  if (!Array.isArray(parsed.rows)) return null;
  if (typeof parsed.replace === "undefined") parsed.replace = false;

  let rows = parsed.rows
    .map((r, idx) => {
      const dayNum = Number.isFinite(+r.day) && +r.day > 0 ? +r.day : 1 + (idx % 7);
      const start = (r.start || "").toString().trim() || "09:00";
      const endRaw = (r.end || "").toString().trim() || "";
      const activity = (r.activity || "").toString().trim() || "Actividad";

      // Transporte
      let transport = ((r.transport || "").toString().trim());
      transport = normalizeTransportTrip(activity, (r.to || "").toString(), transport);

      const base = {
        day: dayNum,
        start,
        end: endRaw || "",
        activity,
        from: (r.from || "").toString(),
        to: (r.to || "").toString(),
        transport,
        duration: (r.duration || "").toString(),
        notes: (r.notes || "").toString() || "Una parada ideal para disfrutar.",
      };

      // End vacío o anterior a start → duración razonable (90m; auroras 3–4h se ajustan luego)
      const s = toMinutes(base.start);
      const e = endRaw ? toMinutes(endRaw) : null;
      if (e === null || e <= s) {
        const dur = AURORA_RE.test(activity) ? 180 : 90;
        base.end = toHHMM(s + dur);
        if (!base.duration) {
          base.duration = dur >= 60 ? `${Math.floor(dur/60)}h${dur%60? " "+(dur%60)+"m":""}` : `${dur}m`;
        }
      }
      return base;
    })
    .slice(0, 180);

  // Auroras a ventana 18:00–01:00
  rows = rows.map(normalizeAuroraWindow);

  const dest = parsed.destination || "Ciudad";

  // Agrupar para ordenar e inyectar retornos
  const byDay = rows.reduce((acc, r) => ((acc[r.day] = acc[r.day] || []).push(r), acc), {});
  const orderedMerged = [];
  Object.keys(byDay).map(Number).sort((a,b)=>a-b).forEach(d => {
    byDay[d].sort((a,b)=>sortKeyMinutes(a)-sortKeyMinutes(b));
    let fixed = byDay[d];

    // Regreso a ciudad si hubo salida, luego siempre Regreso a hotel
    fixed = ensureReturnToCity(dest, fixed);
    fixed = ensureEndReturnToHotel(fixed);

    // Reordenar y podar "regresos" al inicio
    fixed.sort((a,b)=>sortKeyMinutes(a)-sortKeyMinutes(b));
    fixed = pruneLeadingReturns(fixed);

    byDay[d] = fixed;
    orderedMerged.push(...fixed);
  });

  // Relajar mañana tras auroras
  const byDay2 = orderedMerged.reduce((acc, r) => ((acc[r.day] = acc[r.day] || []).push(r), acc), {});
  relaxNextMorningIfAurora(byDay2);

  // Reconstrucción
  let afterRelax = [];
  Object.keys(byDay2).map(Number).sort((a,b)=>a-b).forEach(d => {
    byDay2[d].sort((a,b)=>sortKeyMinutes(a)-sortKeyMinutes(b));
    byDay2[d] = pruneLeadingReturns(byDay2[d]);
    afterRelax.push(...byDay2[d]);
  });

   // Inyección de auroras hasta alcanzar el mínimo (y tope global)
  let withAuroras = injectAurorasToReachMinimum(dest, afterRelax);
  withAuroras = enforceAuroraCapGlobal(withAuroras);

  // Deduplicación final
  withAuroras = dedupeRows(withAuroras);

  withAuroras.sort((a,b)=>(a.day-b.day)||(sortKeyMinutes(a)-sortKeyMinutes(b)));

  parsed.rows = withAuroras;
  if (typeof parsed.followup !== "string") parsed.followup = "";
  return parsed;
}

/* ────────────────────────────────────────────────────
   SECCIÓN 6 · Prompt del agente (reglas reforzadas, globales)
────────────────────────────────────────────────────── */
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido** con un itinerario inspirador y funcional.

📌 FORMATOS VÁLIDOS
B) {"destination":"City","rows":[{...}],"followup":"texto breve","replace":false}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES (GLOBALES)
- Devuelve SIEMPRE al menos 1 actividad en "rows".
- Nada de texto fuera del JSON.
- Máximo 20 actividades por día.
- Horarios **realistas**; permite cruce de medianoche si aporta valor.
- Cenas **opcionales**.
- No devuelvas "seed" ni dejes campos vacíos.

🧭 ESTRUCTURA DE CADA ACTIVIDAD
{
  "day": 1,
  "start": "08:30",
  "end": "10:30",
  "activity": "Nombre claro y específico (usa 'Ruta — Subparada' en day-trips)",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "A pie, Metro, Taxi, Bus, Auto, Ferry, Tour guiado",
  "duration": "2h",
  "notes": "Descripción motivadora y breve"
}

🌟 TOURS ICÓNICOS (obligatorio formato “Ruta — Subparada”)
- Círculo Dorado: "Círculo Dorado — Þingvellir", "— Geysir", "— Gullfoss" (+ "— Cráter Kerið" opcional).
- Reykjanes: "Reykjanes — Kleifarvatn", "— Krýsuvík/Seltún", "— Puente entre Continentes", "— Reykjanesviti", "— Gunnuhver", "— Fagradalsfjall (mirador)" (+ "— Laguna Azul" opcional).
- Snæfellsnes: "Snæfellsnes — Kirkjufell", "— Kirkjufellsfoss", "— Parque Nacional Snæfellsjökull", "— Arnarstapi/Hellnar".
- Costa Sur: "Costa Sur — Seljalandsfoss", "— Skógafoss", "— Reynisfjara", "— Vík".
- Incluye **≥3 subparadas** cuando aplique.

🏛️ REGLA GLOBAL: PRIORIDAD CIUDAD vs. DAY-TRIPS (con ANÁLISIS)
- Siempre realiza un **análisis breve** (reflejado en "followup") para decidir si conviene seguir en la ciudad o proponer un day-trip.
- Criterios:
  1) **Cobertura de imperdibles de la ciudad** (al menos los top-5) antes de asignar day-trips.
  2) **Duración de la estadía**: 
     - 1–2 días: 0 day-trips (salvo caso extraordinario).
     - 3–4 días: máx. **1** day-trip.
     - ≥5 días: **1–2** day-trips según valor y clima.
  3) **Valor diferencial** del day-trip (paisajes icónicos, patrimonio único).
  4) **Tiempos de traslado**: usualmente ≤2h30 por trayecto (≤3h sólo si la estadía es larga).
- Ejemplos guía (globales, no limitantes):
  - **Madrid**: Prioriza Prado, Palacio Real, Plaza Mayor, Retiro, Gran Vía, Templo de Debod; luego **Toledo o Segovia** si hay días extra.
  - **Roma**: Coliseo/Foro/Palatino, Vaticano/San Pedro, Fontana di Trevi, Pantheon, Piazza Navona; luego **Tívoli u Ostia Antica** si sobra tiempo.
  - **París**: Louvre, Torre Eiffel, Île de la Cité/Notre-Dame, Montmartre, Orsay; luego **Versalles** si hay margen.
- El **análisis** y la decisión se explican de forma concisa en "followup" (sin texto fuera del JSON).

🌌 AURORAS (regla específica, NO global)
- Solo si latitud ≥ ~55°N y temporada (fin ago–mediados abr).
- Duración 2–4h **entre 18:00 y 01:00**.
- Evita noches consecutivas y que la única sea el último día.
- Si un día tiene auroras, **finaliza la parte diurna ≤18:00**.
- El día siguiente inicia **≥10:30** y con plan **urbano/cercano**.

🚆 TRANSPORTE Y TIEMPOS (global)
- Orden sin solapes y buffers razonables.
- Si el usuario no especifica transporte y el day-trip no tiene transporte público **claramente eficiente**, usa **"Vehículo alquilado o Tour guiado"**.
- Incluye tiempos aproximados de actividad y traslados.

🔁 CIERRE DEL DÍA (global)
- Si hubo salida fuera de la ciudad, agrega **"Regreso a <Ciudad base>"** antes de finalizar.
- **Siempre** termina con **"Regreso a hotel"**.
`.trim();

/* ────────────────────────────────────────────────────
   SECCIÓN 7 · Llamada al modelo (triple intento)
────────────────────────────────────────────────────── */
async function callStructured(messages, temperature = 0.4) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    input: messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
    max_output_tokens: 2400,
  });

  const text =
    resp?.output_text?.trim() ||
    resp?.output?.[0]?.content?.[0]?.text?.trim() ||
    "";

  console.log("🛰️ RAW RESPONSE:", text);
  return text;
}

/* ────────────────────────────────────────────────────
   SECCIÓN 8 · Handler ESM (export default)
────────────────────────────────────────────────────── */
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

    // Intento 1
    let raw = await callStructured(
      [{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages],
      0.4
    );
    let parsed = normalizeParsed(cleanToJSON(raw));

    // Intento 2: forzar al menos 1 fila
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

    // Intento 3: plantilla mínima
    const stillNoRows = !parsed || !Array.isArray(parsed.rows) || parsed.rows.length === 0;
    if (stillNoRows) {
      const ultraPrompt =
        SYSTEM_PROMPT +
        `
Ejemplo VÁLIDO de formato mínimo:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"Taxi","duration":"60m","notes":"Explora un rincón único de la ciudad"}],"replace":false}`;
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
