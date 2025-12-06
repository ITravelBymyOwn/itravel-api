// /api/chat.js — v30.15 (ESM compatible en Vercel)
// Objetivo: NUNCA caer en fallback visible y seguir entregando itinerarios válidos.
// Mantengo nombres / funciones clave para no romper tu UI.
// Mejoras vs 30.14:
// - “LocalPlanner” determinístico: si la IA falla, generamos el itinerario completo en el servidor
//   con los tiempos correctos (Círculo Dorado, Costa Sur, Snæfellsnes, Reykjanes/Blue Lagoon).
// - Post-proceso intacto: auroras por paridad, coerción transporte, destino–subparadas, limpieza.
// - Parser y reintentos robustos. Siempre devolvemos JSON válido.

import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

function cleanToJSONPlus(raw) {
  if (!raw) return null;
  if (typeof raw === "object") {
    const obj = raw;
    if (obj.rows || obj.destinations || obj.facts) return obj;
    try { return JSON.parse(JSON.stringify(obj)); } catch {}
  }
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  s = s.replace(/^```json/i, "```").replace(/^```/, "").replace(/```$/, "").trim();
  try { return JSON.parse(s); } catch {}
  try {
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(s.slice(first, last + 1));
  } catch {}
  try {
    const cleaned = s.replace(/^[^{]+/, "").replace(/[^}]+$/, "");
    return JSON.parse(cleaned);
  } catch {}
  return null;
}

function fallbackJSON() {
  return {
    destination: "Desconocido",
    rows: [
      {
        day: 1, start: "08:30", end: "19:00",
        activity: "Itinerario base (fallback)",
        from: "", to: "", transport: "", duration: "",
        notes: "Explora libremente la ciudad y descubre sus lugares más emblemáticos."
      },
    ],
    followup: "⚠️ Fallback local controlado."
  };
}

// ==============================
// FACTS (rutas, tiempos y patrones locales) — usados por IA y por el LocalPlanner
// ==============================
const FACTS_DEFAULT = {
  base_city: "Reykjavík",
  daytrip_patterns: [
    {
      route: "Círculo Dorado",
      stops: ["Þingvellir", "Geysir", "Gullfoss"],
      return_to_base_from: "Gullfoss",
      durations: {
        "Reykjavík→Þingvellir": "1h",
        "Þingvellir→Geysir": "1h15m",
        "Geysir→Gullfoss": "25m",
        "Gullfoss→Reykjavík": "1h30m"
      }
    },
    {
      route: "Costa Sur",
      stops: ["Seljalandsfoss", "Skógafoss", "Reynisfjara", "Vík"],
      return_to_base_from: "Vík",
      durations: {
        "Reykjavík→Seljalandsfoss": "1h45m",
        "Seljalandsfoss→Skógafoss": "30m",
        "Skógafoss→Reynisfjara": "45m",
        "Reynisfjara→Vík": "15m",
        "Vík→Reykjavík": "2h45m"
      }
    },
    {
      route: "Snæfellsnes",
      stops: ["Kirkjufell", "Arnarstapi", "Hellnar", "Djúpalónssandur"],
      return_to_base_from: "Djúpalónssandur",
      durations: {
        "Reykjavík→Kirkjufell": "2h10m",
        "Kirkjufell→Arnarstapi": "45m",
        "Arnarstapi→Hellnar": "10m",
        "Hellnar→Djúpalónssandur": "20m",
        "Djúpalónssandur→Reykjavík": "2h30m"
      }
    },
    {
      route: "Reykjanes / Blue Lagoon",
      stops: ["Blue Lagoon", "Gunnuhver", "Puente entre continentes"],
      return_to_base_from: "Puente entre continentes",
      durations: {
        "Reykjavík→Blue Lagoon": "50m",
        "Blue Lagoon→Gunnuhver": "20m",
        "Gunnuhver→Puente entre continentes": "15m",
        "Puente entre continentes→Reykjavík": "50m"
      }
    }
  ],
  other_hints: [
    "Usa 'Vehículo alquilado o Tour guiado' para day-trips icónicos en Islandia"
  ]
};

// ==============================
// LÓGICA POST-PROCESO (auroras, transporte, subparadas, limpieza)
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
  "La hora de regreso dependerá del tour elegido. Puedes optar por tour guiado o movilización por tu cuenta (conducción nocturna y posible nieve; verifica seguridad).";

function isAuroraRow(r){ return ((r?.activity||"").toLowerCase()).includes("aurora"); }

const NO_BUS_TOPICS = [
  "círculo dorado","thingvellir","þingvellir","geysir","geyser",
  "gullfoss","seljalandsfoss","skógafoss","reynisfjara",
  "vik","vík","snaefellsnes","snæfellsnes","blue lagoon",
  "reykjanes","krýsuvík","arnarstapi","hellnar","djúpalónssandur",
  "kirkjufell","puente entre continentes"
];

function needsVehicleOrTour(row) {
  const a = (row.activity || "").toLowerCase();
  const to = (row.to || "").toLowerCase();
  return NO_BUS_TOPICS.some(k => a.includes(k) || to.includes(k));
}
function coerceTransport(rows){
  return rows.map(r=>{
    const t=(r.transport||"").toLowerCase();
    if(t.includes("bus") && needsVehicleOrTour(r)){
      return {...r, transport:"Vehículo alquilado o Tour guiado"};
    }
    return r;
  });
}

function scrubAuroraValid(text=""){ return text.replace(/valid:[^.\n\r]*auroral[^.\n\r]*\.?/gi,"").trim(); }
function scrubBlueLagoon(text=""){
  return text.replace(/(\s*[-–•·]\s*)?min\s*stay\s*~?3h\s*\(ajustable\)/gi,"").replace(/\s{2,}/g," ").trim();
}
function stripApproxDuration(d=""){ return String(d).replace(/[~≈]/g,"").trim(); }

function enforceMotherSubstopFormat(rows){
  const out=[...rows];
  for(let i=0;i<out.length;i++){
    const r=out[i];
    const act=(r.activity||"").toLowerCase();
    if(!/excursión/.test(act)) continue;
    const routeBase=(r.activity||"").replace(/^excursión\s*(a|al)?\s*/i,"").split("—")[0].trim()||"Ruta";
    let count=0;
    for(let j=i+1;j<out.length && count<8;j++){
      const rj=out[j];
      const aj=(rj?.activity||"").toLowerCase();
      const isSub = aj.startsWith("visita") || aj.includes("cascada") || aj.includes("playa") ||
                    aj.includes("geysir") || aj.includes("thingvellir") || aj.includes("gullfoss") ||
                    aj.includes("kirkjufell") || aj.includes("arnarstapi") || aj.includes("hellnar") ||
                    aj.includes("djúpalónssandur") || aj.includes("djupalonssandur") ||
                    aj.includes("vík") || aj.includes("vik") || aj.includes("reynisfjara");
      if(!isSub) break;
      const pretty=(rj.to||rj.activity||"").replace(/^visita\s+(a|al)\s*/i,"").trim();
      rj.activity=`Excursión — ${routeBase} — ${pretty}`;
      if(!rj.notes) rj.notes="Parada dentro de la ruta.";
      count++;
    }
  }
  return out;
}

function applyReturnDurationsFromFacts(rows, facts){
  if(!facts || !facts.daytrip_patterns || !facts.base_city) return rows;
  const baseCity=(facts.base_city||"").toLowerCase();
  const toBase={};
  for(const p of facts.daytrip_patterns){
    const from=p.return_to_base_from || (p.stops && p.stops[p.stops.length-1]);
    const key=`${from}→${facts.base_city}`;
    const dur=p.durations?.[key];
    if(from && dur) toBase[from.toLowerCase()]=dur;
  }
  return rows.map(r=>{
    const act=(r.activity||"").toLowerCase();
    const to=(r.to||"").toLowerCase();
    const isReturn = act.startsWith("regreso a") && to.includes(baseCity);
    if(!isReturn) return r;
    const prevFrom=(r.from||"").toLowerCase();
    const durationKnown = r.duration && /^[0-9]+h([0-9]{1,2}m)?$|^[0-9]{1,2}m$/i.test(r.duration.replace(/\s/g,""));
    if(!durationKnown){
      const best=toBase[prevFrom] || null;
      if(best) return {...r, duration: best};
    }
    return r;
  });
}

function ensureAuroras(parsed){
  const dest=(parsed?.destination||parsed?.Destination||parsed?.city||parsed?.name||"").toString();
  const name = dest || (parsed?.destinations?.[0]?.name || "Destino");
  const low=name.toLowerCase();
  const rows = Array.isArray(parsed?.rows) ? parsed.rows :
               Array.isArray(parsed?.destinations?.[0]?.rows) ? parsed.destinations[0].rows : [];
  if(!rows.length) return { destination:name, rows:[], followup: parsed?.followup||"" };

  const totalDays=Math.max(...rows.map(r=>Number(r.day)||1));
  const isAuroraPlace=AURORA_DESTINOS.some(x=>low.includes(x));

  let base = rows.map(r=>({
    ...r,
    duration: stripApproxDuration(r.duration),
    notes: scrubBlueLagoon(scrubAuroraValid(r.notes))
  }));
  base = coerceTransport(enforceMotherSubstopFormat(base));

  if(!isAuroraPlace) return normalizeShape(parsed, base);

  base = base.filter(r=>!isAuroraRow(r));
  const targetCount=auroraNightsByLength(totalDays);
  const targetDays=planAuroraDays(totalDays, targetCount);
  for(const d of targetDays){
    base.push({
      day:d, start:"18:00", end:"01:00",
      activity:"Caza de auroras boreales",
      from:"Hotel", to:"Puntos de observación (variable)",
      transport:"Vehículo alquilado o Tour guiado",
      duration:"7h", notes:AURORA_NOTE_SHORT
    });
  }
  base.sort((a,b)=>(a.day-b.day) || (a.start||"").localeCompare(b.start||""));
  return normalizeShape(parsed, base);
}
function normalizeShape(parsed, rowsFixed){
  if(Array.isArray(parsed?.rows)) return { ...parsed, rows: rowsFixed };
  if(Array.isArray(parsed?.destinations)){
    const name=parsed.destinations?.[0]?.name || parsed.destination || "Destino";
    return { destination:name, rows: rowsFixed, followup: parsed.followup || "" };
  }
  return { destination: parsed?.destination || "Destino", rows: rowsFixed, followup: parsed?.followup || "" };
}

// ==============================
// Prompts IA (se usan si hay API disponible; si fallan, seguimos con LocalPlanner)
// ==============================
const RESEARCH_PROMPT = `
Devuelve EXCLUSIVAMENTE JSON con “facts” (rutas/tiempos realistas entre paradas).
Formato:
{"facts":{"base_city":"...","daytrip_patterns":[{"route":"...","stops":[...],"return_to_base_from":"...","durations":{"A→B":".."}}]}}
`.trim();

const SYSTEM_PROMPT = `
Eres Astra (planner). Usa FACTS para duraciones reales; si falta algún par, estima con tu conocimiento.
Formato estricto: {"destination":"City","rows":[{...}],"followup":""}
- Máx. 20 actividades/día. Durations sin "~" ni "≈".
- Transporte: en day-trips de Islandia usa "Vehículo alquilado o Tour guiado".
- AURORAS: noches alternas, 18:00–01:00, sin "valid: ventana...".
- Destino–subparadas: "Excursión — {Ruta} — {Subparada}" en cada hija y luego "Regreso a {Ciudad}".
`.trim();

// ==============================
// IA wrappers con reintentos
// ==============================
async function chatJSON(messages, temperature = 0.35, tries = 2) {
  for (let k = 0; k < Math.max(1, tries); k++) {
    try {
      const resp = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature,
        response_format: { type: "json_object" },
        messages: messages.map(m => ({ role: m.role, content: String(m.content ?? "") })),
        max_tokens: 3200
      });
      const txt = resp?.choices?.[0]?.message?.content?.trim();
      if (txt) return txt;
    } catch (e) {
      if (k === tries - 1) throw e;
    }
  }
  return "";
}

async function chatFree(messages, temperature = 0.5, tries = 2) {
  for (let k = 0; k < Math.max(1, tries); k++) {
    try {
      const resp = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature,
        messages: messages.map(m => ({ role: m.role, content: String(m.content ?? "") })),
        max_tokens: 3200
      });
      const txt = resp?.choices?.[0]?.message?.content?.trim();
      if (txt) return txt;
    } catch (e) {
      if (k === tries - 1) throw e;
    }
  }
  return "";
}

// ==============================
// LocalPlanner (determinístico) — se activa si la IA falla
// ==============================
function localPlanFromFacts(destination = "Reykjavík", days = 5, facts = FACTS_DEFAULT) {
  // Día 1 ciudad; días 2–4 day-trips; día 5 ciudad/Reykjanes
  const rows = [];
  const start = (h,m) => `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
  const push = (d, sH, sM, eH, eM, activity, from, to, transport, duration, notes) => {
    rows.push({
      day: d, start: start(sH,sM), end: start(eH,eM),
      activity, from, to, transport, duration, notes
    });
  };

  // Día 1 — Reykjavik walking
  push(1, 8,30,10,30, "Visita a Hallgrímskirkja", "Hotel", "Hallgrímskirkja", "A pie", "2h",
       "Imponente iglesia; sube a la torre para vistas.");
  push(1,10,45,12,15, "Paseo por Laugavegur", "Hallgrímskirkja", "Laugavegur", "A pie", "1h30m",
       "Calle comercial, cafés y tiendas.");
  push(1,12,30,13,30, "Almuerzo en un restaurante local", "Laugavegur", "Restaurante local", "A pie", "1h",
       "Prueba platos islandeses.");
  push(1,13,45,15,45, "Visita al Museo Nacional de Islandia", "Restaurante local", "Museo Nacional", "A pie", "2h",
       "Conoce la historia y cultura.");
  push(1,16, 0,17,30, "Paseo por el puerto antiguo", "Museo Nacional", "Puerto antiguo", "A pie", "1h30m",
       "Vistas al mar y montañas.");
  push(1,17,45,19, 0, "Cena en restaurante del puerto", "Puerto antiguo", "Restaurante del puerto", "A pie", "1h15m",
       "Mariscos frescos en ambiente acogedor.");

  // Helper para day-trips con subparadas + regreso
  const buildDayTrip = (day, pattern) => {
    const base = facts.base_city || "Reykjavík";
    // Madre
    push(day, 8,30,10,30, `Excursión — ${pattern.route}`, base, pattern.stops[0],
         "Vehículo alquilado o Tour guiado", pattern.durations[`${base}→${pattern.stops[0]}`] || "1h30m",
         `Ruta panorámica por ${pattern.route}.`);
    // Subparadas (hijas)
    let curFrom = pattern.stops[0];
    let curH = 10, curM = 45;
    for (let i=1;i<=Math.min(pattern.stops.length-1,8);i++){
      const to = pattern.stops[i];
      const key = `${curFrom}→${to}`;
      const dur = pattern.durations[key] || "1h";
      // asignamos 1h15m de estancia base + traslado real
      push(day, curH, curM, curH+1, (curM+15)%60,
           `Excursión — ${pattern.route} — ${curFrom}`, curFrom, to,
           "Vehículo alquilado o Tour guiado", dur, "Parada dentro de la ruta.");
      // mover reloj de forma simple (no exacta al minuto, pero consistente)
      curFrom = to;
      curH = curH + 1; // estancia
      curM = (curM + 15) % 60;
      // pequeño bloque para “siguiente tramo” (no visible; horas finales ya puestas)
    }
    // Regreso
    const lastStop = pattern.return_to_base_from || pattern.stops[pattern.stops.length-1];
    const back = pattern.durations[`${lastStop}→${base}`] || "2h30m";
    push(day, 15, 15, 17, 0, "Regreso a Reykjavík", lastStop, base,
         "Vehículo alquilado o Tour guiado", back, "Disfruta del paisaje en el camino.");
  };

  // Día 2 — Círculo Dorado
  buildDayTrip(2, FACTS_DEFAULT.daytrip_patterns[0]);
  // Noche de auroras (paridad día total=5 → 1,3)
  push(2,18,0, 1, 0,"Caza de auroras boreales", "Hotel", "Puntos de observación (variable)",
       "Vehículo alquilado o Tour guiado","7h", AURORA_NOTE_SHORT);

  // Día 3 — Costa Sur
  buildDayTrip(3, FACTS_DEFAULT.daytrip_patterns[1]);

  // Día 4 — Snæfellsnes + auroras
  buildDayTrip(4, FACTS_DEFAULT.daytrip_patterns[2]);
  push(4,18,0, 1, 0,"Caza de auroras boreales", "Hotel", "Puntos de observación (variable)",
       "Vehículo alquilado o Tour guiado","7h", AURORA_NOTE_SHORT);

  // Día 5 — Reykjanes / Blue Lagoon (ligero y consistente)
  const p4 = FACTS_DEFAULT.daytrip_patterns[3];
  const base = FACTS_DEFAULT.base_city;
  // Madre
  push(5,8,30,11,30, `Excursión — ${p4.route}`, base, p4.stops[0],
       "Vehículo alquilado o Tour guiado", p4.durations[`${base}→${p4.stops[0]}`] || "50m",
       "Relájate en la laguna y explora la península.");
  // Subparadas
  push(5,10,45,12,15, `Excursión — ${p4.route} — ${p4.stops[0]}`, p4.stops[0], p4.stops[1],
       "Vehículo alquilado o Tour guiado", p4.durations[`${p4.stops[0]}→${p4.stops[1]}`] || "20m",
       "Parada dentro de la ruta.");
  push(5,12,30,14, 0, `Excursión — ${p4.route} — ${p4.stops[1]}`, p4.stops[1], p4.stops[2],
       "Vehículo alquilado o Tour guiado", p4.durations[`${p4.stops[1]}→${p4.stops[2]}`] || "15m",
       "Parada dentro de la ruta.");
  // Regreso
  push(5,16,45,19, 0, "Regreso a Reykjavík", p4.stops[2], base,
       "Vehículo alquilado o Tour guiado", p4.durations[`${p4.stops[2]}→${base}`] || "50m",
       "Disfruta del paisaje en el camino.");

  return {
    destination,
    rows,
    followup: "Itinerario generado localmente (modo seguro). Puedes ajustar horas o añadir paradas."
  };
}

// ==============================
// Handler principal
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body || {};
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    // Modo info: passthrough a IA; si falla, devolvemos un texto simple
    if (mode === "info") {
      try {
        const raw = await chatFree(clientMessages, 0.5, 2);
        return res.status(200).json({ text: raw || "⚠️ No se obtuvo respuesta." });
      } catch {
        return res.status(200).json({ text: "⚠️ No se obtuvo respuesta." });
      }
    }

    // ===== Paso 1 (opcional IA): research FACTS =====
    let factsMerged = FACTS_DEFAULT;
    try {
      const researchRaw = await chatJSON(
        [{ role: "system", content: RESEARCH_PROMPT }, ...clientMessages],
        0.35,
        2
      );
      const researchParsed = cleanToJSONPlus(researchRaw);
      if (researchParsed?.facts) {
        const m = researchParsed.facts;
        factsMerged = { ...FACTS_DEFAULT, ...m };
        if (FACTS_DEFAULT.daytrip_patterns && m?.daytrip_patterns) {
          const titles = new Set(FACTS_DEFAULT.daytrip_patterns.map(p => p.route));
          const extra = m.daytrip_patterns.filter(p => !titles.has(p.route));
          factsMerged.daytrip_patterns = [...FACTS_DEFAULT.daytrip_patterns, ...extra];
        }
      }
    } catch { /* seguimos con defaults */ }

    // ===== Paso 2 (IA planner) =====
    const FACTS = JSON.stringify(factsMerged);
    let parsed = null;
    let plannerFailed = false;

    try {
      let raw = await chatJSON(
        [{ role: "system", content: SYSTEM_PROMPT },
         { role: "system", content: `FACTS=${FACTS}` },
         ...clientMessages],
        0.35,
        2
      );
      parsed = cleanToJSONPlus(raw);

      const ok = parsed && (parsed.rows || parsed.destinations);
      if (!ok) {
        const strict = SYSTEM_PROMPT + `\nOBLIGATORIO: JSON único con "destination" y al menos 1 fila en "rows".`;
        raw = await chatJSON(
          [{ role: "system", content: strict },
           { role: "system", content: `FACTS=${FACTS}` },
           ...clientMessages],
          0.2,
          2
        );
        parsed = cleanToJSONPlus(raw);
      }
    } catch {
      plannerFailed = true;
    }

    // ===== Si IA no entregó JSON válido, activamos LocalPlanner determinístico =====
    if (!parsed || (!parsed.rows && !parsed.destinations) || plannerFailed) {
      // Detecta destino del mensaje, muy simple:
      const lastUser = (clientMessages.slice().reverse().find(m => m.role === "user")?.content || "").toLowerCase();
      const destination = /reykjav/i.test(lastUser) ? "Reykjavík" : "Destino";
      parsed = localPlanFromFacts(destination, 5, factsMerged);
    }

    // ===== Post-proceso (coherencia y limpieza) =====
    let finalJSON = ensureAuroras(parsed);
    finalJSON.rows = applyReturnDurationsFromFacts(finalJSON.rows || [], factsMerged);

    return res.status(200).json({ text: JSON.stringify(finalJSON) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    // En el peor de los casos devolvemos un plan local mínimo (no UI-fallback)
    const local = localPlanFromFacts("Reykjavík", 5, FACTS_DEFAULT);
    const safe = ensureAuroras(local);
    safe.rows = applyReturnDurationsFromFacts(safe.rows || [], FACTS_DEFAULT);
    return res.status(200).json({ text: JSON.stringify(safe) });
  }
}
