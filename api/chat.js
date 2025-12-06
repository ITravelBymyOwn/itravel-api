// /api/chat.js — v32.1 “no-fallback, fast, GLOBAL (solo auroras predefinidas)” — ESM/Vercel
// Cambios vs v32.0:
// - Eliminado cualquier hardcode de destinos/temas islandeses (NO_BUS_TOPICS, Blue Lagoon, etc.).
// - Coerción de transporte GLOBAL: si la actividad es “Excursión — …”, usar “Vehículo alquilado o Tour guiado”.
// - Investigación (1 llamada, tipo info-chat) + caché; si falla, planner local genera siempre rows válidos.
// - Lógica de auroras permanece (único preset global), resto 100% neutral por país/ciudad.

import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==============================
// Utilidades
// ==============================
function extractMessages(body = {}) {
  const { messages, input, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;
  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";
  return [...prev, { role: "user", content: userText }];
}

function parseJSONLoose(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  s = s.replace(/```json\s*([\s\S]*?)```/gi, "$1");
  s = s.replace(/```\s*([\s\S]*?)```/g, "$1");
  try { return JSON.parse(s); } catch {}
  try {
    const first = s.indexOf("{"); const last = s.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(s.slice(first, last + 1));
  } catch {}
  try {
    const cleaned = s.replace(/^[^{\[]+/, "").replace(/[^}\]]+$/, "");
    return JSON.parse(cleaned);
  } catch {}
  return null;
}

function clampText(str, max = 2000) {
  if (!str) return "";
  const s = String(str);
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

function guessCityFromMessages(msgs = []) {
  const text = msgs.map(m => String(m.content || "")).join(" ");
  const m = text.match(/\b(?:en|para|hacia)\s+([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑüäöß\- ]{2,})/i);
  if (m) return m[1].trim();
  const m2 = text.match(/\b([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑüäöß\-]{3,})\b/);
  return m2 ? m2[1] : "Destino";
}

function minutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm||"").trim());
  if (!m) return 0;
  return (+m[1])*60 + (+m[2]);
}
function toHHMM(mins) {
  const h = Math.floor(mins/60)%24;
  const m = mins%60;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
}

// ==============================
// Post-proceso (GLOBAL) + AURORAS (único preset)
// ==============================
const AURORA_DESTINOS = [
  "reykjavik","reykjavík","tromso","tromsø","rovaniemi","kiruna",
  "abisko","alta","ivalo","yellowknife","fairbanks","akureyri",
  "murmansk","longyearbyen","svalbard","nuuk","anchorage","grundarfjordur"
];
function auroraNightsByLength(totalDays) {
  if (totalDays <= 2) return 1;
  if (totalDays <= 4) return 2;
  if (totalDays <= 6) return 2;
  if (totalDays <= 9) return 3;
  return 3;
}
function planAuroraDays(totalDays, count) {
  const start = (totalDays % 2 === 0) ? 1 : 2;
  const out = [];
  for (let d = start; out.length < count && d < totalDays; d += 2) out.push(d);
  return out;
}
const AURORA_NOTE_SHORT =
  "Noche especial de caza de auroras. Con cielos despejados y paciencia, podrás presenciar un espectáculo natural inolvidable. " +
  "La hora de regreso al hotel dependerá del tour elegido. " +
  "Puedes optar por tour guiado o movilización por tu cuenta (posible nieve y noche; verifica seguridad).";
function isAuroraRow(r){ return ((r?.activity||"").toLowerCase().includes("aurora")); }

// Coerción de transporte GLOBAL: si es “Excursión — …”, usar vehículo/tour
function coerceTransport(rows){
  return rows.map(r=>{
    const act = String(r.activity||"");
    if (/^Excursión\s+—/i.test(act)) {
      return { ...r, transport: "Vehículo alquilado o Tour guiado" };
    }
    return r;
  });
}

function stripApproxDuration(d=""){ return d? String(d).replace(/[~≈]/g,"").trim() : d; }
function scrubNotes(text=""){
  if(!text) return "";
  return text
    .replace(/valid:[^.\n\r]*auroral[^.\n\r]*\.?/gi,"")
    .replace(/\s{2,}/g," ")
    .trim();
}

/**
 * Convención madre-subparadas GLOBAL (sin listas locales):
 * “Excursión — {Ruta}” seguido por ≤8 filas hijas consecutivas (si existen),
 * renombradas como “Excursión — {Ruta} — {Subparada}”.
 */
function enforceMotherSubstopFormat(rows){
  const out=[...rows];
  for(let i=0;i<out.length;i++){
    const r=out[i]; const act=String(r.activity||"");
    const m = act.match(/^Excursión\s+—\s*(.+)$/i);
    if(!m) continue;
    const routeBase = m[1].split("—")[0].trim() || "Ruta";
    let count=0;
    for(let j=i+1;j<out.length && count<8;j++){
      const rj=out[j];
      if(!rj) break;
      const aj=String(rj.activity||"");
      // Heurística: si la siguiente fila parece “parada” (p.ej. “Visita …”, “Parada …”, “Mirador …”, etc.)
      if (/^(Visita|Parada|Mirador|Museo|Playa|Cascada|Pueblo|Templo|Iglesia|Barrio|Mercado)\b/i.test(aj)) {
        const pretty = (rj.to || rj.activity || "").replace(/^Visita\s+(a|al)\s*/i,"").trim() || aj;
        rj.activity=`Excursión — ${routeBase} — ${pretty}`;
        if(!rj.notes) rj.notes="Parada dentro de la ruta.";
        count++;
        continue;
      }
      break;
    }
  }
  return out;
}

function normalizeShape(parsed, rowsFixed){
  if(Array.isArray(parsed?.rows)){
    return { destination: parsed.destination||parsed.city||"Destino", rows: rowsFixed, followup: parsed.followup||"" };
  }
  if(Array.isArray(parsed?.destinations)){
    const name=parsed.destinations?.[0]?.name||parsed.destination||"Destino";
    return { destination:name, rows: rowsFixed, followup: parsed.followup||"" };
  }
  return { destination: parsed?.destination || "Destino", rows: rowsFixed, followup: parsed?.followup || "" };
}

function ensureAuroras(parsed){
  const dest = (parsed?.destination||parsed?.Destination||parsed?.city||parsed?.name||"")+"";
  const rows = Array.isArray(parsed?.rows) ? parsed.rows
             : Array.isArray(parsed?.destinations) ? (parsed.destinations[0]?.rows||[])
             : [];
  if(!rows.length) return parsed;

  const low = dest.toLowerCase();
  const totalDays = Math.max(...rows.map(r=>Number(r.day)||1));
  let base = rows.map(r=>({ ...r, duration: stripApproxDuration(r.duration), notes: scrubNotes(r.notes) }));
  base = coerceTransport(enforceMotherSubstopFormat(base));

  if(!AURORA_DESTINOS.some(x=>low.includes(x))) return normalizeShape(parsed, base);

  base = base.filter(r=>!isAuroraRow(r));
  const targetDays = planAuroraDays(totalDays, auroraNightsByLength(totalDays));
  for(const d of targetDays){
    base.push({
      day:d, start:"18:00", end:"01:00",
      activity:"Caza de auroras boreales",
      from:"Hotel", to:"Puntos de observación (variable)",
      transport:"Vehículo alquilado o Tour guiado", duration:"7h", notes:AURORA_NOTE_SHORT
    });
  }
  base.sort((a,b)=>(a.day-b.day)||String(a.start).localeCompare(String(b.start)));
  return normalizeShape(parsed, base);
}

// ==============================
// Investigación (opcional, 1 llamada) + caché
// ==============================
const RESEARCHER_PROMPT = `
Devuelve EXCLUSIVAMENTE JSON con este esquema:
{
  "facts": {
    "base_city": "string",
    "daytrip_patterns": [
      {
        "route": "string",
        "stops": ["a","b","c"],
        "return_to_base_from": "string",
        "durations": { "A→B":"1h15m", "B→C":"30m" }
      }
    ],
    "other_hints": ["≤140 chars", "≤140 chars"]
  }
}
Reglas:
- Sin texto fuera del JSON.
- Duraciones "##h##m" o "##m" (sin "~" ni "≈").
- Global; no asumas un país.
`.trim();

async function researchOnce(messages) {
  try {
    const resp = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL_RESEARCH || "gpt-4o-mini",
      temperature: 0.15,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: RESEARCHER_PROMPT },
        { role: "user", content: clampText(messages.map(m=>m.content).join(" "), 2000) }
      ],
      max_tokens: 1200
    });
    const txt = resp?.choices?.[0]?.message?.content?.trim() || "";
    const parsed = parseJSONLoose(txt);
    return parsed?.facts || {};
  } catch {
    return {};
  }
}

const researchCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6h
const CACHE_MAX = 64;
function cacheKey(city, user){ return `${String(city||"").toLowerCase()}::${String(user||"").slice(0,400).toLowerCase()}`; }
function getCache(key){
  const hit = researchCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) { researchCache.delete(key); return null; }
  return hit.facts;
}
function setCache(key, facts){
  if (researchCache.size >= CACHE_MAX) {
    const first = researchCache.keys().next().value;
    if (first) researchCache.delete(first);
  }
  researchCache.set(key, { facts, exp: Date.now() + CACHE_TTL_MS });
}

// ==============================
// Planner LOCAL (determinístico, global)
// ==============================
function clampFacts(f) {
  const facts = f && typeof f === "object" ? { ...f } : {};
  facts.base_city = String(facts.base_city || "").trim();
  facts.other_hints = Array.isArray(facts.other_hints) ? facts.other_hints.slice(0, 12) : [];
  facts.daytrip_patterns = Array.isArray(facts.daytrip_patterns) ? facts.daytrip_patterns.slice(0, 6).map(p => ({
    route: String(p.route || "").trim(),
    stops: Array.isArray(p.stops) ? p.stops.slice(0, 12).map(s => String(s||"").trim()) : [],
    return_to_base_from: String(p.return_to_base_from || "").trim(),
    durations: p.durations || {}
  })) : [];
  return facts;
}

function buildExcursionRows(city, baseCity, pattern, dayIdx, start="08:30") {
  const out = [];
  let t = minutes(start);
  const seg = (dur) => {
    if(!dur) return 60;
    const m = String(dur).replace(/\s/g,"");
    const hm = m.match(/^(\d+)h(?:(\d{1,2})m)?$/i);
    if(hm) return (+hm[1])*60 + (+hm[2]||0);
    const mm = m.match(/^(\d{1,3})m$/i);
    if(mm) return (+mm[1]);
    return 60;
  };

  // Salida
  out.push({
    day: dayIdx, start: toHHMM(t), end: toHHMM(t+=60),
    activity: `Excursión — ${pattern.route}`,
    from: baseCity || city, to: pattern.stops?.[0] || "Primer punto",
    transport: "Vehículo alquilado o Tour guiado",
    duration: "60m",
    notes: "Salida para jornada completa con paradas icónicas."
  });

  // Sub-paradas (≤8)
  const subs = (pattern.stops || []).slice(0,8);
  for (const s of subs) {
    out.push({
      day: dayIdx, start: toHHMM(t), end: toHHMM(t+=75),
      activity: `Excursión — ${pattern.route} — ${s}`,
      from: "Ruta", to: s,
      transport: "Vehículo alquilado o Tour guiado",
      duration: "1h15m",
      notes: "Parada dentro de la ruta."
    });
  }

  // Regreso
  const lastStop = subs[subs.length-1] || pattern.return_to_base_from || "Última parada";
  const key = `${lastStop}→${baseCity || city}`;
  const backDur = pattern.durations?.[key] || "1h30m";
  const backM = seg(backDur);
  out.push({
    day: dayIdx, start: toHHMM(t), end: toHHMM(t+=backM),
    activity: `Regreso a ${baseCity || city}`,
    from: lastStop, to: baseCity || city,
    transport: "Vehículo alquilado o Tour guiado",
    duration: backDur,
    notes: "Retorno al alojamiento."
  });

  // Cena ligera si cabe
  if (t <= minutes("20:00")) {
    out.push({
      day: dayIdx, start: "19:30", end: "21:00",
      activity: "Cena en zona céntrica",
      from: baseCity || city, to: "Restaurante recomendado",
      transport: "A pie",
      duration: "1h30m",
      notes: "Reserva sugerida. Opciones locales e icónicas."
    });
  }

  return out;
}

function buildCityWalkRows(city, dayIdx, start="09:00") {
  let t = minutes(start);
  const blocks = [
    { name: "Paseo de orientación por el centro", dur: 90 },
    { name: "Plaza/avenida principal", dur: 60 },
    { name: "Mercado o calle comercial", dur: 75 },
    { name: "Mirador urbano", dur: 60 }
  ];
  const rows = [];
  for (const b of blocks) {
    rows.push({
      day: dayIdx, start: toHHMM(t), end: toHHMM(t+=b.dur),
      activity: b.name, from: "Centro", to: city,
      transport: "A pie", duration: `${b.dur}m`,
      notes: "Tiempo flexible para fotos y descanso."
    });
    // buffer 15m
    rows.push({
      day: dayIdx, start: toHHMM(t), end: toHHMM(t+=15),
      activity: "Traslado/Buffer", from: "", to: "",
      transport: "A pie", duration: "15m",
      notes: "Margen para desplazamiento."
    });
  }
  // Cena
  rows.push({
    day: dayIdx, start: "19:00", end: "20:30",
    activity: "Cena icónica",
    from: city, to: "Restaurante",
    transport: "A pie", duration: "1h30m",
    notes: "Sugerencia de cocina local."
  });
  return rows;
}

/**
 * Generador determinístico GLOBAL:
 * - D1: paseo urbano
 * - D2: si hay FACTS.daytrip_patterns[0] => Excursión de día completo
 * - D3+: esquema urbano ligero. Máx. 20 filas/día.
 */
function planLocalFromFacts(city, facts, totalDays=2) {
  const baseCity = facts.base_city || city;
  const patterns = Array.isArray(facts.daytrip_patterns) ? facts.daytrip_patterns : [];
  const out = [];
  const days = Math.max(1, Math.min(7, Number(totalDays)||2));

  for (let d=1; d<=days; d++) {
    let rows = [];
    if (d===1) {
      rows = buildCityWalkRows(city, d, "09:00");
    } else if (d===2 && patterns.length) {
      rows = buildExcursionRows(city, baseCity, patterns[0], d, "08:30");
    } else {
      rows = buildCityWalkRows(city, d, "09:30");
    }

    // Limitar a 20 actividades por día
    const byDay = rows.filter(r => r.day === d);
    if (byDay.length > 20) {
      let count = 0;
      rows = rows.filter(r => r.day !== d || (++count <= 20));
    }

    out.push(...rows);
  }

  return {
    destination: city,
    rows: out,
    followup: (facts.other_hints && facts.other_hints[0]) ? facts.other_hints[0] : ""
  };
}

// ==============================
// Handler
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
      // Este endpoint es solo planner; devolvemos estructura mínima válida
      return res.status(200).json({ text: JSON.stringify({ destination:"Info", rows:[], followup:"Usa modo planner." }) });
    }

    // ===== Investigación opcional (1 llamada) con caché =====
    const cityGuess = guessCityFromMessages(clientMessages);
    const userJoined = clientMessages.map(m => String(m.content||"")).join(" ");
    const key = cacheKey(cityGuess, userJoined);
    let facts = getCache(key);
    if (!facts) {
      const raw = await researchOnce(clientMessages);
      facts = clampFacts(raw);
      setCache(key, facts);
    }

    // ===== Planner LOCAL determinístico (cero LLM, cero reintentos) =====
    const text = userJoined.toLowerCase();
    const md = text.match(/\b(\d{1,2})\s*(?:d[ií]as?)\b/);
    const totalDays = md ? Math.max(1, Math.min(7, parseInt(md[1],10))) : 2;

    let draft = planLocalFromFacts(cityGuess, facts, totalDays);

    // ===== Post-proceso (GLOBAL + AURORAS) =====
    let finalJSON = ensureAuroras(draft);
    if (!finalJSON || !Array.isArray(finalJSON.rows) || finalJSON.rows.length === 0) {
      // Garantía dura de salida
      finalJSON = {
        destination: cityGuess,
        rows: [{
          day: 1, start:"09:00", end:"10:00",
          activity:"Paseo de orientación por el centro", from:"", to:"",
          transport:"A pie", duration:"60m", notes:"Primer acercamiento."
        }],
        followup: ""
      };
    }

    return res.status(200).json({ text: JSON.stringify(finalJSON) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    // Nunca rompemos la UI
    const safe = {
      destination: "Destino",
      rows: [{
        day: 1, start:"09:00", end:"10:00",
        activity:"Itinerario mínimo (recuperación)", from:"", to:"",
        transport:"A pie", duration:"60m", notes:"Revisa la configuración."
      }],
      followup: ""
    };
    return res.status(200).json({ text: JSON.stringify(safe) });
  }
}
