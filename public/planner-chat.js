// public/planner-chat.js
(function(){
  // --- Conexión al puente expuesto por Webflow ---
  const PL = window.__planner;
  if(!PL){ console.error('Planner bridge not found'); return; }

  // Desempaquetar referencias necesarias
  const { state, statePatch } = PL;
  const { $send, $intake } = PL.dom;
  const { normalize, extractInt, parseTimesFromText, updateSavedDays } = PL.helpers;
  const { callAgent, parseJSON, getItineraryContext, getCityMetaContext, generateCityItinerary, applyParsedToState, ensureDays, upsertCityMeta } = PL.api;
  const { renderCityTabs, renderCityItinerary, msg, askForNextCityMeta, maybeGenerateAllCities } = PL.ui;

  // ===== SECCIÓN 14: Chat principal / edición interactiva =====
  /* ============ Chat libre (incluye fase de meta y edición) ============ */
  function userWantsReplace(text){
    const t=(text||'').toLowerCase();
    return /(sustituye|reemplaza|cambia todo|replace|overwrite|desde cero|todo nuevo|reformula|plantea de nuevo)/i.test(t);
  }

  function isAcceptance(text){
    const t=(text||'').toLowerCase().trim();
    return /(^|\b)(ok|listo|esta bien|perfecto|de acuerdo|vale|sounds good|looks good|c’est bon|tout bon|beleza|ta bom)\b/.test(t);
  }

  async function sendChat(){
    const text = ($intake.value||'').trim();
    if(!text) return;
    msg(text,'user'); 
    $intake.value='';

    // ======= Fase 1: recopilación secuencial de meta =======
    if(state.collectingMeta){
      const city = state.savedDestinations[state.metaProgressIndex]?.city;
      if(!city){ statePatch({collectingMeta:false}); await maybeGenerateAllCities(); return; }

      const extractPrompt = `
Extrae del texto la meta para la ciudad "${city}" en formato D del esquema:
${FORMAT}
Devuelve SOLO:
{"meta":{"city":"${city}","baseDate":"DD/MM/YYYY","start":"HH:MM" o ["HH:MM",...],"end":"HH:MM" o ["HH:MM",...],"hotel":"Texto"}}
Texto del usuario: ${text}`.trim();

      const answer = await callAgent(extractPrompt);
      const parsed = parseJSON(answer);
      if(parsed?.meta){
        upsertCityMeta(parsed.meta);
        msg(\`Perfecto, tengo la información para \${city}.\`);
        statePatch({metaProgressIndex: state.metaProgressIndex + 1});
        if(state.metaProgressIndex < state.savedDestinations.length){
          await askForNextCityMeta();
        }else{
          statePatch({collectingMeta:false});
          msg('Perfecto 🎉 Ya tengo toda la información. Generando itinerarios...');
          await maybeGenerateAllCities();
        }
      }else{
        msg('No logré entender. ¿Podrías repetir la fecha del primer día, horarios y hotel/zona?');
      }
      return;
    }

    // ======= Fase 2: conversación normal (edición libre) =======
    const tNorm = normalize(text);
    let handled = false;

    // --- a) Agregar días
    if(/\b(agrega|añade|sumar?|add)\b.*\bdía/.test(tNorm) || /\b(un dia mas|1 dia mas)\b/.test(tNorm)){
      const addN = extractInt(tNorm);
      const hasActivity = /\b(segovia|toledo|tour|excursion|museo|visita|actividad|paseo)\b/i.test(tNorm);
      const activityDesc = hasActivity ? text : null;
      const activeCity = state.activeCity;

      if(activeCity){
        const current = state.savedDestinations.find(x=>x.city===activeCity)?.days 
          || Object.keys(state.itineraries[activeCity]?.byDay||{}).length || 1;
        const newDays = current + addN;
        updateSavedDays(activeCity, newDays);
        ensureDays(activeCity);

        if(hasActivity){
          const prompt = `
${FORMAT}
Edita el itinerario para "${activeCity}" agregando ${addN} día${addN>1?'s':''} adicionales.
Incluye la siguiente actividad: "${activityDesc}".
No elimines días existentes, inserta al final en formato B (JSON).
`.trim();
          const answer = await callAgent(prompt);
          const parsed = parseJSON(answer);
          if(parsed){ applyParsedToState(parsed,false); }
        }else{
          await generateCityItinerary(activeCity);
        }

        renderCityTabs();
        renderCityItinerary(activeCity);
        msg(\`He añadido \${addN} día\${addN>1?'s':''} en \${activeCity}.\`);
      }
      handled = true;
    }

    // --- b) Quitar días
    if(!handled && /\b(quita|elimina|remueve|remove)\b.*\bdía/.test(tNorm)){
      const remN = extractInt(tNorm);
      const activeCity = state.activeCity;
      if(activeCity){
        const current = state.savedDestinations.find(x=>x.city===activeCity)?.days 
          || Object.keys(state.itineraries[activeCity]?.byDay||{}).length || 1;
        const newDays = Math.max(1, current - remN);
        updateSavedDays(activeCity, newDays);
        ensureDays(activeCity);
        renderCityTabs();
        renderCityItinerary(activeCity);
        msg(\`He quitado \${remN} día\${remN>1?'s':''} en \${activeCity}.\`);
      }
      handled = true;
    }

    // --- c) Sustituir actividades específicas
    if(!handled && /\b(sustituye|reemplaza|cambia|no quiero|quita esta|modifica esta)\b/.test(tNorm)){
      const activeCity = state.activeCity;
      const targetDay = /día\s*(\d+)/i.exec(tNorm);
      const dayNum = targetDay ? parseInt(targetDay[1]) : null;
      if(activeCity){
        const prompt = `
${FORMAT}
Edita el itinerario actual de "${activeCity}"${dayNum?` para el día ${dayNum}`:''}, 
eliminando o sustituyendo las actividades mencionadas por el usuario según esta instrucción:
"${text}"
Optimiza las horas restantes sin repetir actividades de otros días.
`.trim();
        const answer = await callAgent(prompt);
        const parsed = parseJSON(answer);
        if(parsed){
          applyParsedToState(parsed,false);
          renderCityTabs();
          renderCityItinerary(activeCity);
          msg(parsed.followup || 'He aplicado los cambios y optimizado el día.');
        }else{
          msg('No logré entender qué actividad sustituir. ¿Podrías indicarlo de nuevo?');
        }
      }
      handled = true;
    }

    // --- d) Reordenar días o replanificar
    if(!handled && /\b(reordena|reorganiza|cambia el orden|mueve el día|planifica de nuevo)\b/.test(tNorm)){
      const activeCity = state.activeCity;
      if(activeCity){
        const prompt = `
${FORMAT}
Reorganiza el itinerario de "${activeCity}" según la instrucción:
"${text}"
Ajusta actividades para mantener un flujo lógico y optimizado.
`.trim();
        const ans = await callAgent(prompt);
        const parsed = parseJSON(ans);
        if(parsed){
          applyParsedToState(parsed,false);
          renderCityTabs();
          renderCityItinerary(activeCity);
          msg(parsed.followup || 'He reorganizado el itinerario de forma optimizada.');
        }
      }
      handled = true;
    }

    // --- e) Recalcular itinerario completo
    if(!handled && /\b(recalcula|replanifica|recompute|replan|recalculate|reformula)\b/.test(tNorm)){
      const activeCity = state.activeCity;
      if(activeCity){
        await generateCityItinerary(activeCity);
        renderCityTabs();
        renderCityItinerary(activeCity);
        msg(\`Recalculé el itinerario de \${activeCity}.\`);
      }
      handled = true;
    }

    // --- f) Nueva ciudad o eliminación de ciudad
    if(!handled && /\b(agrega|añade|nueva|nueva ciudad)\b.*\bciudad\b/.test(tNorm)){
      const match = text.match(/\b(ciudad|city|destino)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/);
      if(match){
        const newCity = match[2];
        state.savedDestinations.push({city:newCity, days:2, order:state.savedDestinations.length+1});
        msg(\`He agregado \${newCity}. ¿Cuántos días deseas quedarte allí?\`);
      }
      handled = true;
    }

    if(!handled && /\b(elimina|borra|quita)\b.*\b(ciudad|destino)\b/.test(tNorm)){
      const match = text.match(/\b(ciudad|destino)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/);
      if(match){
        const cityName = match[2];
        state.savedDestinations = state.savedDestinations.filter(c=>c.city!==cityName);
        delete state.itineraries[cityName];
        renderCityTabs();
        msg(\`He eliminado la ciudad \${cityName}.\`);
      }
      handled = true;
    }

    // --- g) Cambios generales con IA
    if(!handled){
      const activeCity = state.activeCity;
      const cityHint = activeCity ? \`Active city: \${activeCity}\` : '';
      const prompt = \`${FORMAT}
Edita el itinerario actual. \${cityHint}
Itinerario actual: \${getItineraryContext()}
Metadatos: \${getCityMetaContext()}
Solicitud: \${text}\`;

      try{
        const ans = await callAgent(prompt);
        const parsed = parseJSON(ans);
        if(parsed){
          applyParsedToState(parsed,false);
          renderCityTabs();
          renderCityItinerary(activeCity);
          msg(parsed.followup || 'He aplicado los cambios y optimizado el itinerario.');
        }else{
          msg(ans || 'Listo. ¿Deseas otro ajuste?');
        }
      }catch(e){
        console.error(e);
        msg('❌ Error de conexión.');
      }
    }
  }

  $send.addEventListener('click', sendChat);
  $intake.addEventListener('keydown',(e)=>{
    if(e.key==='Enter'){ e.preventDefault(); sendChat(); }
  });
})();
