/* ============================================================
   /public/planner-chat.js — Motor externo (v9, estable)
   - Estado en vivo desde window.__planner (puente)
   - Lógica de recopilación de meta y edición restaurada
   - Sin dependencias privadas del core (FORMAT, setActiveCity)
   ============================================================ */

(function () {
  'use strict';

  const PL = window.__planner;
  if (!PL) {
    console.error('❌ Planner bridge not found (window.__planner). Revisa el puente en Webflow.');
    return;
  }

  // --- ACCESOS CÓMODOS ---
  const ST = () => PL.state;                // snapshot vivo
  const patch = (p) => { try { PL.statePatch && PL.statePatch(p); } catch {} };

  // DOM (nodos vivos desde el puente — NO harcodeamos IDs)
  function getDom() {
    const d = (PL.dom || {});
    // fallback por si faltasen (solo como red de seguridad)
    const $intake = d.$intake || document.querySelector('#chat-input') || document.querySelector('input[type="text"][name="chat"]') || null;
    const $send   = d.$send   || document.querySelector('#chat-send')   || document.querySelector('button[type="submit"]') || null;
    return { $intake, $send, $tabs: d.$tabs, $itineraryWrap: d.$itineraryWrap, $chatM: d.$chatM, $chatC: d.$chatC };
  }

  // Helpers publicados por el puente
  const H = PL.helpers || {};
  const A = PL.api     || {};
  const UI = PL.ui     || {};

  const {
    normalize: normBase,              // ya la publicas en el puente
    extractInt,
    parseTimesFromText,
    updateSavedDays
  } = H;

  const {
    callAgent,
    parseJSON,
    getItineraryContext,
    getCityMetaContext,
    generateCityItinerary,
    applyParsedToState,
    ensureDays,
    upsertCityMeta
  } = A;

  const {
    renderCityTabs,
    renderCityItinerary,
    msg,
    askForNextCityMeta,
    maybeGenerateAllCities
  } = UI;

  const setActiveCity = (window.setActiveCity || (c => patch({ activeCity: c })));

  // ===== Helpers de NLU y edición (sección 14 original) =====
  function userWantsReplace(text){
    const t=(text||'').toLowerCase();
    return /(sustituye|reemplaza|cambia todo|replace|overwrite|desde cero|todo nuevo)/i.test(t);
  }
  function isAcceptance(text){
    const t=(text||'').toLowerCase().trim();
    return /(^|\b)(ok|listo|esta bien|perfecto|de acuerdo|vale|sounds good|looks good|c’est bon|tout bon|beleza|ta bom)\b/.test(t);
  }
  function normalize(t){ return normBase ? normBase(t) : (t||'').toLowerCase(); }

  function getDayScopeFromText(text){
    const m = text.match(/\bd[ií]a\s+(\d{1,2})\b/i);
    if (m) return Math.max(1, parseInt(m[1],10));
    if (/\b(ultimo|último)\s+d[ií]a\b/i.test(text)) return 'LAST';
    return null;
  }
  function extractRemovalKeyword(text){
    const clean = text.replace(/\ben el d[ií]a\s+\d+\b/ig,'').replace(/\bdel d[ií]a\s+\d+\b/ig,'');
    const p = /\b(?:no\s+(?:quiero|deseo)\s+|quita(?:r)?\s+|elimina(?:r)?\s+|remueve(?:r)?\s+|cancelar\s+)(.+)$/i.exec(clean);
    return p && p[1] ? p[1].trim() : null;
  }
  function hasAskForAlternative(text){
    const t = text.toLowerCase();
    return /(otra|alternativa|sustituye|reemplaza|cambia por|pon otra|dame opciones|algo diferente|dame otro|sugiere)/i.test(t);
  }
  function normalizeActivityString(s){
    return (s||'').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .replace(/\s+/g,' ')
      .trim();
  }
  function removeActivityRows(city, dayOrNull, keyword){
    const { itineraries } = ST();
    if(!itineraries[city] || !keyword) return 0;
    const kw = normalizeActivityString(keyword);
    const targetDays = dayOrNull ? [dayOrNull] : Object.keys(itineraries[city].byDay||{}).map(n=>parseInt(n,10));
    let removed = 0;
    targetDays.forEach(d=>{
      const rows = itineraries[city].byDay?.[d] || [];
      const before = rows.length;
      itineraries[city].byDay[d] = rows.filter(r => !normalizeActivityString(r.activity||'').includes(kw));
      removed += Math.max(0, before - (itineraries[city].byDay[d]||[]).length);
    });
    ensureDays(city);
    return removed;
  }
  function findCityInText(text){
    const t = normalize(text);
    const { savedDestinations } = ST();
    for(const {city} of savedDestinations){
      if(t.includes(normalize(city))) return city;
    }
    return null;
  }
  function resolveDayNumber(city, dayScope){
    const { itineraries } = ST();
    if(dayScope === 'LAST'){
      const days = Object.keys(itineraries[city]?.byDay||{}).map(n=>parseInt(n,10));
      return days.length ? Math.max(...days) : 1;
    }
    return dayScope || null;
  }

  async function checkAndGenerateMissing(){
    const { savedDestinations, cityMeta, itineraries } = ST();
    for(const {city} of savedDestinations){
      const m = cityMeta[city];
      const hasRows = Object.values(itineraries[city]?.byDay || {}).some(a => a.length > 0);
      if(typeof window.metaIsComplete === 'function' && window.metaIsComplete(m) && !hasRows){
        await generateCityItinerary(city);
      }
    }
  }

  // ===== Chat principal (sección 14 funcional) =====
  async function sendChat(){
    const { $intake } = getDom();
    const text = ($intake?.value||'').trim();
    if(!text) return;

    msg(text,'user');
    if ($intake) $intake.value='';

    const { collectingMeta, metaProgressIndex, savedDestinations, activeCity, cityMeta, itineraries } = ST();

    // ======= Fase 1: recopilación secuencial de meta =======
    if(collectingMeta){
      const city = savedDestinations[metaProgressIndex]?.city;
      if(!city){ patch({collectingMeta:false}); await maybeGenerateAllCities(); return; }

      const extractPrompt = `
Extrae del texto la meta para la ciudad "${city}" en formato D del esquema:
${typeof FORMAT!=='undefined'?FORMAT:''}
Devuelve SOLO:
{"meta":{"city":"${city}","baseDate":"DD/MM/YYYY","start":"HH:MM" o ["HH:MM",...],"end":"HH:MM" o ["HH:MM",...],"hotel":"Texto"}}
Texto del usuario: ${text}`.trim();

      const answer = await callAgent(extractPrompt);
      const parsed = parseJSON(answer);

      if(parsed?.meta){
        upsertCityMeta(parsed.meta);
        patch({ awaitingMetaReply:false });
        msg(`Perfecto, tengo la información para ${city}.`);
        const nextIndex = metaProgressIndex + 1;
        patch({ metaProgressIndex: nextIndex });
        if(nextIndex < savedDestinations.length){
          await askForNextCityMeta();
        }else{
          patch({ collectingMeta:false });
          msg('Perfecto 🎉 Ya tengo toda la información. Generando itinerarios...');
          await maybeGenerateAllCities();
        }
      }else{
        msg('No logré entender. ¿Podrías repetir la fecha del primer día, horarios y hotel/zona?');
      }
      return;
    }

    // ======= Fase 2: conversación normal =======
    const tNorm = normalize(text);
    let handled = false;

    // Detectar ciudad mencionada y hacerla activa
    const cityFromText = findCityInText(text);
    const workingCity = cityFromText || activeCity;
    if(cityFromText && cityFromText !== activeCity){
      setActiveCity(cityFromText);
      renderCityItinerary(cityFromText);
    }

    // --- a) Agregar días ---
    if(/\b(agrega|añade|sumar?|add)\b.*\bd[ií]a/.test(tNorm) || /\b(un dia mas|1 dia mas)\b/.test(tNorm)){
      const addN = extractInt(tNorm);
      const hasActivity = /\b(tour|excursion|visita|museo|paseo|segovia|toledo|montserrat|catedral|parque|mercado|playa|ruta)\b/i.test(text);
      const activityDesc = hasActivity ? text : null;

      if(workingCity){
        const current = savedDestinations.find(x=>x.city===workingCity)?.days 
          || Object.keys(itineraries[workingCity]?.byDay||{}).length || 1;
        const newDays = current + addN;
        updateSavedDays(workingCity,newDays);
        ensureDays(workingCity);

        if(hasActivity){
          const prompt = `
${typeof FORMAT!=='undefined'?FORMAT:''}
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

    // --- b) Quitar días (incluye "el último día de X") ---
    if(!handled && (/\b(quita|elimina|remueve|remove)\b.*\bd[ií]a/.test(tNorm) || /\b(ultimo|último)\s+d[ií]a\b/i.test(tNorm))){
      const remN = /\b\d+\b/.test(tNorm) ? extractInt(tNorm) : 1;
      const targetCity = workingCity;
      if(targetCity){
        const current = savedDestinations.find(x=>x.city===targetCity)?.days 
          || Object.keys(itineraries[targetCity]?.byDay||{}).length || 1;
        const newDays = Math.max(1, current - remN);
        updateSavedDays(targetCity,newDays);
        const keys = Object.keys(itineraries[targetCity]?.byDay||{}).map(d=>parseInt(d,10)).sort((a,b)=>b-a);
        keys.slice(0,remN).forEach(k=>delete itineraries[targetCity].byDay[k]);
        ensureDays(targetCity);
        renderCityTabs();
        setActiveCity(targetCity);
        renderCityItinerary(targetCity);
        msg(`He quitado ${remN} día${remN>1?'s':''} en ${targetCity}.`);
      }
      handled = true;
    }

    // --- c) Eliminar / sustituir actividades (día específico opcional) ---
    if(!handled && /(no\s+(?:quiero|deseo)|quita|elimina|remueve|cancelar|sustituye|reemplaza|cambia)/i.test(text)){
      const targetCity = workingCity;
      if(targetCity){
        const mSwap = /(sustituye|reemplaza|cambia)\s+(?:el\s+)?(.+?)\s+por\s+(.+?)(?:$|\.|,)/i.exec(text);
        const dayScopeRaw = getDayScopeFromText(text);
        const dayN = resolveDayNumber(targetCity, dayScopeRaw);

        if(mSwap){
          const oldK = mSwap[2].trim();
          const newK = mSwap[3].trim();
          const removed = removeActivityRows(targetCity, dayN, oldK);

          const swapPrompt = `
${typeof FORMAT!=='undefined'?FORMAT:''}
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
          const keyword = extractRemovalKeyword(text);
          if(keyword){
            const removed = removeActivityRows(targetCity, dayN, keyword);
            renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);

            if(removed>0 && hasAskForAlternative(text)){
              const altPrompt = `
${typeof FORMAT!=='undefined'?FORMAT:''}
En "${targetCity}" ${dayN?`(día ${dayN})`:''} el usuario quitó "${keyword}".
Propón y añade nuevas actividades equivalentes o alternativas (sin repetir otras del mismo día).
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

    // --- d) Más detalle (“detalla … (día N)”) ---
    if(!handled && /\b(detalla|mas detalle|más detalle|expande|amplia|amplía|describe mejor|dame mas info|hazlo mas preciso)\b/i.test(text)){
      const targetCity = workingCity;
      if(targetCity){
        const dayScopeRaw = getDayScopeFromText(text);
        const dayN = resolveDayNumber(targetCity, dayScopeRaw);
        const detailPrompt = `
${typeof FORMAT!=='undefined'?FORMAT:''}
El usuario quiere más detalle ${dayN?`del día ${dayN} `:''}en "${targetCity}".
Amplía descripciones, incluye contexto, tiempos realistas y recomendaciones. No dupliques con el resto de días.
Devuelve SOLO JSON formato B para "destination":"${targetCity}" ${dayN?`limitado al día ${dayN}`:''}.`.trim();
        const ans = await callAgent(detailPrompt);
        const parsed = parseJSON(ans);
        if(parsed){
          applyParsedToState(parsed,false);
          renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
          msg(`He detallado las actividades ${dayN?`del día ${dayN} `:''}en ${targetCity}.`,'ai');
        }else{
          msg('No pude detallar actividades.','ai');
        }
      }
      handled = true;
    }

    // --- e) Ajuste de horas naturales ---
    if(!handled && /\b(hora|horario|inicio|fin|empieza|termina|ajusta|cambia)\b/.test(tNorm)){
      const times = parseTimesFromText(text);
      const targetCity = workingCity;
      if(targetCity && times.length){
        const m = (ST().cityMeta[targetCity] || { baseDate:null, start:null, end:null, hotel:'' });
        if(times.length === 1){
          if(/\b(hasta|termina|fin)\b/.test(tNorm)) m.end = times[0];
          else m.start = times[0];
        }else{
          m.start = times[0];
          m.end = times[times.length-1];
        }
        upsertCityMeta({ city: targetCity, baseDate: m.baseDate, start: m.start, end: m.end, hotel: m.hotel });
        await generateCityItinerary(targetCity);
        renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
        msg(`He ajustado las horas en ${targetCity}.`);
      }
      handled = true;
    }

    // --- f) Recalcular itinerario ---
    if(!handled && /\b(recalcula|replanifica|recompute|replan|recalculate|actualiza|regen|optimiza)\b/.test(tNorm)){
      const targetCity = workingCity;
      if(targetCity){
        await generateCityItinerary(targetCity);
        renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
        msg(`He recalculado el itinerario de ${targetCity}.`);
      }
      handled = true;
    }

    if(handled){
      await checkAndGenerateMissing();
      return;
    }

    // --- g) Edición libre general (fallback) ---
    (ST().session||[]).push({role:'user', content:text});
    const cityHint = workingCity ? `Active city: ${workingCity}` : '';
    const prompt = `
${typeof FORMAT!=='undefined'?FORMAT:''}
Edit the current plan. ${cityHint}
Scope: Modifica SOLO la ciudad activa o la mencionada por el usuario; no toques otras ciudades.
Existing plan (keep & adjust): ${getItineraryContext()}
Existing meta (per city): ${getCityMetaContext()}
Si el usuario pide añadir/ajustar actividades o destinos, responde con B/C/A. No envíes texto plano.
Solicitud: ${text}`.trim();

    try{
      const ans = await callAgent(prompt);
      const parsed = parseJSON(ans);
      if(parsed){
        applyParsedToState(parsed,false);
        renderCityTabs(); setActiveCity(workingCity||ST().activeCity); renderCityItinerary(workingCity||ST().activeCity);
        msg(parsed.followup || '¿Deseas otro ajuste?','ai');
      }else{
        msg(ans || 'Listo. ¿Otra cosa?','ai');
      }
      await checkAndGenerateMissing();
    }catch(e){
      console.error(e);
      msg('❌ Error de conexión.','ai');
    }
  }

  // ===== Vinculación robusta de eventos (Enter / Send) =====
  function bindEventsOnce(){
    if (window.__plannerChatBound) return;
    const { $send, $intake } = getDom();
    if ($send) $send.addEventListener('click', sendChat);
    if ($intake) $intake.addEventListener('keydown',(e)=>{ if(e.key==='Enter'){ e.preventDefault(); sendChat(); }});
    if ($send || $intake) {
      window.__plannerChatBound = true;
      console.log('✅ planner-chat.js bound to DOM.');
    } else {
      // Si aún no están listos, espera a DOMContentLoaded
      document.addEventListener('DOMContentLoaded', bindEventsOnce, { once: true });
    }
  }
  bindEventsOnce();

  console.log('✅ planner-chat.js v9 cargado correctamente');
})();
