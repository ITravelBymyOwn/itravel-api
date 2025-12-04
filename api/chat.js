// =====================================================
// /api/chat.js — v37.0 (ESM compatible en Vercel)
// BASE: v31.0 estable + injerto quirúrgico de mejoras (v36.9)
// - Parsing y anti-fallback robusto
// - Post-procesador integral (orden, auroras ≥4h 18:00–01:00, no consecutivas,
//   relax mañana ≥10:30, regreso a <Ciudad> y “Regreso a hotel” siempre,
//   transporte dual en day-trips, dedupe fuerte, “Ruta — Subparada” via prompt)
// - Regla global Ciudad vs Day-trips (prioriza imperdibles de ciudad)
// - Triple intento con backoff leve; salvavidas “mínimo 1 fila”
// =====================================================

/* ────────────────────────────────────────────────────
   SECCIÓN 1 · Import y cliente OpenAI
────────────────────────────────────────────────────── */
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ────────────────────────────────────────────────────
   SECCIÓN 2 · Helpers de body, parsing y fallback
────────────────────────────────────────────────────── */
function safeGetBody(req) {
  const b = req?.body;
  if (!b) return {};
  if (typeof b === "string") {
    try { return JSON.parse(b); } catch { return {}; }
  }
  if (typeof b === "object") return b;
  return {};
}

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
  let t = String(raw || "");
  t = stripCodeFences(t);
  t = t.replace(/,\s*([\]}])/g, "$1"); // trailing commas
  t = t.replace(/"rows":\s*\[\s*'([^"]+)'/g, (_, g1) => `"rows":["${g1.replace(/"/g, '\\"')}"]`);
  return t;
}

// Acepta string u objeto del modelo; extrae JSON válido
function cleanToJSON(raw = "") {
  // ya es objeto?
  if (raw && typeof raw === "object") return raw;
  if (!raw || typeof raw !== "string") return null;

  // ruta simple (v31.0)
  try { return JSON.parse(raw); } catch {}

  // ruta robusta
  const candidates = [];
  const stripped = stripCodeFences(raw);
  if (stripped) candidates.push(stripped);
  const fenced = (raw.match(/```(?:json)?([\s\S]*?)```/i) || [])[1];
  if (fenced) candidates.push(fenced.trim());
  const sliced = tryExtractJSONObject(raw);
  if (sliced) candidates.push(sliced);

  for (const c of candidates) {
    try { const j = JSON.parse(c); if (j && typeof j === "object") return j; } catch {}
    try { const j2 = JSON.parse(tryRepairJsonMinor(c)); if (j2 && typeof j2 === "object") return j2; } catch {}
  }

  // fallback minimalista (v31.0 hacía otro intento simple)
  try {
    const cleaned = raw.replace(/^[^{]+/, "").replace(/[^}]+$/, "");
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function fallbackJSON(reason = "unknown") {
  return {
    destination: "Desconocido",
    rows: [
      {
        day: 1,
        start: "09:00",
        end: "18:00",
        activity: "Itinerario base (fallback)",
        from: "",
        to: "",
        transport: "",
        duration: "",
        notes: "Explora libremente la ciudad y descubre sus lugares más emblemáticos.",
      },
    ],
    replace: false,
    followup: `⚠️ Fallback local (${reason}). Revisa configuración de Vercel/API Key o logs.`,
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

const NO_PUBLIC_EFFICIENT = [
  // Islandia
  "círculo dorado", "golden circle",
  "snæfellsnes", "snaefellsnes",
  "costa sur", "reynisfjara", "vík", "vik",
  "reykjanes", "kirkjufell", "kirkjufellsfoss",
  "kleifarvatn", "krýsuvík", "seltún", "reykjanesviti", "gunnuhver", "valahnúkamöl", "fagradalsfjall",
  // Madrid y alrededores
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
function escapeRegExp(str = "") {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ────────────────────────────────────────────────────
   SECCIÓN 4 · Post-procesos (orden, auroras, retornos, dedupe)
────────────────────────────────────────────────────── */
function sortKeyMinutes(row) {
  const s = toMinutes(row.start || "00:00");
  const e = toMinutes(row.end || row.start || "00:00");
  let key = s;
  if (AURORA_RE.test(row.activity || "") && e <= s) key = s + 1440; // noche cruza medianoche
  if (/regreso\s+a\s+hotel/i.test(row.activity || "") && s < 240) key = s + 1440; // madrugada
  return key;
}

// Auroras: 18:00–01:00 (cruzando día), mínimo 4h
function normalizeAuroraWindow(row) {
  if (!AURORA_RE.test(row.activity || "")) return row;
  const MIN = toMinutes("18:00");
  const MAX = toMinutes("01:00") + 24 * 60;

  let s = toMinutes(row.start || "20:30");
  let e = toMinutes(row.end || "00:30");
  if (!Number.isFinite(s)) s = toMinutes("20:30");
  if (!Number.isFinite(e)) e = s + 240;
  if (e <= s) e = s + 240;

  if (s < MIN) s = MIN;
  if (e - s < 240) e = s + 240;
  if (e > MAX) { s = Math.max(MIN, MAX - 240); e = s + 240; }

  const dur = Math.max(240, e - s);
  const durTxt = `${Math.floor(dur/60)}h${dur%60 ? " "+(dur%60)+"m" : ""}`;

  return {
    ...row,
    start: toHHMM(s),
    end: toHHMM(e),
    transport: row.transport || "Vehículo alquilado o Tour guiado",
    duration: row.duration || durTxt,
  };
}

// Transporte dual agresivo en day-trips
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

function ensureReturnToCity(destination, rowsOfDay) {
  if (!Array.isArray(rowsOfDay) || !rowsOfDay.length) return rowsOfDay;

  const anyTrip = rowsOfDay.some(r =>
    OUT_OF_TOWN_RE.test(`${r.activity||""} ${r.to||""}`)
  );
  if (!anyTrip) return rowsOfDay;

  const last = rowsOfDay[rowsOfDay.length - 1] || {};
  const destRe = new RegExp(escapeRegExp(destination), "i");
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

function pruneLeadingReturns(rowsOfDay) {
  if (!Array.isArray(rowsOfDay) || !rowsOfDay.length) return rowsOfDay;
  return rowsOfDay.filter((r, idx) => {
    if (idx > 0) return true;
    const a = (r.activity || "").toLowerCase();
    if (/^regreso a (hotel|ciudad)/.test(a)) return false;
    return true;
  });
}

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

function isAuroraEligibleCity(name = "") {
  return AURORA_CITY_RE.test(String(name || ""));
}

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

  const mk = (day) => {
    const endLast = toMinutes((byDay[day].slice(-1)[0]?.end) || "20:30");
    const s = Math.max(endLast + 30, toMinutes("20:30"));
    const e = s + 240; // 4h
    return normalizeAuroraWindow({
      day,
      start: toHHMM(s),
      end: toHHMM(e),
      activity: "Caza de Auroras Boreales",
      from: dest,
      to: "Zona de observación",
      transport: "Vehículo alquilado o Tour guiado",
      duration: "4h",
      notes: "Salida nocturna para intentar ver auroras (horario orientativo).",
    });
  };

  const out = rows.slice();
  out.push(mk(d1));
  if (d2) out.push(mk(d2));
  out.sort((a,b)=>(a.day-b.day)||(sortKeyMinutes(a)-sortKeyMinutes(b)));
  return out;
}

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

function enforceAuroraCapGlobal(rows) {
  const byDay = rows.reduce((acc, r) => ((acc[r.day] = acc[r.day] || []).push(r), acc), {});
  const days = Object.keys(byDay).map(Number).sort((a,b)=>a-b);
  const stay = days.length;
  const cap = stay >= 5 ? 2 : (stay >= 3 ? 1 : 1);

  let auroraDays = days.filter(d => (byDay[d]||[]).some(r => AURORA_RE.test(r.activity||"")));
  auroraDays.sort((a,b)=>a-b);

  // Evitar noches consecutivas (elimina la 2ª)
  for (let i=1; i<auroraDays.length; i++){
    if (auroraDays[i] === auroraDays[i-1] + 1) {
      byDay[auroraDays[i]] = (byDay[auroraDays[i]]||[]).filter(r=>!AURORA_RE.test(r.activity||""));
    }
  }

  // Recalcular
  auroraDays = days.filter(d => (byDay[d]||[]).some(r => AURORA_RE.test(r.activity||"")));

  // Evitar que la única sea el último día
  if (auroraDays.length === 1 && auroraDays[0] === days[days.length-1]) {
    const last = days[days.length-1];
    byDay[last] = (byDay[last]||[]).filter(r=>!AURORA_RE.test(r.activity||""));
  }

  // Aplicar tope
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

function ensureAtLeastOneRow(destination, rows = []) {
  if (Array.isArray(rows) && rows.length > 0) return rows;
  return [{
    day: 1,
    start: "09:30",
    end: "11:00",
    activity: `Centro histórico de ${destination}`,
    from: destination,
    to: destination,
    transport: "A pie",
    duration: "1h 30m",
    notes: "Recorrido base por los imprescindibles cercanos para iniciar el día.",
  }];
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

      // End vacío o ≤ start → duración razonable (90m; auroras ≥4h se ajustan luego)
      const s = toMinutes(base.start);
      const e = endRaw ? toMinutes(endRaw) : null;
      if (e === null || e <= s) {
        const dur = AURORA_RE.test(activity) ? 240 : 90;
        base.end = toHHMM(s + dur);
        if (!base.duration) {
          base.duration = dur >= 60 ? `${Math.floor(dur/60)}h${dur%60? " "+(dur%60)+"m":""}` : `${dur}m`;
        }
      }
      return base;
    })
    .slice(0, 180);

  // Ajuste de auroras
  rows = rows.map(normalizeAuroraWindow);

  const dest = parsed.destination || "Ciudad";

  // Orden y retornos por día
  const byDay = rows.reduce((acc, r) => ((acc[r.day] = acc[r.day] || []).push(r), acc), {});
  const mergedOrdered = [];
  Object.keys(byDay).map(Number).sort((a,b)=>a-b).forEach(d => {
    byDay[d].sort((a,b)=>sortKeyMinutes(a)-sortKeyMinutes(b));
    let fixed = byDay[d];

    fixed = ensureReturnToCity(dest, fixed);
    fixed = ensureEndReturnToHotel(fixed);

    fixed.sort((a,b)=>sortKeyMinutes(a)-sortKeyMinutes(b));
    fixed = pruneLeadingReturns(fixed);

    byDay[d] = fixed;
    mergedOrdered.push(...fixed);
  });

  // Relajar mañana tras auroras
  const byDay2 = mergedOrdered.reduce((acc, r) => ((acc[r.day] = acc[r.day] || []).push(r), acc), {});
  relaxNextMorningIfAurora(byDay2);

  // Reconstruir
  let afterRelax = [];
  Object.keys(byDay2).map(Number).sort((a,b)=>a-b).forEach(d => {
    byDay2[d].sort((a,b)=>sortKeyMinutes(a)-sortKeyMinutes(b));
    byDay2[d] = pruneLeadingReturns(byDay2[d]);
    afterRelax.push(...byDay2[d]);
  });

  // Auroras: inyección mínima + tope global + dedupe
  let withAuroras = injectAuroraIfMissing(dest, afterRelax);
  withAuroras = enforceAuroraCapGlobal(withAuroras);
  withAuroras = dedupeRows(withAuroras);

  // Salvavidas: garantizar al menos 1 fila
  withAuroras = ensureAtLeastOneRow(dest, withAuroras);

  withAuroras.sort((a,b)=>(a.day-b.day)||(sortKeyMinutes(a)-sortKeyMinutes(b)));
  parsed.rows = withAuroras;

  if (typeof parsed.followup !== "string") parsed.followup = "";
  return parsed;
}

/* ────────────────────────────────────────────────────
   SECCIÓN 6 · Prompt del agente (reglas globales)
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
- Horarios realistas; permite extender la noche y cruce de medianoche si aporta valor.
- Cenas opcionales.
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

🌟 TOURS ICÓNICOS (formato obligatorio “Ruta — Subparada”)
- Círculo Dorado: "Círculo Dorado — Þingvellir", "— Geysir", "— Gullfoss", "— Cráter Kerið" (opcional).
- Reykjanes: "Reykjanes — Kleifarvatn", "— Krýsuvík/Seltún", "— Puente entre Continentes", "— Reykjanesviti", "— Gunnuhver", "— Fagradalsfjall (mirador)", "— Laguna Azul" (opcional).
- Snæfellsnes: "Snæfellsnes — Kirkjufell", "— Kirkjufellsfoss", "— Parque Nacional Snæfellsjökull", "— Arnarstapi/Hellnar".
- Costa Sur: "Costa Sur — Seljalandsfoss", "— Skógafoss", "— Reynisfjara", "— Vík".
- Incluye ≥3 subparadas cuando aplique.

🏛️ REGLA GLOBAL: PRIORIDAD CIUDAD vs. DAY-TRIPS (con ANÁLISIS)
- Explica en "followup" (breve) si conviene seguir en ciudad o proponer day-trip.
- Criterios:
  1) Cubre imperdibles top-5 de la ciudad antes de asignar day-trips.
  2) Duración:
     - 1–2 días: 0 day-trips salvo caso extraordinario.
     - 3–4 días: máx. 1 day-trip.
     - ≥5 días: 1–2 day-trips según valor/clima.
  3) Valor diferencial (paisajes icónicos/patrimonio).
  4) Traslados: usualmente ≤2h30 (≤3h si estadía larga).

🌌 AURORAS (regla específica, no global)
- Solo si latitud ≥ ~55°N y temporada (fin ago–mediados abr).
- Duración 4h, **entre 18:00 y 01:00**.
- Evita noches consecutivas y que la única sea el último día.
- Tras auroras, el día siguiente inicia **≥10:30** y con plan urbano/cercano.
- Cierra el día con "Regreso a hotel".

🚆 TRANSPORTE Y TIEMPOS (global)
- Orden sin solapes, buffers razonables.
- En day-trips sin público claramente eficiente, usa **"Vehículo alquilado o Tour guiado"**.
- Incluye tiempos aproximados de actividad y traslados.

🔁 CIERRE DEL DÍA (global)
- Si hubo salida fuera de la ciudad, agrega "Regreso a <Ciudad base>".
- **Siempre** termina con "Regreso a hotel".
`.trim();

/* ────────────────────────────────────────────────────
   SECCIÓN 7 · Llamada al modelo (triple intento + backoff)
────────────────────────────────────────────────────── */
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callStructured(messages, temperature = 0.35) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await client.responses.create({
        model: "gpt-4o-mini",
        temperature,
        input: messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
        max_output_tokens: 2400,
      });
      const text =
        resp?.output_text?.trim() ||
        resp?.output?.[0]?.content?.[0]?.text?.trim() ||
        "";
      if (!text) throw new Error("empty-output");
      return text;
    } catch (err) {
      lastErr = err;
      await wait(attempt === 1 ? 250 : 600);
    }
  }
  throw lastErr || new Error("responses-create-failed");
}

/* ────────────────────────────────────────────────────
   SECCIÓN 8 · Handler ESM (export default)
────────────────────────────────────────────────────── */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = safeGetBody(req);
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    // MODO INFO: eco de texto libre del modelo (sin JSON)
    if (mode === "info") {
      try {
        const raw = await callStructured(clientMessages, 0.35);
        const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
        return res.status(200).json({ text });
      } catch (e) {
        console.error("info mode error:", e?.message || e);
        return res.status(200).json({ text: JSON.stringify(fallbackJSON("info-mode-error")) });
      }
    }

    // Intento 1
    let raw = await callStructured(
      [{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages],
      0.35
    );
    let parsed = cleanToJSON(raw);
    parsed = normalizeParsed(parsed);

    // Intento 2: refuerzo “al menos 1 fila”
    const hasRows = parsed && Array.isArray(parsed.rows) && parsed.rows.length > 0;
    if (!hasRows) {
      const strictPrompt =
        SYSTEM_PROMPT +
        `

OBLIGATORIO: Devuelve al menos 1 fila en "rows". Nada de meta. SOLO JSON.`;
      raw = await callStructured(
        [{ role: "system", content: strictPrompt }, ...clientMessages],
        0.25
      );
      parsed = normalizeParsed(cleanToJSON(raw));
    }

    // Intento 3: plantilla mínima válida
    const stillNoRows = !parsed || !Array.isArray(parsed.rows) || parsed.rows.length === 0;
    if (stillNoRows) {
      const ultraPrompt =
        SYSTEM_PROMPT +
        `
Ejemplo VÁLIDO de formato mínimo:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"Taxi","duration":"60m","notes":"Explora un rincón único de la ciudad"}],"replace":false}`;
      raw = await callStructured(
        [{ role: "system", content: ultraPrompt }, ...clientMessages],
        0.15
      );
      parsed = normalizeParsed(cleanToJSON(raw));
    }

    if (!parsed) parsed = fallbackJSON("no-parse-after-3-attempts");

    // Salida final
    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (err) {
    console.error("❌ /api/chat fatal error:", err?.message || err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON(err?.message || "unknown-error")) });
  }
}
