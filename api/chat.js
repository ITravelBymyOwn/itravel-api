// /api/chat.js — v31.2-hybrid (ESM, Vercel)
// Pipeline en 2 pasos rápido y estable:
// A) RESEARCH (tipo info chat) → FACTS JSON (compacto, con caché en memoria)
// B) PLANNER (usa FACTS) → JSON estructurado
// Mantiene tu lógica: sub-paradas (≤8), coerción transporte, auroras (paridad),
// limpieza de notas/duración y normalización final. Global (salvo auroras).

import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==============================
// Utilidades generales
// ==============================
function extractMessages(body = {}) {
  const { messages, input, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;
  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";
  return [...prev, { role: "user", content: userText }];
}

// Parser tolerante (sin reintentos costosos)
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

function fallbackJSONMinimal(cityGuess = "Destino") {
  return {
    destination: cityGuess || "Destino",
    rows: [
      {
        day: 1, start: "09:00", end: "10:00",
        activity: "Paseo de orientación por el centro",
        from: "", to: "", transport: "A pie",
        duration: "60m", notes: "Primer acercamiento para ubicar puntos clave."
      }
    ],
    followup: ""
  };
}

// Heurística simple para “adivinar” ciudad principal del mensaje (para mínimos/caché)
function guessCityFromMessages(msgs = []) {
  const text = msgs.map(m => String(m.content || "")).join(" ");
  // Busca patrones sencillos: "en X", "para X", "hacia X"
  const m = text.match(/\b(?:en|para|hacia)\s+([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑüäöß\- ]{2,})/i);
  if (m) return m[1].trim();
  // Alternativa: primera palabra capitalizada larga
  const m2 = text.match(/\b([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑüäöß\-]{3,})\b/);
  return m2 ? m2[1] : "Destino";
}

// Limitadores de tamaño para evitar latencias/errores por prompts enormes
function clampText(str, max = 2400) {
  if (!str) return "";
  const s = String(str);
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}
function clampArray(arr, max = 16) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, max);
}
function clampFacts(f) {
  // Compacta FACTS a un presupuesto pequeño de tokens
  const facts = f && typeof f === "object" ? { ...f } : {};
  facts.base_city = clampText(facts.base_city || "", 80);
  facts.other_hints = clampArray(facts.other_hints || [], 12).map(x => clampText(x, 160));
  facts.daytrip_patterns = clampArray(facts.daytrip_patterns || [], 6).map(p => ({
    route: clampText(p.route || "", 80),
    stops: clampArray(p.stops || [], 12).map(s => clampText(s, 60)),
    return_to_base_from: clampText(p.return_to_base_from || "", 80),
    durations: p.durations || {}
  }));
  return facts;
}

// ==============================
// Post-proceso (mantiene tu lógica)
// ==============================
const AURORA_DESTINOS = [
  "reykjavik","reykjavík","tromso","tromsø","rovaniemi","kiruna",
  "abisko","alta","ivalo","yellowknife","fairbanks","akureyri"
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

const NO_BUS_TOPICS = [
  "círculo dorado","thingvellir","þingvellir","geysir","geyser",
  "gullfoss","seljalandsfoss","skógafoss","reynisfjara",
  "vik","vík","snaefellsnes","snæfellsnes","blue lagoon",
  "reykjanes","krýsuvík","arnarstapi","hellnar","djúpalónssandur",
  "kirkjufell","puente entre continentes"
];
function needsVehicleOrTour(row){
  const a=(row.activity||"").toLowerCase(); const to=(row.to||"").toLowerCase();
  return NO_BUS_TOPICS.some(k => a.includes(k) || to.includes(k));
}
function coerceTransport(rows){
  return rows.map(r=>{
    const t=(r.transport||"").toLowerCase();
    if(t.includes("bus") && needsVehicleOrTour(r)) return { ...r, transport:"Vehículo alquilado o Tour guiado" };
    return r;
  });
}
function stripApproxDuration(d=""){ return d? String(d).replace(/[~≈]/g,"").trim() : d; }
function scrubNotes(text=""){
  if(!text) return "";
  return text
    .replace(/valid:[^.\n\r]*auroral[^.\n\r]*\.?/gi,"")
    .replace(/(\s*[-–•·]\s*)?min\s*stay\s*~?3h\s*\(ajustable\)/gi,"")
    .replace(/\s{2,}/g," ")
    .trim();
}
function enforceMotherSubstopFormat(rows){
  const out=[...rows];
  for(let i=0;i<out.length;i++){
    const r=out[i]; const act=(r.activity||"").toLowerCase();
    if(!/excursión/.test(act)) continue;
    const routeBase=(r.activity||"").replace(/^excursión\s*(a|al)?\s*/i,"").split("—")[0].trim()||"Ruta";
    let count=0;
    for(let j=i+1;j<out.length && count<8;j++){
      const rj=out[j]; const aj=(rj?.activity||"").toLowerCase();
      const isSub = aj.startsWith("visita")||aj.includes("cascada")||aj.includes("playa")||aj.includes("geysir")
        ||aj.includes("thingvellir")||aj.includes("gullfoss")||aj.includes("kirkjufell")||aj.includes("arnarstapi")
        ||aj.includes("hellnar")||aj.includes("djúpalónssandur")||aj.includes("djupalonssandur")||aj.includes("vík")
        ||aj.includes("vik")||aj.includes("reynisfjara");
      if(!isSub) break;
      const pretty=(rj.to||rj.activity||"").replace(/^visita\s+(a|al)\s*/i,"").trim();
      rj.activity=`Excursión — ${routeBase} — ${pretty}`;
      if(!rj.notes) rj.notes="Parada dentro de la ruta.";
      count++;
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
// Prompts
// ==============================

// Paso A.1 — PROMPT del investigador (tipo info-chat) → SOLO JSON
const RESEARCHER_PROMPT = `
Eres un investigador turístico ultra conciso.
Devuelve **EXCLUSIVAMENTE un JSON válido** con este esquema:

{
  "facts": {
    "base_city": "Nombre de ciudad base si aplica (string)",
    "daytrip_patterns": [
      {
        "route": "Nombre breve de la ruta",
        "stops": ["Parada1","Parada2","Parada3"],
        "return_to_base_from": "Última parada o la más típica para volver",
        "durations": {
          "CiudadA→CiudadB": "1h15m",
          "ParadaX→ParadaY": "30m"
        }
      }
    ],
    "other_hints": [
      "Consejo práctico breve (≤140 chars)",
      "Otro consejo breve"
    ]
  }
}

Reglas:
- Sin texto fuera del JSON.
- Duraciones en "##h##m" o "##m" (sin "~" ni "≈").
- Si no hay rutas claras, facts.daytrip_patterns puede ir vacío.
- Sé global (no asumas solo un país).
`.trim();

// Paso B — SYSTEM prompt del planner (usa FACTS)
const PLANNER_SYSTEM = `
Eres Astra, el planificador de viajes de ITravelByMyOwn.
Responde **EXCLUSIVAMENTE JSON válido** con la forma:
{"destination":"City","rows":[{...}],"followup":"texto breve"}

Reglas:
- Siempre al menos 1 actividad en "rows".
- 08:30–19:00 por defecto; extiende por cenas/tours/auroras si aplica.
- "duration" limpio ("1h30m" o "45m"; sin "~" ni "≈").
- Máx. 20 actividades por día.
- Permite "Excursión — {Ruta} — {Subparada}" en hijas consecutivas (≤8) y luego "Regreso a {Ciudad}" con duración realista.
- Day trips fuera de ciudad: usa "Vehículo alquilado o Tour guiado" cuando sea lógico (no "Bus" para lugares icónicos).
- Auroras (si el destino es de auroras): noches alternas, nunca el último día; 18:00–01:00.
`.trim();

// ==============================
// Chat wrappers (llamadas únicas, sin “mil intentos”)
// ==============================
async function chatJSONOnce(messages, temperature = 0.2, max_tokens = 2000, model = (process.env.OPENAI_MODEL || "gpt-4o-mini")) {
  const resp = await client.chat.completions.create({
    model, temperature,
    response_format: { type: "json_object" },
    messages: messages.map(m => ({ role: m.role, content: String(m.content ?? "") })),
    max_tokens
  });
  return resp?.choices?.[0]?.message?.content?.trim() || "";
}

// ==============================
// Caché en memoria (válido en caliente de Vercel)
// ==============================
const researchCache = new Map(); // key -> { facts, exp }
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6h
const CACHE_MAX = 64;

function makeResearchKey(city, rawUser) {
  const base = (city || "Destino").toLowerCase();
  const h = (rawUser || "").slice(0, 400).toLowerCase();
  return `${base}::${h}`;
}
function getCache(key) {
  const hit = researchCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) { researchCache.delete(key); return null; }
  return hit.facts;
}
function setCache(key, facts) {
  if (researchCache.size >= CACHE_MAX) {
    // eliminación FIFO simple
    const first = researchCache.keys().next().value;
    if (first) researchCache.delete(first);
  }
  researchCache.set(key, { facts, exp: Date.now() + CACHE_TTL_MS });
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
      // Puedes reemplazar por tu info-chat si deseas; aquí forzamos modo planner/2-pasos.
      return res.status(200).json({ text: "Usa el modo planner para itinerarios con investigación." });
    }

    // ===== Paso A: RESEARCH rápido (con caché) =====
    const cityGuess = guessCityFromMessages(clientMessages);
    const joinedUser = clientMessages.map(m => String(m.content || "")).join(" ");
    const cacheKey = makeResearchKey(cityGuess, joinedUser);
    let facts = getCache(cacheKey);

    if (!facts) {
      const researchRaw = await chatJSONOnce(
        [
          { role: "system", content: RESEARCHER_PROMPT },
          // Compactamos contexto del usuario para no exceder:
          { role: "user", content: clampText(joinedUser, 2000) }
        ],
        0.15, // más determinista para datos
        1200, // respuesta corta
        process.env.OPENAI_MODEL_RESEARCH || "gpt-4o-mini"
      );

      const researchParsed = parseJSONLoose(researchRaw);
      const extracted = researchParsed && researchParsed.facts ? researchParsed.facts : {};
      facts = clampFacts(extracted);
      setCache(cacheKey, facts);
    }

    // String listo para inyectar como system
    const FACTS_SYSTEM = `FACTS=${JSON.stringify(facts)}`;

    // ===== Paso B: PLANNER (usa FACTS del paso A) =====
    const rawPlan = await chatJSONOnce(
      [
        { role: "system", content: PLANNER_SYSTEM },
        { role: "system", content: FACTS_SYSTEM },
        // Importante: compacto el mensaje del usuario para latencia y foco
        ...clientMessages.map(m => ({ role: m.role, content: clampText(m.content, 2000) }))
      ],
      0.33, // algo de diversidad sin perder estructura
      2200,
      process.env.OPENAI_MODEL_PLANNER || process.env.OPENAI_MODEL || "gpt-4o-mini"
    );

    let parsed = parseJSONLoose(rawPlan);
    if (!parsed || (!parsed.rows && !parsed.destinations)) {
      // Garantía de salida mínima sin reintentos costosos
      parsed = fallbackJSONMinimal(cityGuess);
    }

    // ===== Post-proceso idéntico a tu lógica =====
    let finalJSON = ensureAuroras(parsed);
    if (!finalJSON || !Array.isArray(finalJSON.rows) || finalJSON.rows.length === 0) {
      finalJSON = fallbackJSONMinimal(cityGuess);
    }

    return res.status(200).json({ text: JSON.stringify(finalJSON) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSONMinimal()) });
  }
}
