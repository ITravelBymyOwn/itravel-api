/* ======================================================================
   /public/planner-chat.js — Motor externo (v5, estable)
   - Usa el puente global window.__planner inyectado por Webflow
   - Restaura la lógica de recopilación de meta de ciudades
   - Integra la Sección 14 avanzada (edición inteligente)
   - Añade fallback local para extraer meta si el LLM no entiende
   ====================================================================== */

(function(){
  'use strict';

  // ====== 0) Requiere puente ======
  const PL = window.__planner;
  if(!PL){
    console.error('❌ Planner bridge not found (window.__planner). Revisa el puente en Webflow.');
    return;
  }

  // Accesos cómodos (estado vivo + patch)
  const S = ()=> PL.state;                 // snapshot vivo
  const patch = (p)=> PL.statePatch = p;   // set parciales en core

  // Shortcuts DOM / helpers / API / UI
  const { $send, $intake } = PL.dom;
  const { qs, qsa, normalize, extractInt, parseTimesFromText, updateSavedDays } = PL.helpers;
  const { callAgent, parseJSON, getItineraryContext, getCityMetaContext,
          generateCityItinerary, applyParsedToState, ensureDays, upsertCityMeta } = PL.api;
  const { renderCityTabs, renderCityItinerary, msg, askForNextCityMeta, maybeGenerateAllCities } = PL.ui;

  // ====== 1) Constantes / formato JSON que espera el LLM ======
  const FORMAT = `
Devuelve SOLO JSON (sin texto extra) con alguno de estos formatos:
A) {"destinations":[{"name":"City","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"..","from":"..","to":"..","transport":"..","duration":"..","notes":".."}]}], "followup":"Pregunta breve"}
B) {"destination":"City","rows":[{...}],"followup":"Pregunta breve"}
C) {"rows":[{...}],"followup":"Pregunta breve"}
D) {"meta":{"city":"City","baseDate":"DD/MM/YYYY","start":"HH:MM" o ["HH:MM",...],"end":"HH:MM" o ["HH:MM",...],"hotel":"Texto"},"followup":"Pregunta breve"}
Reglas:
- Incluye traslados con transporte y duración (+15% colchón).
- Si faltan datos (p.ej., hora de inicio por día), pregúntalo en "followup" y asume valores razonables.
- Nada de markdown. Solo JSON.`.trim();

  // ====== 2) Utils locales adicionales ======
  function parseDateDMYLoose(text){
    if(!text) return null;
    const t = (text+'').trim();
    // dd/mm/yyyy
    let m = /(\b\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/.exec(t);
    if(m){
      const d = parseInt(m[1],10), mm = parseInt(m[2],10), y = parseInt(m[3],10);
      if(d>=1 && d<=31 && mm>=1 && mm<=12 && y>=1900) return `${String(d).padStart(2,'0')}/${String(mm).padStart(2,'0')}/${y}`;
    }
    // dd/mm (año asumido actual o +1 si pasó)
    m = /(\b\d{1,2})[\/\-](\d{1,2})(?![\/\-]\d{4})/.exec(t);
    if(m){
      const now = new Date();
      let d = parseInt(m[1],10), mm = parseInt(m[2],10), y = now.getFullYear();
      const temp = new Date(y, mm-1, d);
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if(temp < today) y = y+1;
      return `${String(d).padStart(2,'0')}/${String(mm).padStart(2,'0')}/${y}`;
    }
    return null;
  }
  function parseHotel(text){
    if(!text) return '';
    // capturar "hotel", "hospedaré", "zona", "barrio", "cerca de ..."
    const t = text.toLowerCase();
    const zones = /(hotel|hostal|airbnb|zona|barrio|me\s+hospedar[ée]|cerca\s+de)\s*[:\-]?\s*(.+)$/i.exec(text);
    if(zones) return zones[2].trim();
    // ejemplo con "me hospedaré cerca de La Sagrada Familia"
    const near = /hospedar[ée]\s+cerca\s+de\s+(.+)$/i.exec(text);
    if(near) return near[1].trim();
    return '';
  }

  // ====== 3) Meta flow helpers ======
  function metaIsComplete(meta){
    return !!(meta && meta.baseDate && meta.start && meta.end && typeof meta.hotel === 'string');
  }

  // Fallback local: extrae meta sin LLM si este no entiende
  function fallbackExtractMeta(city, userText){
    // Fecha
    const baseDate = parseDateDMYLoose(userText);
    // Horas (usa helper del core)
    const times = parseTimesFromText(userText) || [];
    let start = null, end = null;
    if(times.length===1){
      // heurística: si contiene "hasta|termina|fin", toma como end
      const tnorm = normalize(userText);
      if(/\b(hasta|termina|fin)\b/.test(tnorm)) end = times[0];
      else start = times[0];
    }else if(times.length>=2){
      start = times[0];
      end   = times[times.length-1];
    }
    const hotel = parseHotel(userText) || '';
    const meta = { city, baseDate: baseDate || null, start: start || null, end: end || null, hotel };
    if(meta.city && meta.baseDate && meta.start && meta.end && typeof meta.hotel === 'string'){
      return meta;
    }
    return null;
  }

  // ====== 4) Sección 14 — Chat (versión avanzada) ======
  // ---- utilidades de NLU y edición ----
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
    const { itineraries } = S();
    if(dayScope === 'LAST'){
      const days = Object.keys(itineraries[city]?.byDay||{}).map(n=>parseInt(n,10));
      return days.length ? Math.max(...days) : 1;
    }
    return dayScope || null;
  }
  function extractIntStrict(str){
    const m = (str||'').match(/\b(\d{1,2})\b/);
    if(m) return Math.max(1, parseInt(m[1],10));
    return null;
  }
  function extractRemovalKeyword(text){
    const clean = (text||'')
      .replace(/\ben el d[ií]a\s+\d+\b/ig,'')
      .replace(/\bdel d[ií]a\s+\d+\b/ig,'');
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
    const { itineraries } = S();
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
    const { savedDestinations } = S();
    for(const {city} of savedDestinations){
      if(t.includes(normalize(city))) return city;
    }
    return null;
  }
  function getVisibleDay(city){
    const { itineraries } = S();
    const btn = document.querySelector('.pager .active');
    if(btn && /^\d+$/.test(btn.textContent.trim())) return parseInt(btn.textContent.trim(),10);
    return itineraries[city]?.currentDay || 1;
  }
  function getDayRowsAsText(city, day){
    const { itineraries } = S();
    const rows = itineraries[city]?.byDay?.[day] || [];
    if(!rows.length) return "No hay actividades registradas.";
    return rows.map(r=>`De ${r.start} a ${r.end}: ${r.activity} (${r.from} → ${r.to}, ${r.transport}, ${r.duration}). Notas: ${r.notes}`).join("\n");
  }
  function getAllDaysContextAsText(city){
    const { itineraries } = S();
    const byDay = itineraries[city]?.byDay || {};
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
    const { itineraries } = S();
    const old = itineraries[city]?.byDay || {};
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
    itineraries[city].byDay = newByDay;
    itineraries[city].currentDay = 1;
    ensureDays(city);
    return true;
  }
  function swapDays(city, a, b){
    const { itineraries } = S();
    const byDay = itineraries[city]?.byDay || {};
    const A = byDay[a] || [];
    const B = byDay[b] || [];
    byDay[a] = (B||[]).map(r=>({...r, day:a}));
    byDay[b] = (A||[]).map(r=>({...r, day:b}));
    itineraries[city].byDay = byDay;
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
  function extractAddCity(text){
    const m = /(agrega|añade|add)\s+([a-záéíóúñ\s]+?)\s+(\d{1,2})\s+d[ií]as?/i.exec(text);
    if(m) return {city: m[2].trim().replace(/\s+/g,' ').replace(/^\w/,c=>c.toUpperCase()), days: parseInt(m[3],10)};
    const m2 = /(agrega|añade|add)\s+([a-záéíóúñ\s]+)$/i.exec(text);
    if(m2) return {city: m2[2].trim().replace(/\s+/g,' ').replace(/^\w/,c=>c.toUpperCase()), days: 1};
    return null;
  }
  function extractRemoveCity(text){
    const m = /(elimina|quita|remueve)\s+(?:la\s+ciudad\s+)?([a-záéíóúñ\s]+)$/i.exec(text);
    if(m) return {city: m[2].trim().replace(/\s+/g,' ').replace(/^\w/,c=>c.toUpperCase())};
    return null;
  }
  function addCityFromChat(name, days=1){
    const { savedDestinations, itineraries, cityMeta } = S();
    const order = savedDestinations.length ? Math.max(...savedDestinations.map(x=>x.order)) + 1 : 1;
    savedDestinations.push({city:name, days:Math.max(1,days), order});
    if(!itineraries[name]) itineraries[name] = { byDay:{}, currentDay:1, baseDate:null };
    if(!cityMeta[name]) cityMeta[name] = { baseDate:null, start:null, end:null, hotel:'' };
    ensureDays(name);
    renderCityTabs();
    patch({ activeCity:name });
    renderCityItinerary(name);
  }
  function removeCityFromChat(name){
    const st = S();
    const idx = st.savedDestinations.findIndex(x=>x.city===name);
    if(idx>=0) st.savedDestinations.splice(idx,1);
    delete st.itineraries[name];
    delete st.cityMeta[name];
    st.savedDestinations.forEach((x,i)=>x.order=i+1);
    renderCityTabs();
    const newActive = st.savedDestinations[0]?.city || null;
    patch({ activeCity:newActive });
    if(newActive) renderCityItinerary(newActive);
  }
  function moveActivityBetweenDays(city, fromDayGuess, activityKw, toDay){
    const fromDay = fromDayGuess || null;
    const removed = removeActivityRows(city, fromDay, activityKw);
    return removed;
  }
  async function checkAndGenerateMissing(){
    const { savedDestinations, cityMeta, itineraries } = S();
    for(const {city} of savedDestinations){
      const m = cityMeta[city];
      const hasRows = Object.values(itineraries[city]?.byDay || {}).some(a => a.length > 0);
      if(metaIsComplete(m) && !hasRows){
        await generateCityItinerary(city);
      }
    }
  }

  // ====== 5) Chat principal ======
  async function sendChat(){
    const st = S();
    const text = ( ($intake && $intake.value) || '' ).trim();
    if(!text) return;
    msg(text,'user');
    if($intake) $intake.value='';

    // ------ Fase 1: recopilación secuencial de meta ------
    if(st.collectingMeta){
      const city = st.savedDestinations[st.metaProgressIndex]?.city;
      if(!city){
        patch({ collectingMeta:false });
        await maybeGenerateAllCities();
        return;
      }

      const extractPrompt = `
Extrae del texto la meta para la ciudad "${city}" en formato D del esquema:
${FORMAT}
Devuelve SOLO:
{"meta":{"city":"${city}","baseDate":"DD/MM/YYYY","start":"HH:MM" o ["HH:MM",...],"end":"HH:MM" o ["HH:MM",...],"hotel":"Texto"}}
Texto del usuario: ${text}`.trim();

      let metaParsed = null;
      try{
        const answer = await callAgent(extractPrompt);
        const parsed = parseJSON(answer);
        if(parsed?.meta) metaParsed = parsed.meta;
      }catch(_){ /* ignore */ }

      // fallback local si el LLM no entendió
      if(!metaParsed){
        metaParsed = fallbackExtractMeta(city, text);
      }

      if(metaParsed){
        upsertCityMeta(metaParsed);
        patch({ awaitingMetaReply:false });
        msg(`Perfecto, tengo la información para ${city}.`);
        const nextIndex = st.metaProgressIndex + 1;
        patch({ metaProgressIndex: nextIndex });
        if(nextIndex < st.savedDestinations.length){
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

    // ------ Fase 2: conversación normal (edición avanzada) ------
    const tNorm = normalize(text);
    let handled = false;

    const cityFromText = findCityInText(text);
    const workingCity = cityFromText || st.activeCity;
    if(cityFromText && cityFromText !== st.activeCity){
      patch({ activeCity: cityFromText });
      renderCityItinerary(cityFromText);
    }

    // A) Alta/Baja ciudades
    if(!handled){
      const addCityReq = extractAddCity(text);
      if(addCityReq){
        addCityFromChat(addCityReq.city, addCityReq.days);
        msg(`He agregado **${addCityReq.city}** con ${addCityReq.days} día(s). Comparte la fecha del primer día (DD/MM/AAAA), horas de inicio/fin y hotel/zona para generar el itinerario.`);
        patch({
          collectingMeta:true,
          metaProgressIndex: st.savedDestinations.findIndex(x=>x.city===addCityReq.city),
          awaitingMetaReply:false
        });
        await askForNextCityMeta();
        handled = true;
      }
    }
    if(!handled){
      const removeCityReq = extractRemoveCity(text);
      if(removeCityReq){
        removeCityFromChat(removeCityReq.city);
        msg(`He eliminado la ciudad **${removeCityReq.city}**.`);
        handled = true;
      }
    }
    if(handled) return;

    // B) Agregar días
    if(/\b(agrega|añade|sumar?|add)\b.*\bd[ií]a/.test(tNorm) || /\b(un dia mas|1 dia mas)\b/.test(tNorm)){
      const addN = extractIntStrict(tNorm) ?? 1;
      const hasActivity = /\b(tour|excursion|visita|museo|paseo|segovia|toledo|montserrat|catedral|parque|mercado|playa|ruta)\b/i.test(text);
      const activityDesc = hasActivity ? text : null;

      if(workingCity){
        const current = st.savedDestinations.find(x=>x.city===workingCity)?.days 
          || Object.keys(st.itineraries[workingCity]?.byDay||{}).length || 1;
        const newDays = current + addN;
        updateSavedDays(workingCity, newDays);
        ensureDays(workingCity);

        if(hasActivity){
          const prompt = `
${FORMAT}
Edita el itinerario de "${workingCity}" agregando ${addN} día${addN>1?'s':''}.
Incluye como actividad principal: "${activityDesc}" y completa con otras actividades no repetidas ni duplicadas de otros días.
Ajusta horarios y transportes coherentemente.
Devuelve SOLO JSON con "destination":"${workingCity}".`.trim();
          const answer = await callAgent(prompt);
          const parsed = parseJSON(answer);
          if(parsed){ applyParsedToState(parsed,false); }
        }else{
          await generateCityItinerary(workingCity);
        }

        renderCityTabs();
        patch({ activeCity: workingCity });
        renderCityItinerary(workingCity);
        msg(`He añadido ${addN} día${addN>1?'s':''} en ${workingCity}.`);
      }
      handled = true;
    }

    // C) Quitar días
    if(!handled && (/\b(quita|elimina|remueve|remove)\b.*\bd[ií]a/.test(tNorm) || /\b(ultimo|último)\s+d[ií]a\b/i.test(tNorm))){
      const targetCity = workingCity;
      if(targetCity){
        const daySpecific = getDayScopeFromText(text);
        if(daySpecific && daySpecific !== 'LAST'){
          const dayN = resolveDayNumber(targetCity, daySpecific);
          const byDay = st.itineraries[targetCity]?.byDay || {};
          delete byDay[dayN];
          const remain = Object.keys(byDay).map(n=>parseInt(n,10)).sort((a,b)=>a-b);
          const newByDay = {};
          remain.forEach((src,i)=>{ newByDay[i+1] = (byDay[src]||[]).map(r=>({...r, day:i+1})); });
          st.itineraries[targetCity].byDay = newByDay;
          const curIdx = st.savedDestinations.findIndex(x=>x.city===targetCity);
          if(curIdx>=0) st.savedDestinations[curIdx].days = Math.max(1, remain.length);
          ensureDays(targetCity);
          renderCityTabs(); patch({ activeCity:targetCity }); renderCityItinerary(targetCity);
          msg(`He eliminado el día ${dayN} en ${targetCity}.`);
        }else{
          const remN = extractIntStrict(tNorm) ?? 1;
          const current = st.savedDestinations.find(x=>x.city===targetCity)?.days 
            || Object.keys(st.itineraries[targetCity]?.byDay||{}).length || 1;
          const newDays = Math.max(1, current - remN);
          const keys = Object.keys(st.itineraries[targetCity]?.byDay||{}).map(d=>parseInt(d,10)).sort((a,b)=>b-a);
          keys.slice(0,remN).forEach(k=>delete st.itineraries[targetCity].byDay[k]);
          updateSavedDays(targetCity, newDays);
          ensureDays(targetCity);
          renderCityTabs(); patch({ activeCity:targetCity }); renderCityItinerary(targetCity);
          msg(`He quitado ${remN} día${remN>1?'s':''} en ${targetCity}.`);
        }
      }
      handled = true;
    }

    // D) Reordenar / swap
    if(!handled){
      const ro = parseReorderInstruction(text);
      if(ro && workingCity){
        if(ro.type==='sequence'){
          const ok = reorderCityDays(workingCity, ro.seq);
          if(ok){
            renderCityTabs(); patch({ activeCity:workingCity }); renderCityItinerary(workingCity);
            msg(`He reordenado los días en ${workingCity} como ${ro.seq.join(', ')} → 1..${ro.seq.length}.`);
          }else{
            msg('No pude reordenar: la secuencia no coincide con el número de días.','ai');
          }
        }else if(ro.type==='swap'){
          swapDays(workingCity, ro.a, ro.b);
          renderCityTabs(); patch({ activeCity:workingCity }); renderCityItinerary(workingCity);
          msg(`He intercambiado el día ${ro.a} con el día ${ro.b} en ${workingCity}.`);
        }else if(ro.type==='makeFirst'){
          const byDay = st.itineraries[workingCity]?.byDay || {};
          const days = Object.keys(byDay).map(n=>parseInt(n,10)).sort((a,b)=>a-b);
          const seq = [ro.day, ...days.filter(d=>d!==ro.day)];
          const ok = reorderCityDays(workingCity, seq);
          if(ok){
            renderCityTabs(); patch({ activeCity:workingCity }); renderCityItinerary(workingCity);
            msg(`He puesto el día ${ro.day} como primero en ${workingCity}.`);
          }
        }
        handled = true;
      }
    }

    // E) Mover actividad entre días
    if(!handled){
      const mv = parseMoveActivityInstruction(text);
      if(mv && workingCity){
        const currentDay = getVisibleDay(workingCity);
        const toDay = mv.toDay || currentDay;
        let fromDay = mv.fromDay || null;
        let act = mv.activity || null;
        if(!act){
          const kw = extractRemovalKeyword(text);
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
          renderCityTabs(); patch({ activeCity:workingCity }); renderCityItinerary(workingCity);
          msg(`He movido "${act}" al día ${toDay} en ${workingCity} y ajustado los horarios.`, 'ai');
        }else{
          renderCityTabs(); patch({ activeCity:workingCity }); renderCityItinerary(workingCity);
          msg(`He quitado "${act}" del día origen. ¿Deseas qué haga exactamente en el día ${toDay}?`, 'ai');
        }
        handled = true;
      }
    }

    // F) Sustituciones / alternativas / eliminar actividad
    if(!handled && /(no\s+(?:quiero|deseo)|quita|elimina|remueve|cancelar|sustituye|reemplaza|cambia)/i.test(text)){
      const targetCity = workingCity;
      if(targetCity){
        const dayScopeRaw = getDayScopeFromText(text);
        const dayN = resolveDayNumber(targetCity, dayScopeRaw);
        const mSwap = /(sustituye|reemplaza|cambia)\s+(?:el\s+)?(.+?)\s+por\s+(.+?)(?:$|\.|,)/i.exec(text);
        if(mSwap){
          const oldK = mSwap[2].trim();
          const newK = mSwap[3].trim();
          removeActivityRows(targetCity, dayN, oldK);
          const swapPrompt = `
${FORMAT}
En "${targetCity}" ${dayN?`(día ${dayN})`:''} elimina "${oldK}" y reemplázalo por actividades equivalentes basadas en "${newK}".
Ajusta automáticamente horarios, duraciones y transiciones; completa huecos y evita duplicados con otros días.
Devuelve SOLO JSON formato B con "destination":"${targetCity}".`.trim();
          const ans = await callAgent(swapPrompt);
          const parsed = parseJSON(ans);
          if(parsed){
            applyParsedToState(parsed,false);
            renderCityTabs(); patch({ activeCity:targetCity }); renderCityItinerary(targetCity);
            msg(`He reemplazado "${oldK}" por "${newK}" y optimizado el flujo.`,'ai');
          }else msg(`He eliminado "${oldK}". ¿Qué deseas hacer en su lugar?`,'ai');
        }else{
          const keyword = extractRemovalKeyword(text);
          if(keyword){
            const removed = removeActivityRows(targetCity, dayN, keyword);
            renderCityTabs(); patch({ activeCity:targetCity }); renderCityItinerary(targetCity);
            if(removed>0){
              if(hasAskForAlternative(text)){
                const altPrompt = `
${FORMAT}
En "${targetCity}" ${dayN?`(día ${dayN})`:''} el usuario quitó "${keyword}".
Propón nuevas actividades coherentes y optimiza la secuencia del día (horarios, transportes, duraciones).
Evita repetir otras actividades de la ciudad.
Devuelve SOLO JSON formato B con "destination":"${targetCity}".`.trim();
                const ans = await callAgent(altPrompt);
                const parsed = parseJSON(ans);
                if(parsed){
                  applyParsedToState(parsed,false);
                  renderCityTabs(); patch({ activeCity:targetCity }); renderCityItinerary(targetCity);
                  msg(`He sustituido "${keyword}" por alternativas optimizadas.`,'ai');
                }
              }else msg(`He eliminado "${keyword}".`,'ai');
            }else msg(`No encontré "${keyword}" en ${targetCity}.`,'ai');
          }
        }
      }
      handled = true;
    }

    // G) Detallar / optimizar día visible
    if(!handled && /\b(detalla|mas detalle|expande|optimiza|reorganiza|mejora flujo|hazlo mas preciso|con mas tiempo|con mas paradas)\b/i.test(text)){
      const targetCity = workingCity;
      if(targetCity){
        const currentDay = getVisibleDay(targetCity);
        const currentDayContext = getDayRowsAsText(targetCity, currentDay);
        const allDaysContext = getAllDaysContextAsText(targetCity);
        const prompt = `
${FORMAT}
El usuario desea optimizar y detallar el DÍA ${currentDay} en "${targetCity}".
Contexto del día ${currentDay}:
${currentDayContext}

Resumen de otros días en "${targetCity}" (evita repetir):
${allDaysContext}

Tareas:
- Mejora flujo, ajusta horarios/transportes, añade detalles y llena huecos.
- Evita duplicar actividades de otros días de la misma ciudad.
- Mantén cambios SOLO en el día ${currentDay}.
Devuelve SOLO JSON formato B con "destination":"${targetCity}".`.trim();
        const ans = await callAgent(prompt);
        const parsed = parseJSON(ans);
        if(parsed){
          applyParsedToState(parsed,false);
          renderCityTabs(); patch({ activeCity:targetCity }); renderCityItinerary(targetCity);
          msg(`He optimizado y detallado el día ${currentDay} en ${targetCity}.`,'ai');
        }else msg('No pude optimizar el flujo.','ai');
      }
      handled = true;
    }

    // H) Ajuste de horas (meta)
    if(!handled && /\b(hora|horario|inicio|fin|empieza|termina|ajusta|cambia)\b/.test(tNorm)){
      const times = parseTimesFromText(text);
      const targetCity = workingCity;
      if(targetCity && times.length){
        const cm = st.cityMeta[targetCity] || (st.cityMeta[targetCity] = { baseDate:null, start:null, end:null, hotel:'' });
        if(times.length===1){
          if(/\b(hasta|termina|fin)\b/.test(tNorm)) cm.end = times[0];
          else cm.start = times[0];
        }else{
          cm.start = times[0];
          cm.end = times[times.length-1];
        }
        await generateCityItinerary(targetCity);
        renderCityTabs(); patch({ activeCity:targetCity }); renderCityItinerary(targetCity);
        msg(`He ajustado las horas en ${targetCity}.`);
      }
      handled = true;
    }

    // I) Replantear todo desde cero
    if(!handled && /(replantea|vuelve a plantear|nuevo plan|desde cero|reset(?:ea)?|comienza de nuevo|hazlo de nuevo)\b/i.test(tNorm)){
      const targetCity = workingCity;
      if(targetCity){
        st.itineraries[targetCity].byDay = {};
        await generateCityItinerary(targetCity);
        renderCityTabs(); patch({ activeCity:targetCity }); renderCityItinerary(targetCity);
        msg(`He replanteado por completo el itinerario de ${targetCity}.`);
      }
      handled = true;
    }

    // J) Recalcular ciudad
    if(!handled && /\b(recalcula|replanifica|recompute|replan|recalculate|actualiza)\b/.test(tNorm)){
      const targetCity = workingCity;
      if(targetCity){
        await generateCityItinerary(targetCity);
        renderCityTabs(); patch({ activeCity:targetCity }); renderCityItinerary(targetCity);
        msg(`He recalculado el itinerario de ${targetCity}.`);
      }
      handled = true;
    }

    if(handled){ await checkAndGenerateMissing(); return; }

    // K) Fallback inteligente: día visible
    st.session.push({role:'user', content:text});
    const targetCity = workingCity || st.activeCity;
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
        renderCityTabs(); patch({ activeCity:targetCity }); renderCityItinerary(targetCity);
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

  // ====== 6) Eventos ======
  if($send){
    $send.removeEventListener?.('__planner_send_click', ()=>{}); // limpieza defensiva
    $send.addEventListener('click', sendChat);
  }
  if($intake){
    $intake.removeEventListener?.('__planner_enter_key', ()=>{});
    $intake.addEventListener('keydown',(e)=>{
      if(e.key==='Enter'){ e.preventDefault(); sendChat(); }
    });
  }

  console.log('✅ planner-chat.js (v5) cargado correctamente');
})();
