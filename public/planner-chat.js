/* planner-chat.js v4 — motor de chat externo que habla con window.__planner
   Requiere que Webflow inyecte el puente "waitCore(...)->__planner" ANTES de cargar este archivo.
*/
(() => {
  'use strict';

  // ======== Util ========
  function reqPlanner() {
    const P = window.__planner;
    if (!P || !P.api || !P.dom || !P.ui) {
      throw new Error('⛔ __planner no está listo (puente no cargado).');
    }
    return P;
  }
  function S() { return window.__planner.state; }     // snapshot vivo
  function patch(p) { window.__planner.statePatch = p; }

  // ======== Constantes de formato JSON (idéntico al core) ========
  const FORMAT = `
Devuelve SOLO JSON (sin texto extra) con alguno de estos formatos:
A) {"destinations":[{"name":"City","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"..","from":"..","to":"..","transport":"..","duration":"..","notes":".."}]}], "followup":"Pregunta breve"}
B) {"destination":"City","rows":[{...}],"followup":"Pregunta breve"}
C) {"rows":[{...}],"followup":"Pregunta breve"}
D) {"meta":{"city":"City","baseDate":"DD/MM/YYYY","start":"HH:MM" o ["HH:MM",...],"end":"HH:MM" o ["HH:MM",...],"hotel":"Texto"},"followup":"Pregunta breve"}
Reglas:
- Incluye traslados con transporte y duración (+15% colchón).
- Si faltan datos (p.ej. hora de inicio por día), pregúntalo en "followup" y asume valores razonables.
- Nada de markdown. Solo JSON.`.trim();

  // ======== Helpers NL (locales al motor) ========
  function getDayScopeFromText(text){
    const m = (text||'').match(/\bd[ií]a\s+(\d{1,2})\b/i);
    if (m) return Math.max(1, parseInt(m[1],10));
    if (/\b(ultimo|último)\s+d[ií]a\b/i.test(text||'')) return 'LAST';
    return null;
  }
  function extractRemovalKeyword(text){
    const clean = (text||'').replace(/\ben el d[ií]a\s+\d+\b/ig,'').replace(/\bdel d[ií]a\s+\d+\b/ig,'');
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
  function findCityInText(text){
    const t = (window.__planner.helpers.normalize)(text||'');
    for(const {city} of (S().savedDestinations||[])){
      if(t.includes(window.__planner.helpers.normalize(city))) return city;
    }
    return null;
  }
  function resolveDayNumber(city, dayScope){
    if(dayScope === 'LAST'){
      const data = S().itineraries?.[city]?.byDay || {};
      const days = Object.keys(data).map(n=>parseInt(n,10));
      return days.length ? Math.max(...days) : 1;
    }
    return dayScope || null;
  }
  function removeActivityRows(city, dayOrNull, keyword){
    const P = reqPlanner();
    const itineraries = S().itineraries || {};
    if(!itineraries[city] || !keyword) return 0;
    const kw = normalizeActivityString(keyword);
    const byDay = itineraries[city].byDay || {};
    const targetDays = dayOrNull ? [dayOrNull] : Object.keys(byDay).map(n=>parseInt(n,10));
    let removed = 0;
    targetDays.forEach(d=>{
      const rows = byDay[d] || [];
      const before = rows.length;
      const next = rows.filter(r => !normalizeActivityString(r.activity||'').includes(kw));
      byDay[d] = next;
      removed += Math.max(0, before - next.length);
    });
    P.api.ensureDays(city);
    return removed;
  }
  async function checkAndGenerateMissing(){
    const P = reqPlanner();
    for(const {city} of (S().savedDestinations||[])){
      const m = S().cityMeta?.[city];
      const hasRows = Object.values(S().itineraries?.[city]?.byDay || {}).some(a => a.length > 0);
      if(typeof window.metaIsComplete === 'function'){
        if(window.metaIsComplete(m) && !hasRows) await P.api.generateCityItinerary(city);
      }else{
        // fallback: meta mínima
        const ok = !!(m && m.baseDate && m.start && m.end);
        if(ok && !hasRows) await P.api.generateCityItinerary(city);
      }
    }
  }

  // ======== Chat principal ========
  async function sendChat(){
    const P = reqPlanner();
    const {$intake,$send} = P.dom;
    const {msg, renderCityTabs, renderCityItinerary, askForNextCityMeta, maybeGenerateAllCities} = P.ui;
    const {callAgent, parseJSON, generateCityItinerary, applyParsedToState, ensureDays, getItineraryContext, getCityMetaContext} = P.api;
    const {extractInt, parseTimesFromText, updateSavedDays, normalize} = P.helpers;

    const text = ($intake?.value||'').trim();
    if(!text) return;
    msg(text,'user');
    if($intake) $intake.value='';

    // ========== Fase 1: recopilación secuencial de meta ==========
    if(S().collectingMeta){
      const city = (S().savedDestinations||[])[S().metaProgressIndex]?.city;
      if(!city){
        patch({collectingMeta:false});
        await maybeGenerateAllCities();
        return;
      }

      const extractPrompt = `
Extrae del texto la meta para la ciudad "${city}" en formato D del esquema:
${FORMAT}
Devuelve SOLO:
{"meta":{"city":"${city}","baseDate":"DD/MM/YYYY","start":"HH:MM" o ["HH:MM",...],"end":"HH:MM" o ["HH:MM",...],"hotel":"Texto"}}
Texto del usuario: ${text}`.trim();

      const answer = await callAgent(extractPrompt);
      const parsed = parseJSON(answer);

      if(parsed?.meta){
        P.api.upsertCityMeta(parsed.meta);
        patch({awaitingMetaReply:false});
        msg(`Perfecto, tengo la información para ${city}.`);
        patch({metaProgressIndex: (S().metaProgressIndex||0)+1});
        if(S().metaProgressIndex < (S().savedDestinations||[]).length){
          await askForNextCityMeta();
        }else{
          patch({collectingMeta:false});
          msg('Perfecto 🎉 Ya tengo toda la información. Generando itinerarios...');
          await maybeGenerateAllCities();
        }
      }else{
        msg('No logré entender. ¿Podrías repetir la fecha del primer día, horarios y hotel/zona?');
      }
      return;
    }

    // ========== Fase 2: conversación normal ==========
    const tNorm = normalize(text);
    let handled = false;

    // Resolver ciudad activa por mención
    const cityFromText = findCityInText(text);
    const workingCity = cityFromText || S().activeCity;
    if(cityFromText && cityFromText !== S().activeCity){
      patch({activeCity: cityFromText});
      renderCityItinerary(cityFromText);
    }

    // --- a) Agregar días ---
    if(/\b(agrega|añade|sumar?|add)\b.*\bd[ií]a/.test(tNorm) || /\b(un dia mas|1 dia mas)\b/.test(tNorm)){
      const addN = extractInt(tNorm);
      const hasActivity = /\b(tour|excursion|visita|museo|paseo|segovia|toledo|montserrat|catedral|parque|mercado|playa|ruta)\b/i.test(text);
      const activityDesc = hasActivity ? text : null;

      if(workingCity){
        const current = (S().savedDestinations||[]).find(x=>x.city===workingCity)?.days
          || Object.keys(S().itineraries?.[workingCity]?.byDay||{}).length || 1;
        const newDays = current + addN;
        updateSavedDays(workingCity,newDays);
        ensureDays(workingCity);

        if(hasActivity){
          const prompt = `
${FORMAT}
Edita el itinerario de "${workingCity}" agregando ${addN} día${addN>1?'s':''}.
Incluye como actividad principal: "${activityDesc}" en el/los día(s) nuevo(s) y completa con otras actividades no repetidas.
No elimines días previos.
Devuelve SOLO JSON con "destination":"${workingCity}".`.trim();
          const ans = await callAgent(prompt);
          const parsed = P.api.parseJSON(ans);
          if(parsed){ applyParsedToState(parsed,false); }
        }else{
          await generateCityItinerary(workingCity);
        }

        renderCityTabs();
        patch({activeCity: workingCity});
        renderCityItinerary(workingCity);
        msg(`He añadido ${addN} día${addN>1?'s':''} en ${workingCity}.`);
      }
      handled = true;
    }

    // --- b) Quitar días (incluye "último día") ---
    if(!handled && (/\b(quita|elimina|remueve|remove)\b.*\bd[ií]a/.test(tNorm) || /\b(ultimo|último)\s+d[ií]a\b/i.test(tNorm))){
      const remN = /\b\d+\b/.test(tNorm) ? extractInt(tNorm) : 1;
      const targetCity = workingCity;
      if(targetCity){
        const current = (S().savedDestinations||[]).find(x=>x.city===targetCity)?.days
          || Object.keys(S().itineraries?.[targetCity]?.byDay||{}).length || 1;
        const newDays = Math.max(1, current - remN);
        updateSavedDays(targetCity,newDays);

        const keys = Object.keys(S().itineraries?.[targetCity]?.byDay||{}).map(d=>parseInt(d,10)).sort((a,b)=>b-a);
        keys.slice(0,remN).forEach(k=>{
          const byDay = S().itineraries[targetCity].byDay;
          delete byDay[k];
        });
        ensureDays(targetCity);
        renderCityTabs();
        patch({activeCity: targetCity});
        renderCityItinerary(targetCity);
        msg(`He quitado ${remN} día${remN>1?'s':''} en ${targetCity}.`);
      }
      handled = true;
    }

    // --- c) Eliminar / sustituir actividades ---
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
${FORMAT}
En "${targetCity}" ${dayN?`(día ${dayN})`:''} elimina "${oldK}" y sustitúyelo por actividades basadas en "${newK}".
Mantén coherencia de horarios y no repitas con lo ya existente.
Devuelve SOLO JSON formato B con "destination":"${targetCity}".`.trim();
          const ans = await callAgent(swapPrompt);
          const parsed = P.api.parseJSON(ans);
          if(parsed){
            applyParsedToState(parsed,false);
            renderCityTabs(); patch({activeCity: targetCity}); renderCityItinerary(targetCity);
            msg(removed>0?`Sustituí "${oldK}" por "${newK}" en ${targetCity}.`:`Añadí actividades de "${newK}" en ${targetCity}.`,'ai');
          }else{
            msg(`Eliminé "${oldK}". ¿Qué tipo de actividad quieres en su lugar?`,'ai');
          }
          handled = true;
        }else if (/(qu(i|í)ta|elimina|remueve|cancelar|no\s+(?:quiero|deseo))/i.test(text)){
          const keyword = extractRemovalKeyword(text);
          if(keyword){
            const removed = removeActivityRows(targetCity, dayN, keyword);
            renderCityTabs(); patch({activeCity: targetCity}); renderCityItinerary(targetCity);

            if(removed>0 && hasAskForAlternative(text)){
              const altPrompt = `
${FORMAT}
En "${targetCity}" ${dayN?`(día ${dayN})`:''} el usuario quitó "${keyword}".
Propón y añade nuevas actividades equivalentes o alternativas (sin repetir otras del mismo día).
Devuelve SOLO JSON formato B con "destination":"${targetCity}".`.trim();
              const ans = await callAgent(altPrompt);
              const parsed = P.api.parseJSON(ans);
              if(parsed){
                applyParsedToState(parsed,false);
                renderCityTabs(); patch({activeCity: targetCity}); renderCityItinerary(targetCity);
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

    // --- d) Detallar día ---
    if(!handled && /\b(detalla|mas detalle|más detalle|expande|amplia|amplía|describe mejor|dame mas info|hazlo mas preciso)\b/i.test(text)){
      const targetCity = workingCity;
      if(targetCity){
        const dayScopeRaw = getDayScopeFromText(text);
        const dayN = resolveDayNumber(targetCity, dayScopeRaw);
        const detailPrompt = `
${FORMAT}
El usuario quiere más detalle ${dayN?`del día ${dayN} `:''}en "${targetCity}".
Amplía descripciones, incluye contexto, tiempos realistas y recomendaciones. No dupliques con el resto de días.
Devuelve SOLO JSON formato B para "destination":"${targetCity}" ${dayN?`limitado al día ${dayN}`:''}.`.trim();
        const ans = await callAgent(detailPrompt);
        const parsed = P.api.parseJSON(ans);
        if(parsed){
          applyParsedToState(parsed,false);
          renderCityTabs(); patch({activeCity: targetCity}); renderCityItinerary(targetCity);
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
        const meta = S().cityMeta?.[targetCity] || { baseDate:null, start:null, end:null, hotel:'' };
        if(times.length === 1){
          if(/\b(hasta|termina|fin)\b/.test(tNorm)) meta.end = times[0];
          else meta.start = times[0];
        }else{
          meta.start = times[0];
          meta.end = times[times.length-1];
        }
        window.__planner.api.upsertCityMeta({city:targetCity, ...meta});
        await generateCityItinerary(targetCity);
        renderCityTabs(); patch({activeCity: targetCity}); renderCityItinerary(targetCity);
        msg(`He ajustado las horas en ${targetCity}.`);
      }
      handled = true;
    }

    // --- f) Recalcular itinerario ---
    if(!handled && /\b(recalcula|replanifica|recompute|replan|recalculate|actualiza|regen|optimiza)\b/.test(tNorm)){
      const targetCity = workingCity;
      if(targetCity){
        await generateCityItinerary(targetCity);
        renderCityTabs(); patch({activeCity: targetCity}); renderCityItinerary(targetCity);
        msg(`He recalculado el itinerario de ${targetCity}.`);
      }
      handled = true;
    }

    // Si resolvimos algo, verificar faltantes
    if(handled){ await checkAndGenerateMissing(); return; }

    // --- g) Fallback de edición libre (día visible / ciudad activa) ---
    const targetCity = workingCity || S().activeCity;
    const cityHint = targetCity ? `Active city: ${targetCity}` : '';
    (S().session||[]).push({role:'user', content:text});
    const prompt = `
${FORMAT}
Edit the current plan. ${cityHint}
Scope: Modifica SOLO la ciudad activa o la mencionada por el usuario; no toques otras ciudades.
Existing plan (keep & adjust): ${getItineraryContext()}
Existing meta (per city): ${getCityMetaContext()}
Si el usuario pide añadir/ajustar actividades o destinos, responde con B/C/A. No envíes texto plano.
Solicitud: ${text}`.trim();

    try{
      const ans = await callAgent(prompt);
      const parsed = P.api.parseJSON(ans);
      if(parsed){
        applyParsedToState(parsed,false);
        renderCityTabs(); patch({activeCity: targetCity||S().activeCity}); renderCityItinerary(targetCity||S().activeCity);
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

  // ======== Enlace Enter/Send (evita doble registro) ========
  function bindUI(){
    const P = reqPlanner();
    const {$send,$intake} = P.dom;
    if($send && !$send.dataset.chatBound){
      $send.addEventListener('click', sendChat);
      $send.dataset.chatBound = '1';
    }
    if($intake && !$intake.dataset.chatBound){
      $intake.addEventListener('keydown', (e)=>{
        if(e.key==='Enter'){ e.preventDefault(); sendChat(); }
      });
      $intake.dataset.chatBound = '1';
    }
  }

  // Arranque
  try{
    bindUI();
    console.log('✅ planner-chat.js v4 activo.');
  }catch(err){
    console.error('⛔ planner-chat.js no pudo inicializarse:', err);
  }
})();

