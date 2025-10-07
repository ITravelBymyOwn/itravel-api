// ===== SECCIÓN 14: Chat principal / edición interactiva =====
/* ============ Chat libre (incluye fase de meta y edición) ============ */
function userWantsReplace(text){
  const t=(text||'').toLowerCase();
  return /(sustituye|reemplaza|cambia todo|replace|overwrite|desde cero|todo nuevo)/i.test(t);
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
  if(collectingMeta){
    const city = savedDestinations[metaProgressIndex]?.city;
    if(!city){ collectingMeta=false; await maybeGenerateAllCities(); return; }

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
      awaitingMetaReply = false;
      msg(`Perfecto, tengo la información para ${city}.`);
      metaProgressIndex++;
      if(metaProgressIndex < savedDestinations.length){
        await askForNextCityMeta();
      }else{
        collectingMeta = false;
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

  // --- a) Agregar días (exactos)
  if(/\b(agrega|añade|sumar?|add)\b.*\bdía/.test(tNorm) || /\b(un dia mas|1 dia mas)\b/.test(tNorm)){
    const addN = extractInt(tNorm);
    const hasActivity = /\b(segovia|toledo|tour|excursion|museo|visita|actividad|paseo)\b/i.test(tNorm);
    const activityDesc = hasActivity ? text : null;

    if(activeCity){
      const current = savedDestinations.find(x=>x.city===activeCity)?.days 
        || Object.keys(itineraries[activeCity]?.byDay||{}).length || 1;
      const newDays = current + addN;
      updateSavedDays(activeCity, newDays);
      ensureDays(activeCity);

      if(hasActivity){
        // Generar día con actividad específica
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
      setActiveCity(activeCity);
      msg(`He añadido ${addN} día${addN>1?'s':''} en ${activeCity}.`);
    }
    handled = true;
  }

  // --- b) Quitar días
  if(!handled && /\b(quita|elimina|remueve|remove)\b.*\bdía/.test(tNorm)){
    const remN = extractInt(tNorm);
    if(activeCity){
      const current = savedDestinations.find(x=>x.city===activeCity)?.days 
        || Object.keys(itineraries[activeCity]?.byDay||{}).length || 1;
      const newDays = Math.max(1, current - remN);
      updateSavedDays(activeCity, newDays);
      ensureDays(activeCity);
      renderCityTabs();
      msg(`He quitado ${remN} día${remN>1?'s':''} en ${activeCity}.`);
    }
    handled = true;
  }

  // --- c) Ajuste de horas naturales
  if(!handled && /\b(hora|horario|inicio|fin|empieza|termina|ajusta|cambia)\b/.test(tNorm)){
    const times = parseTimesFromText(text);
    if(activeCity && times.length){
      cityMeta[activeCity] = cityMeta[activeCity] || { baseDate:null, start:null, end:null, hotel:'' };
      if(times.length===1){
        if(/\b(hasta|termina|fin)\b/.test(tNorm)) cityMeta[activeCity].end = times[0];
        else cityMeta[activeCity].start = times[0];
      }else{
        cityMeta[activeCity].start = times[0];
        cityMeta[activeCity].end = times[times.length-1];
      }
      await generateCityItinerary(activeCity);
      renderCityTabs();
      setActiveCity(activeCity);
      msg(`He ajustado las horas en ${activeCity}.`);
    }
    handled = true;
  }

  // --- d) Recalcular itinerario
  if(!handled && /\b(recalcula|replanifica|recompute|replan|recalculate)\b/.test(tNorm)){
    if(activeCity){
      await generateCityItinerary(activeCity);
      renderCityTabs();
      setActiveCity(activeCity);
      msg(`Recalculé el itinerario de ${activeCity}.`);
    }
    handled = true;
  }

  if(handled) return;

  // --- e) Cambios o inserciones guiadas
  session.push({role:'user', content:text});
  const cityHint = activeCity ? `Active city: ${activeCity}` : '';
  const prompt = `${FORMAT}
Edit the current plan. ${cityHint}
Existing plan (keep & adjust): ${getItineraryContext()}
Existing meta (per city): ${getCityMetaContext()}
Si el usuario pide añadir/ajustar actividades o destinos, responde con B/C/A.
Solicitud del usuario: ${text}`;

  try{
    const answer = await callAgent(prompt);
    const parsed = parseJSON(answer);
    if(parsed){
      applyParsedToState(parsed,false);
      renderCityTabs();
      setActiveCity(activeCity);
      msg(parsed.followup || '¿Deseas otro ajuste?','ai');
    }else{
      msg(answer || 'Listo. ¿Otra cosa?','ai');
    }
  }catch(e){
    console.error(e);
    msg('❌ Error de conexión.','ai');
  }
}

$send.addEventListener('click', sendChat);
$intake.addEventListener('keydown',(e)=>{
  if(e.key==='Enter'){ e.preventDefault(); sendChat(); }
});
