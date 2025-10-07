/* ============================================================================
 * ITRAVELBYMYOWN — PLANNER CHAT ENGINE (CLIENT) — PARTE 1/3 (CORREGIDA)
 * Usa SIEMPRE el estado del puente (window.__planner.state) y parchea vía
 * window.__planner.statePatch para no romper la estructura Cities & Days.
 * ==========================================================================*/

(function () {
  "use strict";

  const log = (...a) => console.log("[planner-chat.js]", ...a);
  const warn = (...a) => console.warn("[planner-chat.js]", ...a);
  const err  = (...a) => console.error("[planner-chat.js]", ...a);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function waitForBridge(maxMs = 8000) {
    const t0 = Date.now();
    while (
      !window.__planner ||
      !window.__planner.dom ||
      !window.__planner.api ||
      !window.__planner.ui
    ) {
      if (Date.now() - t0 > maxMs) throw new Error("window.__planner no disponible");
      await sleep(50);
    }
    return window.__planner;
  }

  (async function boot() {
    const P = await waitForBridge();

    // DOM del puente
    const { $send, $intake } = P.dom || {};
    if (!$send || !$intake) warn("No se encontraron $send/$intake en P.dom (revisa IDs en Webflow).");

    // Helpers del puente
    const {
      qs, qsa, normalize, extractInt, parseTimesFromText, updateSavedDays
    } = P.helpers || {};
    const {
      callAgent: callAgentFromBridge,
      parseJSON: parseJSONFromBridge,
      getItineraryContext, getCityMetaContext,
      generateCityItinerary, applyParsedToState, ensureDays, upsertCityMeta
    } = P.api || {};
    const {
      renderCityTabs, renderCityItinerary, msg, askForNextCityMeta, maybeGenerateAllCities
    } = P.ui || {};

    // ====== Acceso SEGURO al estado del puente ======
    const getState = () => (P.state || {});
    const patchState = (patch) => { P.statePatch = patch || {}; };

    function setFlag(key, value) { patchState({ [key]: value }); }
    function setActiveCity(city)  { patchState({ activeCity: city }); }

    // ====== Llamada al agente (fallback a endpoints si el puente no expone callAgent) ======
    const FALLBACK_ENDPOINTS = ["/api/planner-chat", "/api/chat"];
    async function callAgent(promptOrPayload) {
      if (typeof callAgentFromBridge === "function") {
        return await callAgentFromBridge(promptOrPayload);
      }
      const S = getState();
      const context = {
        activeCityId: S.activeCity || (S.savedDestinations?.[0]?.city || null),
        activeDayIndex: 0,
        itinerary: S.itineraries,
        preferences: { comfortOverAdventure: true, languages: ["es","en"], units: "metric" }
      };
      const body = JSON.stringify({
        message: typeof promptOrPayload === "string" ? promptOrPayload : (promptOrPayload?.message || ""),
        context,
        history: S.session || []
      });
      let lastError;
      for (const ep of FALLBACK_ENDPOINTS) {
        try {
          const r = await fetch(ep, { method:"POST", headers:{ "Content-Type":"application/json" }, body });
          if (r.ok) return await r.text();
          lastError = new Error("HTTP "+r.status);
        } catch(e){ lastError = e; }
      }
      throw lastError || new Error("No se pudo contactar al agente.");
    }

    function parseJSON(text){
      if (typeof parseJSONFromBridge === "function") {
        try { return parseJSONFromBridge(text); } catch {}
      }
      try { return JSON.parse(text); } catch { return null; }
    }

    // ====== Formatos requeridos ======
    const FORMAT = `
FORMATO JSON — B (parcial por día / ciudad):
{
  "destination": "<CIUDAD>",
  "day": <NÚMERO_DÍA>,
  "activities": [
    {
      "start": "HH:MM",
      "end": "HH:MM",
      "activity": "Texto",
      "from": "Origen/Vecindario",
      "to": "Destino/Spot",
      "transport": "A pie/Bus/Metro/etc.",
      "duration": "##min",
      "notes": "Texto corto opcional"
    }
  ],
  "followup": "Texto opcional"
}

FORMATO JSON — D (META POR CIUDAD):
{
  "meta": {
    "city": "<CIUDAD>",
    "baseDate": "DD/MM/YYYY",
    "start": "HH:MM" | ["HH:MM", ...],
    "end":   "HH:MM" | ["HH:MM", ...],
    "hotel": "Texto libre"
  }
}
`.trim();

    // ====== Helpers de NLU (idénticos a tu versión funcional) ======
    function userWantsReplace(text){
      const t=(text||'').toLowerCase();
      return /(sustituye|reemplaza|cambia todo|replace|overwrite|desde cero|todo nuevo)/i.test(t);
    }
    function isAcceptance(text){
      const t=(text||'').toLowerCase().trim();
      return /(^|\b)(ok|listo|esta bien|perfecto|de acuerdo|vale|sounds good|looks good|c’est bon|tout bon|beleza|ta bom)\b/.test(t);
    }
    function getDayScopeFromText(text){
      const m = text.match(/\bd[ií]a\s+(\d{1,2})\b/i);
      if (m) return Math.max(1, parseInt(m[1],10));
      if (/\b(ultimo|último)\s+d[ií]a\b/i.test(text)) return 'LAST';
      return null;
    }
    function resolveDayNumber(city, dayScope){
      const S = getState();
      if(dayScope === 'LAST'){
        const days = Object.keys(S.itineraries?.[city]?.byDay||{}).map(n=>parseInt(n,10));
        return days.length ? Math.max(...days) : 1;
      }
      return dayScope || null;
    }
    function extractRemovalKeyword(text){
      const clean = text.replace(/\ben el d[ií]a\s+\d+\b/ig,'').replace(/\bdel d[ií]a\s+\d+\b/ig,'');
      const p = /\b(?:no\s+(?:quiero|deseo)\s+|quita(?:r)?\s+|elimina(?:r)?\s+|remueve(?:r)?\s+|cancelar\s+)(.+)$/i.exec(clean);
      return p && p[1] ? p[1].trim() : null;
    }
    function hasAskForAlternative(text){
      const t = (text||'').toLowerCase();
      return /(otra|alternativa|sustituye|reemplaza|cambia por|pon otra|dame opciones|algo diferente|dame otro|sugiere)/i.test(t);
    }
    function normalizeActivityString(s){
      return (s||'').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
        .replace(/\s+/g,' ')
        .trim();
    }
    function removeActivityRows(city, dayOrNull, keyword){
      const S = getState();
      if(!S.itineraries?.[city] || !keyword) return 0;
      const kw = normalizeActivityString(keyword);
      const targetDays = dayOrNull ? [dayOrNull] : Object.keys(S.itineraries[city].byDay||{}).map(n=>parseInt(n,10));
      let removed = 0;
      targetDays.forEach(d=>{
        const rows = S.itineraries[city].byDay?.[d] || [];
        const before = rows.length;
        S.itineraries[city].byDay[d] = rows.filter(r => !normalizeActivityString(r.activity||'').includes(kw));
        removed += Math.max(0, before - (S.itineraries[city].byDay[d]||[]).length);
      });
      ensureDays(city);
      return removed;
    }
    function findCityInText(text){
      const t = normalize(text);
      const S = getState();
      for(const {city} of (S.savedDestinations||[])){
        if(t.includes(normalize(city))) return city;
      }
      return null;
    }

    // Exportar a las siguientes partes
    window.__plannerChatEngine = {
      P, FORMAT,
      // acceso al estado
      getState, patchState, setFlag, setActiveCity,
      // bridge helpers
      qs, qsa, normalize, extractInt, parseTimesFromText, updateSavedDays,
      callAgent, parseJSON, getItineraryContext, getCityMetaContext,
      generateCityItinerary, applyParsedToState, ensureDays, upsertCityMeta,
      renderCityTabs, renderCityItinerary, msg, askForNextCityMeta, maybeGenerateAllCities,
      // NLU helpers
      userWantsReplace, isAcceptance, getDayScopeFromText, resolveDayNumber,
      extractRemovalKeyword, hasAskForAlternative, normalizeActivityString,
      removeActivityRows, findCityInText,
      // DOM
      $send, $intake
    };

    log("Parte 1/3 cargada ✓");
  })();
/* ============================================================================
 * ITRAVELBYMYOWN — PLANNER CHAT ENGINE (CLIENT) — PARTE 2/3 (CORREGIDA)
 * Todas las lecturas/escrituras usan window.__planner.state / statePatch.
 * ==========================================================================*/

(function(){
  "use strict";
  if (!window.__plannerChatEngine) return console.error("Parte 1 no cargada.");

  const {
    getState, setActiveCity, ensureDays, renderCityTabs, renderCityItinerary,
    normalize, removeActivityRows
  } = window.__plannerChatEngine;

  function getVisibleDay(city){
    const btn = document.querySelector('.pager .active');
    if(btn && /^\d+$/.test(btn.textContent.trim())) return parseInt(btn.textContent.trim(),10);
    const S = getState();
    return S.itineraries?.[city]?.currentDay || 1;
    }

  function getDayRowsAsText(city, day){
    const S = getState();
    const rows = S.itineraries?.[city]?.byDay?.[day] || [];
    if(!rows.length) return "No hay actividades registradas.";
    return rows.map(r=>`De ${r.start} a ${r.end}: ${r.activity} (${r.from} → ${r.to}, ${r.transport}, ${r.duration}). Notas: ${r.notes}`).join("\n");
  }

  function getAllDaysContextAsText(city){
    const S = getState();
    const byDay = S.itineraries?.[city]?.byDay || {};
    const days = Object.keys(byDay).map(n=>parseInt(n,10)).sort((a,b)=>a-b);
    if(!days.length) return "Sin días aún.";
    return days.map(d=>{
      const rows = byDay[d]||[];
      if(!rows.length) return `Día ${d}: (vacío)`;
      const items = rows.map(r=>`• ${r.start}-${r.end} ${r.activity}`).join('\n');
      return `Día ${d}:\n${items}`;
    }).join('\n\n');
  }

  function reorderCityDays(city, newOrder){
    const S = getState();
    const old = S.itineraries?.[city]?.byDay || {};
    const days = Object.keys(old).map(n=>parseInt(n,10)).sort((a,b)=>a-b);
    if(newOrder.length !== days.length) return false;
    const unique = new Set(newOrder);
    if(unique.size !== newOrder.length) return false;
    if(!newOrder.every(n => days.includes(n))) return false;

    const newByDay = {};
    newOrder.forEach((srcDay, i)=>{
      const dstDay = i+1;
      newByDay[dstDay] = (old[srcDay] || []).map(r=>({...r, day:dstDay}));
    });
    S.itineraries[city].byDay = newByDay;
    S.itineraries[city].currentDay = 1;
    ensureDays(city);
    return true;
  }

  function swapDays(city, a, b){
    const S = getState();
    const byDay = S.itineraries?.[city]?.byDay || {};
    const A = byDay[a] || [];
    const B = byDay[b] || [];
    byDay[a] = (B||[]).map(r=>({...r, day:a}));
    byDay[b] = (A||[]).map(r=>({...r, day:b}));
    S.itineraries[city].byDay = byDay;
    ensureDays(city);
  }

  function parseReorderInstruction(text){
    const m1 = /reordena(?:r)?\s+los\s+d[ií]as\s+(?:como|a)\s+([\d,\s]+)/i.exec(text);
    if(m1){
      const arr = m1[1].split(/[, ]+/).filter(Boolean).map(n=>parseInt(n,10)).filter(n=>!isNaN(n));
      if(arr.length) return {type:'sequence', seq:arr};
    }
    const m2 = /(intercambia|swap|cambia)\s+(?:el\s+)?d[ií]a\s+(\d{1,2})\s+(?:y|con)\s+(?:el\s+)?d[ií]a\s+(\d{1,2})/i.exec(text);
    if(m2) return {type:'swap', a:parseInt(m2[2],10), b:parseInt(m2[3],10)};
    const m3 = /haz\s+(?:el\s+)?d[ií]a\s+(\d{1,2})\s+(?:primero|1º|1ro)/i.exec(text);
    if(m3) return {type:'makeFirst', day:parseInt(m3[1],10)};
    return null;
  }

  function parseMoveActivityInstruction(text){
    const m = /(mueve|pasa|lleva)\s+(?:la\s+|el\s+|los\s+|las\s+|\"?'?)(.+?)(?:\"?'?)\s+(?:al|para el)\s+d[ií]a\s+(\d{1,2})/i.exec(text);
    if(m) return {activity:m[2].trim(), toDay:parseInt(m[3],10)};
    const m2 = /(mueve|pasa|lleva)\s+(?:del|desde el)\s+d[ií]a\s+(\d{1,2})\s+(?:al|para el)\s+d[ií]a\s+(\d{1,2})/i.exec(text);
    if(m2) return {fromDay:parseInt(m2[2],10), toDay:parseInt(m2[3],10)};
    return null;
  }

  function addCityFromChat(name, days=1){
    const S = getState();
    const order = (S.savedDestinations?.length ? Math.max(...S.savedDestinations.map(x=>x.order)) + 1 : 1);
    S.savedDestinations.push({city:name, days:Math.max(1,days), order});
    if(!S.itineraries[name]) S.itineraries[name] = { byDay:{}, currentDay:1, baseDate:null };
    if(!S.cityMeta[name])   S.cityMeta[name] = { baseDate:null, start:null, end:null, hotel:'' };
    ensureDays(name);
    renderCityTabs();
    setActiveCity(name);
    renderCityItinerary(name);
  }

  function removeCityFromChat(name){
    const S = getState();
    const idx = S.savedDestinations.findIndex(x=>x.city===name);
    if(idx>=0) S.savedDestinations.splice(idx,1);
    delete S.itineraries[name];
    delete S.cityMeta[name];
    S.savedDestinations.forEach((x,i)=>x.order=i+1);
    renderCityTabs();
    setActiveCity(S.savedDestinations[0]?.city || null);
    const ac = getState().activeCity;
    if(ac) renderCityItinerary(ac);
  }

  function moveActivityBetweenDays(city, fromDayGuess, activityKw, toDay){
    const fromDay = fromDayGuess || null;
    return removeActivityRows(city, fromDay, activityKw);
  }

  async function checkAndGenerateMissing(){
    const S = getState();
    for(const {city} of (S.savedDestinations||[])){
      const m = S.cityMeta[city];
      const hasRows = Object.values(S.itineraries[city]?.byDay || {}).some(a => a.length > 0);
      if(typeof window.metaIsComplete === 'function' && window.metaIsComplete(m) && !hasRows){
        await window.__plannerChatEngine.generateCityItinerary(city);
      }
    }
  }

  // Exportar para Parte 3
  window.__plannerChatEngine_ext = {
    getVisibleDay, getDayRowsAsText, getAllDaysContextAsText,
    reorderCityDays, swapDays, parseReorderInstruction, parseMoveActivityInstruction,
    addCityFromChat, removeCityFromChat, moveActivityBetweenDays, checkAndGenerateMissing
  };

  console.log("[planner-chat.js] Parte 2/3 cargada ✓");
})();
/* ============================================================================
 * ITRAVELBYMYOWN — PLANNER CHAT ENGINE (CLIENT) — PARTE 3/3 (CORREGIDA)
 * Chat principal con lectura/escritura segura del estado del puente.
 * ==========================================================================*/

(function(){
  "use strict";
  if (!window.__plannerChatEngine || !window.__plannerChatEngine_ext) return console.error("Partes 1 y/o 2 no cargadas.");

  const {
    FORMAT, getState, setActiveCity,
    callAgent, parseJSON, getItineraryContext, getCityMetaContext,
    renderCityTabs, renderCityItinerary, msg, maybeGenerateAllCities,
    askForNextCityMeta, ensureDays, generateCityItinerary,
    extractInt, parseTimesFromText, normalize, updateSavedDays, applyParsedToState,
    $send, $intake
  } = window.__plannerChatEngine;

  const {
    getVisibleDay, getDayRowsAsText, getAllDaysContextAsText,
    reorderCityDays, swapDays, parseReorderInstruction, parseMoveActivityInstruction,
    addCityFromChat, removeCityFromChat, moveActivityBetweenDays, checkAndGenerateMissing
  } = window.__plannerChatEngine_ext;

  async function sendChat(){
    const S0 = getState();
    const text = ($intake?.value||'').trim();
    if(!text) return;
    msg(text,'user');
    if($intake) $intake.value='';

    // ===== Fase 1: Meta secuencial =====
    if(S0.collectingMeta){
      const S = getState();
      const city = S.savedDestinations[S.metaProgressIndex]?.city;
      if(!city){ window.__plannerChatEngine.P.statePatch = { collectingMeta:false }; await maybeGenerateAllCities(); return; }

      const extractPrompt = `
Extrae del texto la meta para la ciudad "${city}" en formato D del esquema:
${FORMAT}
Devuelve SOLO:
{"meta":{"city":"${city}","baseDate":"DD/MM/YYYY","start":"HH:MM" o ["HH:MM",...],"end":"HH:MM" o ["HH:MM",...],"hotel":"Texto"}}
Texto del usuario: ${text}`.trim();

      const answer = await callAgent(extractPrompt);
      const parsed = parseJSON(answer);

      if(parsed?.meta){
        applyParsedToState({ meta: parsed.meta }, true); // upsert meta
        window.__plannerChatEngine.P.statePatch = { awaitingMetaReply:false };
        msg(`Perfecto, tengo la información para ${city}.`);
        window.__plannerChatEngine.P.statePatch = { metaProgressIndex: S.metaProgressIndex + 1 };
        const S2 = getState();
        if(S2.metaProgressIndex < (S2.savedDestinations||[]).length){
          await askForNextCityMeta();
        }else{
          window.__plannerChatEngine.P.statePatch = { collectingMeta:false };
          msg('Perfecto 🎉 Ya tengo toda la información. Generando itinerarios...');
          await maybeGenerateAllCities();
        }
      }else{
        msg('No logré entender. ¿Podrías repetir la fecha del primer día, horarios y hotel/zona?');
      }
      return;
    }

    // ===== Fase 2: Edición libre/inteligente =====
    const tNorm = normalize(text);
    let handled = false;

    // Ciudad objetivo
    const S = getState();
    const cityFromText = (function(){
      const t = normalize(text);
      for(const {city} of (S.savedDestinations||[])){ if(t.includes(normalize(city))) return city; }
      return null;
    })();
    const workingCity = cityFromText || S.activeCity;
    if(cityFromText && cityFromText !== S.activeCity){
      setActiveCity(cityFromText);
      renderCityItinerary(cityFromText);
    }

    // (a) Agregar días
    if(/\b(agrega|añade|sumar?|add)\b.*\bd[ií]a/.test(tNorm) || /\b(un dia mas|1 dia mas)\b/.test(tNorm)){
      const addN = extractInt(tNorm) ?? 1;
      const hasActivity = /\b(tour|excursion|visita|museo|paseo|segovia|toledo|montserrat|catedral|parque|mercado|playa|ruta)\b/i.test(text);
      const activityDesc = hasActivity ? text : null;

      if(workingCity){
        const Sx = getState();
        const current = Sx.savedDestinations.find(x=>x.city===workingCity)?.days 
          || Object.keys(Sx.itineraries[workingCity]?.byDay||{}).length || 1;
        const newDays = current + addN;
        updateSavedDays(workingCity, newDays);
        ensureDays(workingCity);

        if(hasActivity){
          const prompt = `
${FORMAT}
Edita el itinerario de "${workingCity}" agregando ${addN} día${addN>1?'s':''}.
Incluye como actividad principal: "${activityDesc}" en el/los día(s) nuevo(s) y completa con otras actividades no repetidas.
No elimines días previos.
Devuelve SOLO JSON con "destination":"${workingCity}".`.trim();
          const ans = await callAgent(prompt);
          const parsed = parseJSON(ans);
          if(parsed){ applyParsedToState(parsed,false); }
        }else{
          await generateCityItinerary(workingCity);
        }

        renderCityTabs();
        setActiveCity(workingCity);
        renderCityItinerary(workingCity);
        msg(`He añadido ${addN} día${addN>1?'s':''} en ${workingCity}.`);
      }
      handled = true;
    }

    // (b) Quitar días
    if(!handled && (/\b(quita|elimina|remueve|remove)\b.*\bd[ií]a/.test(tNorm) || /\b(ultimo|último)\s+d[ií]a\b/i.test(tNorm))){
      const remN = /\b\d+\b/.test(tNorm) ? extractInt(tNorm) : 1;
      const targetCity = workingCity;
      if(targetCity){
        const Sx = getState();
        const current = Sx.savedDestinations.find(x=>x.city===targetCity)?.days 
          || Object.keys(Sx.itineraries[targetCity]?.byDay||{}).length || 1;
        const newDays = Math.max(1, current - remN);
        updateSavedDays(targetCity, newDays);
        const keys = Object.keys(Sx.itineraries[targetCity]?.byDay||{}).map(d=>parseInt(d,10)).sort((a,b)=>b-a);
        keys.slice(0,remN).forEach(k=>delete Sx.itineraries[targetCity].byDay[k]);
        ensureDays(targetCity);
        renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
        msg(`He quitado ${remN} día${remN>1?'s':''} en ${targetCity}.`);
      }
      handled = true;
    }

    // (c) Sustitución / eliminación de actividades
    if(!handled && /(no\s+(?:quiero|deseo)|quita|elimina|remueve|cancelar|sustituye|reemplaza|cambia)/i.test(text)){
      const targetCity = workingCity;
      if(targetCity){
        const mSwap = /(sustituye|reemplaza|cambia)\s+(?:el\s+)?(.+?)\s+por\s+(.+?)(?:$|\.|,)/i.exec(text);
        const dayScopeRaw = window.__plannerChatEngine.getDayScopeFromText(text);
        const dayN = window.__plannerChatEngine.resolveDayNumber(targetCity, dayScopeRaw);

        if(mSwap){
          const oldK = mSwap[2].trim();
          const newK = mSwap[3].trim();
          const removed = window.__plannerChatEngine.removeActivityRows(targetCity, dayN, oldK);

          const swapPrompt = `
${FORMAT}
En "${targetCity}" ${dayN?`(día ${dayN})`:''} elimina "${oldK}" y sustitúyelo por actividades basadas en "${newK}".
Mantén coherencia de horarios y no repitas con lo ya existente.
Devuelve SOLO JSON formato B con "destination":"${targetCity}".`.trim();
          const ans = await callAgent(swapPrompt);
          const parsed = parseJSON(ans);
          if(parsed){
            applyParsedToState(parsed,false);
            renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
            msg(removed>0?`Sustituí "${oldK}" por "${newK}" en ${targetCity}.`:`Añadí actividades de "${newK}" en ${targetCity}.`,'ai');
          }else{
            msg(`Eliminé "${oldK}". ¿Qué tipo de actividad quieres en su lugar?`,'ai');
          }
          handled = true;
        }else{
          const keyword = window.__plannerChatEngine.extractRemovalKeyword(text);
          if(keyword){
            const removed = window.__plannerChatEngine.removeActivityRows(targetCity, dayN, keyword);
            renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);

            if(removed>0 && window.__plannerChatEngine.hasAskForAlternative(text)){
              const altPrompt = `
${FORMAT}
En "${targetCity}" ${dayN?`(día ${dayN})`:''} el usuario quitó "${keyword}".
Propón y añade nuevas actividades coherentes (sin repetir otras del mismo día).
Devuelve SOLO JSON formato B con "destination":"${targetCity}".`.trim();
              const ans = await callAgent(altPrompt);
              const parsed = parseJSON(ans);
              if(parsed){
                applyParsedToState(parsed,false);
                renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
                msg(`He sustituido "${keyword}" por nuevas actividades en ${targetCity}.`,'ai');
              }else{
                msg(`He eliminado "${keyword}". Puedo sugerir alternativas si me dices el tipo que prefieres.`,'ai');
              }
            }else{
              msg(removed>0?`He eliminado "${keyword}" ${dayN?`del día ${dayN}`:''} en ${targetCity}.`:`No encontré "${keyword}" ${dayN?`en el día ${dayN}`:''}.`,'ai');
            }
            handled = true;
          }
        }
      }
    }

    // (d) Detallar/optimizar día
    if(!handled && /\b(detalla|mas detalle|más detalle|expande|amplia|amplía|describe mejor|dame mas info|hazlo mas preciso|optimiza|reorganiza|mejora flujo)\b/i.test(text)){
      const targetCity = workingCity;
      if(targetCity){
        const dayScopeRaw = window.__plannerChatEngine.getDayScopeFromText(text);
        const dayN = window.__plannerChatEngine.resolveDayNumber(targetCity, dayScopeRaw) || getVisibleDay(targetCity);
        const currentDayContext = getDayRowsAsText(targetCity, dayN);
        const allDaysContext = getAllDaysContextAsText(targetCity);
        const detailPrompt = `
${FORMAT}
El usuario desea optimizar y detallar el DÍA ${dayN} en "${targetCity}".
Contexto del día ${dayN}:
${currentDayContext}

Resumen de otros días en "${targetCity}" (evita repetir):
${allDaysContext}

Tareas:
- Mejora flujo, ajusta horarios/transportes, añade detalles y llena huecos.
- Evita duplicar actividades de otros días de la misma ciudad.
- Mantén cambios SOLO en el día ${dayN}.
Devuelve SOLO JSON formato B con "destination":"${targetCity}".`.trim();
        const ans = await callAgent(detailPrompt);
        const parsed = parseJSON(ans);
        if(parsed){
          applyParsedToState(parsed,false);
          renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
          msg(`He optimizado y detallado el día ${dayN} en ${targetCity}.`,'ai');
        }else msg('No pude optimizar el flujo.','ai');
      }
      handled = true;
    }

    // (e) Ajuste de horas (meta)
    if(!handled && /\b(hora|horario|inicio|fin|empieza|termina|ajusta|cambia)\b/.test(tNorm)){
      const times = parseTimesFromText(text);
      const targetCity = workingCity;
      if(targetCity && times.length){
        const Sx = getState();
        Sx.cityMeta[targetCity] = Sx.cityMeta[targetCity] || { baseDate:null, start:null, end:null, hotel:'' };
        if(times.length === 1){
          if(/\b(hasta|termina|fin)\b/.test(tNorm)) Sx.cityMeta[targetCity].end = times[0];
          else Sx.cityMeta[targetCity].start = times[0];
        }else{
          Sx.cityMeta[targetCity].start = times[0];
          Sx.cityMeta[targetCity].end = times[times.length-1];
        }
        await generateCityItinerary(targetCity);
        renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
        msg(`He ajustado las horas en ${targetCity}.`);
      }
      handled = true;
    }

    // (f) Reordenar / swap días
    if(!handled){
      const ro = parseReorderInstruction(text);
      if(ro && workingCity){
        if(ro.type==='sequence'){
          const ok = reorderCityDays(workingCity, ro.seq);
          if(ok){
            renderCityTabs(); setActiveCity(workingCity); renderCityItinerary(workingCity);
            msg(`He reordenado los días en ${workingCity} como ${ro.seq.join(', ')} → 1..${ro.seq.length}.`);
          }else{
            msg('No pude reordenar: la secuencia no coincide con el número de días.','ai');
          }
        }else if(ro.type==='swap'){
          swapDays(workingCity, ro.a, ro.b);
          renderCityTabs(); setActiveCity(workingCity); renderCityItinerary(workingCity);
          msg(`He intercambiado el día ${ro.a} con el día ${ro.b} en ${workingCity}.`);
        }else if(ro.type==='makeFirst'){
          const Sx = getState();
          const byDay = Sx.itineraries[workingCity]?.byDay || {};
          const days = Object.keys(byDay).map(n=>parseInt(n,10)).sort((a,b)=>a-b);
          const seq = [ro.day, ...days.filter(d=>d!==ro.day)];
          const ok = reorderCityDays(workingCity, seq);
          if(ok){
            renderCityTabs(); setActiveCity(workingCity); renderCityItinerary(workingCity);
            msg(`He puesto el día ${ro.day} como primero en ${workingCity}.`);
          }
        }
        handled = true;
      }
    }

    // (g) Mover actividad entre días
    if(!handled){
      const mv = parseMoveActivityInstruction(text);
      if(mv && workingCity){
        const currentDay = getVisibleDay(workingCity);
        const toDay = mv.toDay || currentDay;
        let fromDay = mv.fromDay || null;
        let act = mv.activity || null;
        if(!act){
          const kw = window.__plannerChatEngine.extractRemovalKeyword(text);
          if(kw) act = kw;
        }
        if(!act) act = 'actividad seleccionada';

        moveActivityBetweenDays(workingCity, fromDay, act, toDay);
        const prompt = `
${FORMAT}
En "${workingCity}" mueve "${act}" al día ${toDay}.
- Reubica horarios en el día ${toDay} y optimiza la secuencia (transportes/duraciones realistas).
- Evita duplicar actividades ya planificadas en otros días de la misma ciudad.
- Si la actividad no existía, interprétala y añádela como equivalente.
Devuelve SOLO JSON formato B con "destination":"${workingCity}" (solo cambios del día ${toDay}).`.trim();
        const ans = await callAgent(prompt);
        const parsed = parseJSON(ans);
        if(parsed){
          applyParsedToState(parsed,false);
          renderCityTabs(); setActiveCity(workingCity); renderCityItinerary(workingCity);
          msg(`He movido "${act}" al día ${toDay} en ${workingCity} y ajustado los horarios.`, 'ai');
        }else{
          renderCityTabs(); setActiveCity(workingCity); renderCityItinerary(workingCity);
          msg(`He quitado "${act}" del día origen. ¿Deseas qué haga exactamente en el día ${toDay}?`, 'ai');
        }
        handled = true;
      }
    }

    // (h) Replantear / recalcular
    if(!handled && /(replantea|vuelve a plantear|nuevo plan|desde cero|reset(?:ea)?|comienza de nuevo|hazlo de nuevo)\b/i.test(tNorm)){
      const targetCity = workingCity;
      if(targetCity){
        const Sx = getState();
        Sx.itineraries[targetCity].byDay = {};
        await generateCityItinerary(targetCity);
        renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
        msg(`He replanteado por completo el itinerario de ${targetCity}.`);
      }
      handled = true;
    }

    if(!handled && /\b(recalcula|replanifica|recompute|replan|recalculate|actualiza|regen)\b/.test(tNorm)){
      const targetCity = workingCity;
      if(targetCity){
        await generateCityItinerary(targetCity);
        renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
        msg(`He recalculado el itinerario de ${targetCity}.`);
      }
      handled = true;
    }

    if(handled){ await checkAndGenerateMissing(); return; }

    // (i) Alta/Baja de ciudades — si no se activó antes
    const mAddCity = /(agrega|añade|add)\s+([a-záéíóúñ\s]+?)(?:\s+(\d{1,2})\s+d[ií]as?)?$/i.exec(text);
    if(mAddCity){
      const cityName = mAddCity[2].trim().replace(/\s+/g,' ').replace(/^\w/,c=>c.toUpperCase());
      const days = mAddCity[3] ? parseInt(mAddCity[3],10) : 1;
      addCityFromChat(cityName, days);
      msg(`He agregado **${cityName}** con ${days} día(s). Comparte la fecha del primer día (DD/MM/AAAA), horas de inicio/fin y hotel/zona para generar el itinerario.`);
      window.__plannerChatEngine.P.statePatch = { collectingMeta:true, metaProgressIndex: getState().savedDestinations.findIndex(x=>x.city===cityName), awaitingMetaReply:false };
      await askForNextCityMeta();
      await checkAndGenerateMissing();
      return;
    }

    const mRemCity = /(elimina|quita|remueve)\s+(?:la\s+ciudad\s+)?([a-záéíóúñ\s]+)$/i.exec(text);
    if(mRemCity){
      const cityName = mRemCity[2].trim().replace(/\s+/g,' ').replace(/^\w/,c=>c.toUpperCase());
      removeCityFromChat(cityName);
      msg(`He eliminado la ciudad **${cityName}**.`);
      await checkAndGenerateMissing();
      return;
    }

    // (j) Fallback inteligente (día visible)
    const S3 = getState();
    (S3.session||S3.session===[] ? S3.session : (S3.session=[])).push({role:'user', content:text});
    const targetCity = workingCity || S3.activeCity;
    const currentDay = getVisibleDay(targetCity);
    const currentDayContext = getDayRowsAsText(targetCity, currentDay);
    const allDaysContext = getAllDaysContextAsText(targetCity);
    const prompt = `
${FORMAT}
El usuario está viendo "${targetCity}", DÍA ${currentDay}.
Actividades actuales del día ${currentDay}:
${currentDayContext}

Resumen de otros días (no repitas):
${allDaysContext}

Interpreta su solicitud y:
- Ajusta/añade/eliminas actividades solo en el día ${currentDay}.
- Reorganiza horarios, evita solapes y dupes, y rellena huecos con opciones coherentes.
Devuelve SOLO JSON formato B con "destination":"${targetCity}" (solo cambios del día ${currentDay}).`.trim();

    try{
      const ans = await callAgent(prompt);
      const parsed = parseJSON(ans);
      if(parsed){
        applyParsedToState(parsed,false);
        renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
        msg(parsed.followup || 'He aplicado los cambios y optimizado el día. ¿Quieres otro ajuste?','ai');
      }else{
        msg(ans || 'Listo. ¿Otra cosa?','ai');
      }
      await checkAndGenerateMissing();
    }catch(e){
      console.error(e);
      msg('❌ Error de conexión.','ai');
    }
  }

  if($send)   $send.addEventListener('click', sendChat);
  if($intake) $intake.addEventListener('keydown',(e)=>{ if(e.key==='Enter'){ e.preventDefault(); sendChat(); } });

  console.log("[planner-chat.js] Parte 3/3 cargada ✓ — Motor de chat listo");
})();
