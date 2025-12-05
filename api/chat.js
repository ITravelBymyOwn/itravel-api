// =====================================================
// /api/chat.js — v37.4 (ESM · Vercel)
// BASE estable + lógica reforzada + FIXES anti-fallback y anti-vaciado
// =====================================================

import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ───────────── Body & Parsing ───────────── */
function safeGetBody(req) {
  const b = req?.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch { return {}; } }
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
function stripCodeFences(t = "") {
  if (typeof t !== "string") return t;
  return t.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}
function tryExtractJSONObject(s = "") {
  const txt = String(s || ""); const i = txt.indexOf("{"); const j = txt.lastIndexOf("}");
  return (i >= 0 && j > i) ? txt.slice(i, j + 1) : null;
}
function tryRepairJsonMinor(raw = "") {
  let t = String(raw || ""); t = stripCodeFences(t);
  t = t.replace(/,\s*([\]}])/g, "$1"); // trailing commas
  return t;
}
function cleanToJSON(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;       // Responses JSON ya parseado
  const candidates = [];
  if (typeof raw === "string") {
    const stripped = stripCodeFences(raw); if (stripped) candidates.push(stripped);
    const fenced = (raw.match(/```(?:json)?([\s\S]*?)```/i) || [])[1]; if (fenced) candidates.push(fenced.trim());
    const sliced = tryExtractJSONObject(raw); if (sliced) candidates.push(sliced);
  }
  for (const c of candidates) {
    try { const j = JSON.parse(c); if (j && typeof j === "object") return j; } catch {}
    try { const j2 = JSON.parse(tryRepairJsonMinor(c)); if (j2 && typeof j2 === "object") return j2; } catch {}
  }
  try { return JSON.parse(raw); } catch {}
  try { return JSON.parse(String(raw).replace(/^[^{]+/, "").replace(/[^}]+$/, "")); } catch {}
  return null;
}
function fallbackJSON(reason = "unknown") {
  return {
    destination: "Desconocido",
    rows: [{
      day: 1, start: "09:30", end: "11:00",
      activity: "Paseo urbano de orientación",
      from: "Centro", to: "Centro", transport: "A pie",
      duration: "1h 30m",
      notes: "Recorrido inicial por los puntos cercanos para tomar ritmo."
    }],
    replace: false,
    followup: `⚠️ Fallback local (${reason}). Revisa logs / configuración.`,
  };
}

/* ───────────── Constantes & Tiempo ───────────── */
const OUT_OF_TOWN_RE =
  /\b(thingvellir|þingvellir|gullfoss|geysir|golden\s*circle|círculo\s*dorado|seljalandsfoss|skógafoss|skogafoss|reynisfjara|v[ií]k|sn[aá]efellsnes|snaefellsnes|kirkjufell|kirkjufellsfoss|djúpalónssandur|valahn[uú]kam[oö]l|gunnuhver|puente\s+entre\s+continentes|bridge\s+between\s+continents|sn[aá]efellsj[oö]kull|blue\s*lagoon|laguna\s*azul|reykjanes|kleifarvatn|kr[yý]s[uú]v[ií]k|selt[uú]n|reykjanesviti|fagradalsfjall|costa\s*sur|pen[ií]nsula|fiordo|glaciar|volc[aá]n|cueva\s+de\s+hielo|ice\s*cave|whale\s*watching|faxafl[oó]i|toledo|segovia|[áa]vila|el\s+escorial|aranjuez)\b/i;
const AURORA_RE = /\b(auroras?|northern\s*lights?)\b/i;
const AURORA_CITY_RE =
  /(reykjav[ií]k|reikiavik|reykiavik|akureyri|troms[oø]|tromso|alta|bod[oø]|narvik|lofoten|abisko|kiruna|rovaniemi|yellowknife|fairbanks|murmansk|iceland|islandia|lapland|laponia)/i;
const NO_PUBLIC_EFFICIENT = [
  "círculo dorado","golden circle","snæfellsnes","snaefellsnes","costa sur","reynisfjara","vík","vik",
  "reykjanes","kirkjufell","kirkjufellsfoss","kleifarvatn","krýsuvík","seltún","reykjanesviti","gunnuhver","valahnúkamöl","fagradalsfjall",
  "toledo","segovia","ávila","avila","el escorial","aranjuez"
];
const pad = n => n.toString().padStart(2,"0");
function toMinutes(hhmm="00:00"){const m=/^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());if(!m)return 0;return +m[1]*60+ +m[2];}
function toHHMM(mins=0){const mm=((mins%(24*60))+(24*60))%(24*60);const h=Math.floor(mm/60);const m=mm%60;return `${pad(h)}:${pad(m)}`;}
function escapeRegExp(s=""){return String(s).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");}

/* ───────────── Post-procesos ───────────── */
function sortKeyMinutes(r){const s=toMinutes(r.start||"00:00");const e=toMinutes(r.end||r.start||"00:00");let k=s;
  if(AURORA_RE.test(r.activity||"")&&e<=s)k=s+1440;
  if(/regreso\s+a\s+hotel/i.test(r.activity||"")&&s<240)k=s+1440;
  return k;
}
// Auroras 18:00–01:00, mín 4h
function normalizeAuroraWindow(row){
  if(!AURORA_RE.test(row.activity||"")) return row;
  const MIN=toMinutes("18:00"), MAX=toMinutes("01:00")+24*60;
  let s=toMinutes(row.start||"20:30"), e=toMinutes(row.end||"00:30");
  if(!Number.isFinite(s)) s=toMinutes("20:30");
  if(!Number.isFinite(e)||e<=s) e=s+240;
  if(s<MIN) s=MIN; if(e-s<240) e=s+240; if(e>MAX){s=Math.max(MIN,MAX-240);e=s+240;}
  const dur=e-s, durTxt=`${Math.floor(dur/60)}h${dur%60?` ${dur%60}m`:""}`;
  return {...row,start:toHHMM(s),end:toHHMM(e),
    transport: row.transport||"Vehículo alquilado o Tour guiado",
    duration: row.duration||durTxt};
}
function normalizeTransportTrip(activity="",to="",transport=""){
  const txt=`${activity} ${to}`.toLowerCase(); const isTrip=OUT_OF_TOWN_RE.test(txt);
  if(!isTrip) return transport||"Taxi";
  const t=(transport||"").toLowerCase(); if(/tour|alquilad|veh[ií]culo|auto|carro|coche/.test(t)) return transport;
  if(!t || /(metro|bus|autob|tren|p[uú]blico)/.test(t) || NO_PUBLIC_EFFICIENT.some(w=>txt.includes(w)))
    return "Vehículo alquilado o Tour guiado";
  return transport||"Vehículo alquilado o Tour guiado";
}
function ensureReturnToCity(destination, rows){
  if(!Array.isArray(rows)||!rows.length) return rows;
  const anyTrip = rows.some(r=>OUT_OF_TOWN_RE.test(`${r.activity||""} ${r.to||""}`));
  if(!anyTrip) return rows;
  const last = rows[rows.length-1]||{};
  const destRe = new RegExp(escapeRegExp(destination),"i");
  const already = /regreso\s+a/i.test(last.activity||"") || destRe.test(last.to||"");
  if(already) return rows;
  const endM=toMinutes(last.end||"18:00");
  return [...rows,{
    day:last.day,start:toHHMM(endM+20),end:toHHMM(endM+90),
    activity:`Regreso a ${destination}`,from:last.to||last.activity||destination,to:destination,
    transport:"Vehículo alquilado o Tour guiado",duration:"1h 10m",
    notes:"Retorno a la ciudad base para cerrar el día."
  }];
}
function ensureEndReturnToHotel(rows){
  if(!Array.isArray(rows)||!rows.length) return rows;
  const last=rows[rows.length-1];
  if(/regreso\s+a\s+(hotel|alojamiento)/i.test(last.activity||"")) return rows;
  const endM=toMinutes(last.end||"19:00");
  return [...rows,{
    day:last.day,start:toHHMM(endM+5),end:toHHMM(endM+45),
    activity:"Regreso a hotel",from:last.to||last.activity||"Ciudad",to:"Hotel",
    transport: AURORA_RE.test(last.activity||"") ? "Tour guiado" : "Taxi",
    duration:"0.75h",notes:"Cierre del día con retorno cómodo al alojamiento."
  }];
}
function pruneLeadingReturns(rows){
  if(!Array.isArray(rows)||!rows.length) return rows;
  return rows.filter((r,i)=> i>0 ? true : !/^regreso a (hotel|ciudad)/i.test((r.activity||"").toLowerCase()));
}
function dedupeRows(rows=[]){
  const seen=new Set(), out=[]; for(const r of rows){
    const key=`${r.day}|${(r.activity||"").toLowerCase()}|${(r.to||"").toLowerCase()}|${r.start}-${r.end}`;
    if(seen.has(key)) continue; seen.add(key); out.push(r);
  } return out;
}
const isAuroraEligibleCity = name => AURORA_CITY_RE.test(String(name||""));
function injectAuroraIfMissing(dest, rows){
  if(!isAuroraEligibleCity(dest)) return rows;
  if(rows.some(r=>AURORA_RE.test(r.activity||""))) return rows;
  const byDay=rows.reduce((a,r)=>((a[r.day]=a[r.day]||[]).push(r),a),{});
  const days=Object.keys(byDay).map(Number).sort((a,b)=>a-b); if(!days.length) return rows;
  const last=days[days.length-1]; const d1=days.find(d=>d!==last)||days[0];
  const d2=days.length>=4 ? days.find(d=>d!==d1 && d!==last && Math.abs(d-d1)>1) : null;
  const mk=(day)=>normalizeAuroraWindow({
    day, start:"20:30", end:"00:30",
    activity:"Caza de Auroras Boreales", from:dest, to:"Zona de observación",
    transport:"Vehículo alquilado o Tour guiado", duration:"4h",
    notes:"Salida nocturna (horario orientativo), sujeta a clima y KP."
  });
  const out=rows.slice(); out.push(mk(d1)); if(d2) out.push(mk(d2));
  out.sort((a,b)=>(a.day-b.day)||(sortKeyMinutes(a)-sortKeyMinutes(b)));
  return out;
}
function relaxNextMorningIfAurora(byDay){
  const days=Object.keys(byDay).map(Number).sort((a,b)=>a-b);
  const aur= new Set(days.filter(d=>(byDay[d]||[]).some(r=>AURORA_RE.test(r.activity||""))));
  const MIN=toMinutes("10:30");
  for(const d of days){ if(!aur.has(d-1)) continue;
    const rs=byDay[d]; if(!rs?.length) continue;
    const first=Math.min(...rs.map(r=>toMinutes(r.start||"23:59")));
    if(first>=MIN) continue; const shift=MIN-first;
    for(const r of rs){ r.start=toHHMM(toMinutes(r.start||"00:00")+shift);
                        r.end  =toHHMM(toMinutes(r.end||r.start||"00:00")+shift); }
  }
}
function enforceAuroraCapGlobal(rows){
  const byDay=rows.reduce((a,r)=>((a[r.day]=a[r.day]||[]).push(r),a),{});
  const days=Object.keys(byDay).map(Number).sort((a,b)=>a-b);
  const stay=days.length, cap= stay>=5?2 : (stay>=3?1:1);
  let aur=days.filter(d=>(byDay[d]||[]).some(r=>AURORA_RE.test(r.activity||"")));
  aur.sort((a,b)=>a-b);
  for(let i=1;i<aur.length;i++){
    if(aur[i]===aur[i-1]+1){
      byDay[aur[i]]= (byDay[aur[i]]||[]).filter(r=>!AURORA_RE.test(r.activity||""));
    }
  }
  aur=days.filter(d=>(byDay[d]||[]).some(r=>AURORA_RE.test(r.activity||"")));
  if(aur.length===1 && aur[0]===days[days.length-1]){
    const last=days[days.length-1];
    byDay[last]=(byDay[last]||[]).filter(r=>!AURORA_RE.test(r.activity||""));
  }
  aur=days.filter(d=>(byDay[d]||[]).some(r=>AURORA_RE.test(r.activity||"")));
  if(aur.length>cap){
    const keep=aur.slice(0,cap);
    for(const d of aur){ if(!keep.includes(d)) byDay[d]=(byDay[d]||[]).filter(r=>!AURORA_RE.test(r.activity||"")); }
  }
  const merged=[]; days.forEach(d=>(byDay[d]||[]).forEach(r=>merged.push(r)));
  return merged;
}
function ensureAtLeastOneRow(destination, rows=[]){
  if(Array.isArray(rows) && rows.length>0) return rows;
  return [{
    day:1, start:"09:30", end:"11:00",
    activity:`Centro histórico de ${destination}`, from:destination, to:destination,
    transport:"A pie", duration:"1h 30m",
    notes:"Recorrido base por los imprescindibles cercanos para iniciar el día."
  }];
}

/* ───────────── Normalización integral ───────────── */
function normalizeParsed(parsed){
  if(!parsed || typeof parsed!=="object") return null;
  if(!parsed.rows && Array.isArray(parsed.destinations)){
    const first=parsed.destinations.find(d=>Array.isArray(d.rows)&&d.rows.length);
    if(first){ parsed={ destination:first.name||first.city||first.destination||"Destino",
      rows:first.rows, followup: parsed.followup||"", replace: parsed.replace??false }; }
  }
  if(!Array.isArray(parsed.rows)) return null;
  if(typeof parsed.replace==="undefined") parsed.replace=false;

  // Copia para guardas de vaciado
  const originalRows = parsed.rows.map(r=>({...r}));

  let rows = parsed.rows.map((r, idx)=>{
    const dayNum = Number.isFinite(+r.day) && +r.day>0 ? +r.day : 1+(idx%7);
    const start = (r.start||"").toString().trim() || "09:00";
    const endRaw = (r.end||"").toString().trim() || "";
    const activity = (r.activity||"").toString().trim() || "Actividad";

    let transport = ((r.transport||"").toString().trim());
    transport = normalizeTransportTrip(activity, (r.to||"").toString(), transport);

    const base = {
      day:dayNum, start, end:endRaw||"", activity,
      from:(r.from||"").toString(), to:(r.to||"").toString(),
      transport, duration:(r.duration||"").toString(),
      notes:(r.notes||"").toString() || "Una parada ideal para disfrutar.",
    };
    const s=toMinutes(base.start), e=endRaw?toMinutes(endRaw):null;
    if(e===null || e<=s){
      const dur = AURORA_RE.test(activity) ? 240 : 90;
      base.end = toHHMM(s+dur);
      if(!base.duration) base.duration = dur>=60 ? `${Math.floor(dur/60)}h${dur%60?` ${dur%60}m`:""}` : `${dur}m`;
    }
    return base;
  }).slice(0,180);

  // Guard 1: si la normalización dejó 0 filas, volver al original
  if(!rows.length) rows = originalRows.map(r=>({...r}));

  rows = rows.map(normalizeAuroraWindow);
  const dest = parsed.destination || "Ciudad";

  const byDay = rows.reduce((a,r)=>((a[r.day]=a[r.day]||[]).push(r),a),{});
  const merged = [];
  Object.keys(byDay).map(Number).sort((a,b)=>a-b).forEach(d=>{
    byDay[d].sort((a,b)=>sortKeyMinutes(a)-sortKeyMinutes(b));
    let fixed = byDay[d];
    fixed = ensureReturnToCity(dest, fixed);
    fixed = ensureEndReturnToHotel(fixed);
    fixed.sort((a,b)=>sortKeyMinutes(a)-sortKeyMinutes(b));
    fixed = pruneLeadingReturns(fixed);
    byDay[d]=fixed; merged.push(...fixed);
  });

  const byDay2 = merged.reduce((a,r)=>((a[r.day]=a[r.day]||[]).push(r),a),{});
  relaxNextMorningIfAurora(byDay2);

  let afterRelax=[]; Object.keys(byDay2).map(Number).sort((a,b)=>a-b).forEach(d=>{
    byDay2[d].sort((a,b)=>sortKeyMinutes(a)-sortKeyMinutes(b));
    byDay2[d] = pruneLeadingReturns(byDay2[d]);
    afterRelax.push(...byDay2[d]);
  });

  let withAuroras = injectAuroraIfMissing(dest, afterRelax);
  withAuroras = enforceAuroraCapGlobal(withAuroras);
  withAuroras = dedupeRows(withAuroras);

  // Guard 2: nunca devolver 0 filas tras post-procesos
  if(!withAuroras.length) withAuroras = ensureAtLeastOneRow(dest, merged.length?merged:originalRows);

  withAuroras.sort((a,b)=>(a.day-b.day)||(sortKeyMinutes(a)-sortKeyMinutes(b)));
  parsed.rows = withAuroras;
  if (typeof parsed.followup !== "string") parsed.followup = "";
  return parsed;
}

/* ───────────── Prompt del agente ───────────── */
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes de ITravelByMyOwn.
Devuelve **EXCLUSIVAMENTE un JSON válido**.

Formatos válidos:
B) {"destination":"City","rows":[{...}],"followup":"texto breve","replace":false}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

Reglas globales:
- Siempre al menos 1 actividad en "rows". Nada de texto fuera del JSON.
- Horarios realistas; puedes cruzar medianoche si aporta valor. Cenas opcionales.
- Máx. 20 actividades por día. Sin "seed" ni campos vacíos.
- En day-trips usa el formato “Ruta — Subparada” y propone ≥3 subparadas cuando aplique.
- Prioriza imperdibles urbanos antes de asignar day-trips (analiza y resume decisión en "followup").

Auroras (si aplica por latitud/temporada):
- 4h entre 18:00–01:00, evita noches consecutivas y que la única sea la última.
- Si hay auroras, al día siguiente inicia ≥10:30 y plan urbano/cercano.
- Cierra cada día con "Regreso a hotel"; si hubo salida, agrega antes "Regreso a <Ciudad base>".
`.trim();

/* ───────────── Responses API (JSON forzado + retrys) ───────────── */
const toResponsesMessages = arr => arr.map(m=>({ role:m.role, content:[{type:"text", text:String(m.content??"")}] }));
const wait = ms => new Promise(r=>setTimeout(r,ms));
async function callStructured(messages, temperature=0.3){
  const inputMsgs = toResponsesMessages(messages);
  let lastErr=null;
  for(let attempt=1; attempt<=3; attempt++){
    try{
      const resp = await client.responses.create({
        model:"gpt-4o-mini",
        temperature,
        modalities:["text"],
        response_format:{ type:"json_object" },
        input: inputMsgs,
        max_output_tokens: 3200,
      });
      const text = resp?.output_text?.trim() || resp?.output?.[0]?.content?.[0]?.text?.trim() || "";
      if(!text) throw new Error("empty-output");
      return text;
    }catch(err){ lastErr=err; await wait(attempt===1?250:600); }
  }
  throw lastErr||new Error("responses-create-failed");
}

/* ───────────── Handler ESM ───────────── */
export default async function handler(req, res){
  try{
    if(req.method!=="POST") return res.status(405).json({ error:"Method not allowed" });

    const body = safeGetBody(req);
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    if(mode==="info"){
      try{
        const r = await client.responses.create({
          model:"gpt-4o-mini",
          temperature:0.35,
          modalities:["text"],
          input: toResponsesMessages(clientMessages),
          max_output_tokens: 1500,
        });
        const text = r?.output_text?.trim() || r?.output?.[0]?.content?.[0]?.text?.trim() || "⚠️ Sin respuesta.";
        return res.status(200).json({ text });
      }catch(e){
        console.error("info mode error:", e?.message||e);
        return res.status(200).json({ text: JSON.stringify(fallbackJSON("info-mode-error")) });
      }
    }

    // ---- Intento 1
    let raw = await callStructured([{ role:"system", content:SYSTEM_PROMPT }, ...clientMessages], 0.3);
    let parsed = normalizeParsed(cleanToJSON(raw));

    // ---- Intento 2: refuerzo
    const ok = parsed && Array.isArray(parsed.rows) && parsed.rows.length>0;
    if(!ok){
      const strict = SYSTEM_PROMPT + `

OBLIGATORIO: Devuelve al menos 1 fila en "rows". SOLO JSON.`;
      raw = await callStructured([{ role:"system", content:strict }, ...clientMessages], 0.2);
      parsed = normalizeParsed(cleanToJSON(raw));
    }

    // ---- Intento 3: plantilla mínima
    const stillNo = !parsed || !Array.isArray(parsed.rows) || parsed.rows.length===0;
    if(stillNo){
      const ultra = SYSTEM_PROMPT + `
{"destination":"CITY","rows":[{"day":1,"start":"09:30","end":"11:00","activity":"Paseo urbano","from":"CITY","to":"CITY","transport":"A pie","duration":"90m","notes":"Explora un rincón único de la ciudad"}],"replace":false}`;
      raw = await callStructured([{ role:"system", content: ultra }, ...clientMessages], 0.15);
      parsed = normalizeParsed(cleanToJSON(raw));
    }

    if(!parsed) parsed = fallbackJSON("no-parse-after-3-attempts");

    return res.status(200).json({ text: JSON.stringify(parsed) });
  }catch(err){
    console.error("❌ /api/chat fatal error:", err?.message||err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON(err?.message||"unknown-error")) });
  }
}
