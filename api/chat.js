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
  /\b(thingvellir|þingvellir|gullfoss|geysir|golden\s*circle|círculo\s*dorado|seljalandsfoss|skógafoss|skogafoss|reynisfjara|v[ií]k|sn[aá]efellsnes|snaefellsnes|kirkjufell|kirkjufellsfoss|djúpalónssandur|valahn[uú]kam[oö]l|gunnuhver|puente\s+entre\s+continentes|bridge\s+between\s+continents|sn[aá]efellsj[oö]kull|blue\s*lagoon|laguna\s*azul|reykjanes|kleifarvatn|kr[yý]s[uú]v[ií]k|selt[uú]n|reykjanesviti|fagradalsfjall|costa\s*sur|pen[ií]nsula|fiordo|glaciar|volc[aá]n|cueva\s+de\s+hielo|ice\s*cave|whale\s*watching|faxafl[oó]i|toledo|segovia|[áa]vila|el\s+escorial|aranjuez)\b/i;

const AURORA_RE = /\b(auroras?|northern\s*lights?)\b/i;

const AURORA_CITY_RE =
  /(reykjav[ií]k|reikiavik|reykiavik|akureyri|troms[oø]|tromso|alta|bod[oø]|narvik|lofoten|abisko|kiruna|rovaniemi|yellowknife|fairbanks|murmansk|iceland|islandia|lapland|laponia)/i;

// Lista conservadora de rutas SIN transporte público eficiente habitual
const NO_PUBLIC_EFFICIENT = [
  // Islandia
  "círculo dorado", "golden circle",
  "snæfellsnes", "snaefellsnes",
  "costa sur", "reynisfjara", "vík", "vik",
  "reykjanes", "kirkjufell", "kirkjufellsfoss",
  "kleifarvatn", "krýsuvík", "seltún", "reykjanesviti", "gunnuhver", "valahnúkamöl", "fagradalsfjall",
  // Madrid y alrededores (day trips típicos)
  "toledo", "segovia", "ávila", "avila", "el escorial", "aranjuez"
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

// Escapa texto para uso seguro en RegExp (evita Invalid regular expression)
function escapeRegExp(str = "") {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Clave de orden por minuto que tolera actividades nocturnas/cruce de medianoche
function sortKeyMinutes(row) {
  const s = toMinutes(row.start || "00:00");
  const e = toMinutes(row.end || row.start || "00:00");
  let key = s;

  // Si end < start y es claramente nocturna (ej. auroras), empujar al final (+24h)
  if (AURORA_RE.test(row.activity || "") && e <= s) key = s + 1440;

  // "Regreso a hotel" de madrugada: después
  if (/regreso\s+a\s+hotel/i.test(row.activity || "") && s < 240) key = s + 1440;

  return key;
}

// Ventana de auroras: **entre 18:00 y 01:00**; **duración mínima 4h**.
// Si la ventana no alcanza, movemos el inicio hacia atrás para garantizar ≥4h.
function normalizeAuroraWindow(row) {
  if (!AURORA_RE.test(row.activity || "")) return row;

  const MIN = toMinutes("18:00");
  // Usamos 01:00 “del día siguiente”: sumamos 24h para poder cruzar medianoche
  const MAX = toMinutes("01:00") + 24 * 60;

  // Defaults razonables si faltan
  let s = toMinutes(row.start || "20:30");
  let e = toMinutes(row.end || "00:30");

  // Normalizar números por si llegan NaN
  if (!Number.isFinite(s)) s = toMinutes("20:30");
  if (!Number.isFinite(e)) e = s + 240;

  if (e <= s) e = s + 240; // asegurar ≥4h

  // Encajar en la franja 18:00–01:00
  if (s < MIN) s = MIN;
  if (e - s < 240) e = s + 240;
  if (e > MAX) {
    // Si nos pasamos del límite, corremos el inicio hacia atrás manteniendo 4h
    s = Math.max(MIN, MAX - 240);
    e = s + 240;
  }

  const dur = Math.max(240, e - s);
  const durTxt = `${Math.floor(dur/60)}h${dur%60 ? " "+(dur%60)+"m" : ""}`;

  return {
    ...row,
    start: toHHMM(s),
    end: toHHMM(e), // toHHMM ya hace wrap modulo 24h
    transport: row.transport || "Vehículo alquilado o Tour guiado",
    duration: row.duration || durTxt,
  };
}

// Heurística de transporte: forzar “Vehículo alquilado o Tour guiado” en day trips
function normalizeTransportTrip(activity = "", to = "", transport = "") {
  const txt = `${activity} ${to}`.toLowerCase();
  const isTrip = OUT_OF_TOWN_RE.test(txt);
  if (!isTrip) return transport || "Taxi";

  const t = (transport || "").toLowerCase();
  const alreadyOK = /tour|alquilad|veh[ií]culo|auto|carro|coche/.test(t);
  if (alreadyOK) return transport;

  // si el modelo propuso metro/bus/tren para rutas sin público eficiente → forzar dupla
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

  const anyTrip = rowsOfDay.some(r =>
    OUT_OF_TOWN_RE.test(`${r.activity||""} ${r.to||""}`)
  );
  if (!anyTrip) return rowsOfDay;

  const last = rowsOfDay[rowsOfDay.length - 1] || {};
  const destRe = new RegExp(escapeRegExp(destination), "i"); // ← seguro
  const alreadyBack =
    /regreso\s+a/i.test(last.activity || "") ||
    destRe.test(last.to || "");
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

// Elegibilidad de ciudad para auroras
function isAuroraEligibleCity(name = "") {
  return AURORA_CITY_RE.test(String(name || ""));
}

// Inyección de auroras (si falta) con 1–2 noches, nunca consecutivas y no solo último día
function injectAuroraIfMissing(dest, rows) {
  if (!isAuroraEligibleCity(dest)) return rows;
  if (rows.some(r => AURORA_RE.test(r.activity || ""))) return rows;

  const byDay = rows.reduce((acc, r) => ((acc[r.day] = acc[r.day] || []).push(r), acc), {});
  const days = Object.keys(byDay).map(Number).sort((a,b)=>a-b);
  if (!days.length) return rows;

  const last = days[days.length - 1];
  const d1 = days.find(d => d !== last) || days[0];
  const d2 = days.length >= 4
    ? days.find(d => d !== d1 && d !== last && Math.abs(d - d1) > 1)
    : null;

  const mk = (day) => normalizeAuroraWindow({
    day,
    start: "20:30",
    end: "00:30",         // se ajustará a ≥4h por normalizeAuroraWindow
    activity: "Caza de Auroras Boreales",
    from: dest,
    to: "Zona de observación",
    transport: "Vehículo alquilado o Tour guiado",
    duration: "4h",
    notes: "Salida nocturna para intentar ver auroras (horario orientativo).",
  });

  const out = rows.slice();
  out.push(mk(d1));
  if (d2) out.push(mk(d2));
  out.sort((a,b)=>(a.day-b.day)||(sortKeyMinutes(a)-sortKeyMinutes(b)));
  return out;
}

// Relaja la mañana posterior a una noche de auroras
function relaxNextMorningIfAurora(byDay) {
  const days = Object.keys(byDay).map(Number).sort((a,b)=>a-b);
  const auroraDays = new Set(
    days.filter(d => (byDay[d]||[]).some(r => AURORA_RE.test(r.activity||"")))
  );
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
      r.start = toHHMM(s);
      r.end = toHHMM(e);
    }
  }
}

// Tope global de auroras 1–2 noches, nunca consecutivas, y evita que la única sea el último día
function enforceAuroraCapGlobal(rows) {
  const byDay = rows.reduce((acc, r) => ((acc[r.day] = acc[r.day] || []).push(r), acc), {});
  const days = Object.keys(byDay).map(Number).sort((a,b)=>a-b);
  const stay = days.length;
  const cap = stay >= 5 ? 2 : (stay >= 3 ? 1 : 1);

  // Lista de días con aurora
  let auroraDays = days.filter(d => (byDay[d]||[]).some(r => AURORA_RE.test(r.activity||"")));

  // Evitar consecutivas: si hay consecutivas, elimina la 2ª
  auroraDays.sort((a,b)=>a-b);
  for (let i=1; i<auroraDays.length; i++){
    if (auroraDays[i] === auroraDays[i-1] + 1) {
      byDay[auroraDays[i]] = (byDay[auroraDays[i]]||[]).filter(r=>!AURORA_RE.test(r.activity||""));
    }
  }

  // Recalcular después de filtrar consecutivas
  auroraDays = days.filter(d => (byDay[d]||[]).some(r => AURORA_RE.test(r.activity||"")));

  // Evitar que la única aurora sea el último día
  if (auroraDays.length === 1 && auroraDays[0] === days[days.length-1]) {
    const last = days[days.length-1];
    byDay[last] = (byDay[last]||[]).filter(r=>!AURORA_RE.test(r.activity||""));
  }

  // Aplicar tope global
  auroraDays = days.filter(d => (byDay[d]||[]).some(r => AURORA_RE.test(r.activity||"")));
  if (auroraDays.length > cap) {
    const keep = auroraDays.slice(0, cap);
    for (const d of auroraDays) {
      if (!keep.includes(d)) {
        byDay[d] = (byDay[d]||[]).filter(r=>!AURORA_RE.test(r.activity||""));
      }
    }
  }

  // Reconstruir plano
  const merged = [];
  days.forEach(d => (byDay[d]||[]).forEach(r => merged.push(r)));
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
   SECCIÓN 6 · Prompt del agente (reglas reforzadas)
────────────────────────────────────────────────────── */
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido** con un itinerario inspirador y funcional.

📌 FORMATOS VÁLIDOS
B) {"destination":"City","rows":[{...}],"followup":"texto breve","replace":false}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos 1 actividad en "rows".
- Nada de texto fuera del JSON (sin explicaciones).
- Máximo 20 actividades por día.
- Horarios **flexibles y realistas**. Permite noche extendida y cruce de medianoche cuando aporte valor.
- Cenas **opcionales**.
- No devuelvas "seed" ni dejes campos vacíos.

🧭 ESTRUCTURA DE CADA ACTIVIDAD
{
  "day": 1,
  "start": "08:30",
  "end": "10:30",
  "activity": "Nombre claro y específico (usa 'Ruta — Subparada' para tours)",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "A pie, Metro, Taxi, Bus, Auto, Ferry, Tour guiado",
  "duration": "2h",
  "notes": "Descripción motivadora y breve"
}

🌟 PRIORIDAD GLOBAL: CIUDAD BASE > DAY TRIPS
- En grandes ciudades (p. ej., **Madrid**, París, Londres, Roma), **prioriza siempre los imperdibles urbanos** (2–3 días) **antes** de proponer *day trips*.
- Propón un *day trip* solo si:
  1) sobran horas/días después de cubrir los imperdibles, o
  2) el usuario lo pide explícitamente.
- Ejemplo Madrid (ilustrativo, NO obligatorio):
  - Imperdibles: Palacio Real, Plaza Mayor, Retiro, Prado, Reina Sofía, Gran Vía, Templo de Debod, Puerta de Alcalá, Mercado de San Miguel.
  - Day trips típicos: **Toledo**, **Segovia**, **Ávila**, **El Escorial**, **Aranjuez** (uno por día como máximo).

🌟 TOURS ICÓNICOS (formato obligatorio)
- Usa SIEMPRE el formato **"Ruta — Subparada"**.
- Incluye **al menos 3 subparadas** por ruta cuando aplique.
- Ejemplos:
  - "Círculo Dorado — Þingvellir", "Círculo Dorado — Geysir", "Círculo Dorado — Gullfoss"
  - "Reykjanes — Kleifarvatn", "Reykjanes — Krýsuvík/Seltún", "Reykjanes — Puente entre Continentes", "Reykjanes — Reykjanesviti", "Reykjanes — Gunnuhver", "Reykjanes — Valahnúkamöl", "Reykjanes — Fagradalsfjall"
  - "Snæfellsnes — Kirkjufell", "Snæfellsnes — Kirkjufellsfoss", "Snæfellsnes — Parque Nacional Snæfellsjökull"

🌌 AURORAS — **REGLA DURA**
- Sugiere auroras solo si latitud ≥ ~55°N y temporada (fin de ago–mediados de abr).
- **Ventana 18:00–01:00**, **duración mínima 4h** (ajusta inicio si es necesario para cumplirla).
- Evita noches consecutivas y que la única sea el último día.
- Después de una noche de auroras, el **día siguiente inicia ≥10:30** con plan cercano/urbano.

🚆 TRANSPORTE Y TIEMPOS
- Orden sin solapes, con buffers razonables.
- **Si el usuario no especificó transporte y no hay transporte público claramente eficiente para un day trip, usa "Vehículo alquilado o Tour guiado".**
- Incluye tiempos aproximados de actividad y traslados.

🔁 CIERRE DEL DÍA
- **Siempre** termina cada día con **"Regreso a hotel"**.
- Si hubo salida fuera de la ciudad, antes incluye **"Regreso a <Ciudad base>"**.

📝 EDICIÓN
- Si el usuario pide agregar/quitar/ajustar, responde con el **JSON actualizado**.
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
