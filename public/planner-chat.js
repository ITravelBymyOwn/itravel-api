// ==========================================================
// planner-chat.js — Motor completo de la SECCIÓN 14 (chat libre e inteligente)
// Versión: v2  (pensado para ser cargado como https://.../planner-chat.js?v=2)
// ==========================================================
(() => {
  console.log("🟣 planner-chat.js v2 — inicializando…");

  // Espera robusta a que el puente esté listo (estado + api + dom)
  function waitForBridge(maxMs = 12000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function poll(){
        const P = window.__planner;
        const ok = P && P.state && P.api && P.dom && P.config && typeof P.api.msg === 'function';
        const domOk = ok && (P.dom.intake || document.querySelector('#intake')) && (P.dom.send || document.querySelector('#send-btn'));
        if (ok && domOk) return resolve(P);
        if (Date.now() - t0 > maxMs) return reject(new Error('Bridge timeout'));
        setTimeout(poll, 60);
      })();
    });
  }

  // ===== util local
  function safeNode(n){ return (typeof n === 'function') ? n() : n; }

  // ===== arranque
  waitForBridge().then((P) => {
    const S   = P.state;   // estado vivo (proxies)
    const A   = P.api;     // funciones de Webflow exportadas
    const DOM = P.dom;     // referencias DOM (getters)
    const CFG = P.config;  // { FORMAT }

    // =============================
    // ======== SECCIÓN 14 =========
    // =============================

    /* ============ Chat libre (incluye fase de meta y edición) ============ */
    function userWantsReplace(text){
      const t=(text||'').toLowerCase();
      return /(sustituye|reemplaza|cambia todo|replace|overwrite|desde cero|todo nuevo)/i.test(t);
    }

    function isAcceptance(text){
      const t=(text||'').toLowerCase().trim();
      return /(^|\b)(ok|listo|esta bien|perfecto|de acuerdo|vale|sounds good|looks good|c’est bon|tout bon|beleza|ta bom)\b/.test(t);
    }

    /* ==== Helpers extendidos de NL ==== */
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
      if(!S.itineraries[city] || !keyword) return 0;
      const kw = normalizeActivityString(keyword);
      const targetDays = dayOrNull ? [dayOrNull] : Object.keys(S.itineraries[city].byDay||{}).map(n=>parseInt(n,10));
      let removed = 0;
      targetDays.forEach(d=>{
        const rows = S.itineraries[city].byDay?.[d] || [];
        const before = rows.length;
        S.itineraries[city].byDay[d] = rows.filter(r => !normalizeActivityString(r.activity||'').includes(kw));
        removed += Math.max(0, before - (S.itineraries[city].byDay[d]||[]).length);
      });
      A.ensureDays(city);
      return removed;
    }
    function findCityInText(text){
      const t = A.normalize(text);
      for(const {city} of (S.savedDestinations||[])){
        if(t.includes(A.normalize(city))) return city;
      }
      return null;
    }
    function resolveDayNumber(city, dayScope){
      if(dayScope === 'LAST'){
        const days = Object.keys(S.itineraries[city]?.byDay||{}).map(n=>parseInt(n,10));
        return days.length ? Math.max(...days) : 1;
      }
      return dayScope || null;
    }
    async function checkAndGenerateMissing(){
      for(const {city} of (S.savedDestinations||[])){
        const m = S.cityMeta[city];
        const hasRows = Object.values(S.itineraries[city]?.byDay || {}).some(a => a.length > 0);
        if(typeof A.metaIsComplete === 'function' && A.metaIsComplete(m) && !hasRows){
          await A.generateCityItinerary(city);
        }
      }
    }

    /* ==== Chat principal ==== */
    async function sendChat(){
      const $intake = safeNode(DOM.intake) || document.querySelector('#intake');
      const text = ($intake?.value||'').trim();
      if(!text) return;
      A.msg(text,'user');
      if($intake) $intake.value='';

      // ======= Fase 1: recopilación secuencial de meta =======
      if(S.collectingMeta){
        const city = S.savedDestinations[S.metaProgressIndex]?.city;
        if(!city){ S.collectingMeta=false; await A.maybeGenerateAllCities(); return; }

        const extractPrompt = `
Extrae del texto la meta para la ciudad "${city}" en formato D del esquema:
${CFG.FORMAT}
Devuelve SOLO:
{"meta":{"city":"${city}","baseDate":"DD/MM/YYYY","start":"HH:MM" o ["HH:MM",...],"end":"HH:MM" o ["HH:MM",...],"hotel":"Texto"}}
Texto del usuario: ${text}`.trim();

        const answer = await A.callAgent(extractPrompt);
        const parsed = A.parseJSON(answer);

        if(parsed?.meta){
          A.upsertCityMeta(parsed.meta);
          S.awaitingMetaReply = false;
          A.msg(`Perfecto, tengo la información para ${city}.`);
          S.metaProgressIndex++;
          if(S.metaProgressIndex < (S.savedDestinations||[]).length){
            // Pregunta por la siguiente ciudad
            const next = S.savedDestinations[S.metaProgressIndex].city;
            const isFirst = S.metaProgressIndex === 0;
            A.msg(isFirst ? `Comencemos por **${next}**…` : `Continuemos con **${next}**…`);
          }else{
            S.collectingMeta = false;
            A.msg('Perfecto 🎉 Ya tengo toda la información. Generando itinerarios...');
            await A.maybeGenerateAllCities();
          }
        }else{
          A.msg('No logré entender. ¿Podrías repetir la fecha del primer día, horarios y hotel/zona?');
        }
        return;
      }

      // ======= Fase 2: conversación normal =======
      const tNorm = A.normalize(text);
      let handled = false;

      // Detectar si el usuario mencionó otra ciudad explícitamente
      const cityFromText = findCityInText(text);
      const workingCity = cityFromText || S.activeCity;
      if(cityFromText && cityFromText !== S.activeCity){
        A.setActiveCity(cityFromText);
        A.renderCityItinerary(cityFromText);
      }

      // --- a) Agregar días ---
      if(/\b(agrega|añade|sumar?|add)\b.*\bd[ií]a/.test(tNorm) || /\b(un dia mas|1 dia mas)\b/.test(tNorm)){
        const addN = A.extractInt(tNorm);
        const hasActivity = /\b(tour|excursion|visita|museo|paseo|segovia|toledo|montserrat|catedral|parque|mercado|playa|ruta)\b/i.test(text);
        const activityDesc = hasActivity ? text : null;

        if(workingCity){
          const current = (S.savedDestinations.find(x=>x.city===workingCity)?.days) 
            || Object.keys(S.itineraries[workingCity]?.byDay||{}).length || 1;
          const newDays = current + addN;
          A.updateSavedDays(workingCity,newDays);
          A.ensureDays(workingCity);

          if(hasActivity){
            const prompt = `
${CFG.FORMAT}
Edita el itinerario de "${workingCity}" agregando ${addN} día${addN>1?'s':''}.
Incluye como actividad principal: "${activityDesc}" en el/los día(s) nuevo(s) y completa con otras actividades no repetidas.
No elimines días previos.
Devuelve SOLO JSON con "destination":"${workingCity}".`.trim();
            const ans = await A.callAgent(prompt);
            const parsed = A.parseJSON(ans);
            if(parsed){ A.applyParsedToState(parsed,false); }
          }else{
            await A.generateCityItinerary(workingCity);
          }

          A.renderCityTabs();
          A.setActiveCity(workingCity);
          A.renderCityItinerary(workingCity);
          A.msg(`He añadido ${addN} día${addN>1?'s':''} en ${workingCity}.`);
        }
        handled = true;
      }

      // --- b) Quitar días ---
      if(!handled && (/\b(quita|elimina|remueve|remove)\b.*\bd[ií]a/.test(tNorm) || /\b(ultimo|último)\s+d[ií]a\b/i.test(tNorm))){
        const remN = /\b\d+\b/.test(tNorm) ? A.extractInt(tNorm) : 1;
        const targetCity = workingCity;
        if(targetCity){
          const current = (S.savedDestinations.find(x=>x.city===targetCity)?.days) 
            || Object.keys(S.itineraries[targetCity]?.byDay||{}).length || 1;
          const newDays = Math.max(1, current - remN);
          A.updateSavedDays(targetCity,newDays);
          // Eliminar últimos remN días
          const keys = Object.keys(S.itineraries[targetCity]?.byDay||{}).map(d=>parseInt(d,10)).sort((a,b)=>b-a);
          keys.slice(0,remN).forEach(k=>delete S.itineraries[targetCity].byDay[k]);
          A.ensureDays(targetCity);
          A.renderCityTabs();
          A.setActiveCity(targetCity);
          A.renderCityItinerary(targetCity);
          A.msg(`He quitado ${remN} día${remN>1?'s':''} en ${targetCity}.`);
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
${CFG.FORMAT}
En "${targetCity}" ${dayN?`(día ${dayN})`:''} elimina "${oldK}" y sustitúyelo por actividades basadas en "${newK}".
Mantén coherencia de horarios y no repitas con lo ya existente.
Devuelve SOLO JSON formato B con "destination":"${targetCity}".`.trim();
            const ans = await A.callAgent(swapPrompt);
            const parsed = A.parseJSON(ans);
            if(parsed){ 
              A.applyParsedToState(parsed,false);
              A.renderCityTabs(); A.setActiveCity(targetCity); A.renderCityItinerary(targetCity);
              A.msg(removed>0?`Sustituí "${oldK}" por "${newK}" en ${targetCity}.`:`Añadí actividades de "${newK}" en ${targetCity}.`,'ai');
            }else{
              A.msg(`Eliminé "${oldK}". ¿Qué tipo de actividad quieres en su lugar?`,'ai');
            }
            handled = true;
          }else if (/(quita|elimina|remueve|cancelar|no\s+(?:quiero|deseo))/i.test(text)){
            const keyword = extractRemovalKeyword(text);
            if(keyword){
              const removed = removeActivityRows(targetCity, dayN, keyword);
              A.renderCityTabs(); A.setActiveCity(targetCity); A.renderCityItinerary(targetCity);

              if(removed>0 && hasAskForAlternative(text)){
                const altPrompt = `
${CFG.FORMAT}
En "${targetCity}" ${dayN?`(día ${dayN})`:''} el usuario quitó "${keyword}".
Propón y añade nuevas actividades equivalentes o alternativas (sin repetir otras del mismo día).
Devuelve SOLO JSON formato B con "destination":"${targetCity}".`.trim();
                const ans = await A.callAgent(altPrompt);
                const parsed = A.parseJSON(ans);
                if(parsed){
                  A.applyParsedToState(parsed,false);
                  A.renderCityTabs(); A.setActiveCity(targetCity); A.renderCityItinerary(targetCity);
                  A.msg(`He sustituido "${keyword}" por nuevas actividades en ${targetCity}.`,'ai');
                }else{
                  A.msg(`He eliminado "${keyword}". Puedo sugerir alternativas si me dices el tipo que prefieres.`,'ai');
                }
              }else{
                A.msg(removed>0?`He eliminado "${keyword}" ${dayN?`del día ${dayN}`:''} en ${targetCity}.`:`No encontré "${keyword}" ${dayN?`en el día ${dayN}`:''}.`,'ai');
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
${CFG.FORMAT}
El usuario quiere más detalle ${dayN?`del día ${dayN} `:''}en "${targetCity}".
Amplía descripciones, incluye contexto, tiempos realistas y recomendaciones. No dupliques con el resto de días.
Devuelve SOLO JSON formato B para "destination":"${targetCity}" ${dayN?`limitado al día ${dayN}`:''}.`.trim();
          const ans = await A.callAgent(detailPrompt);
          const parsed = A.parseJSON(ans);
          if(parsed){
            A.applyParsedToState(parsed,false);
            A.renderCityTabs(); A.setActiveCity(targetCity); A.renderCityItinerary(targetCity);
            A.msg(`He detallado las actividades ${dayN?`del día ${dayN} `:''}en ${targetCity}.`,'ai');
          }else{
            A.msg('No pude detallar actividades.','ai');
          }
        }
        handled = true;
      }

      // --- e) Ajuste de horas naturales ---
      if(!handled && /\b(hora|horario|inicio|fin|empieza|termina|ajusta|cambia)\b/.test(tNorm)){
        const times = A.parseTimesFromText(text);
        const targetCity = workingCity;
        if(targetCity && times.length){
          S.cityMeta[targetCity] = S.cityMeta[targetCity] || { baseDate:null, start:null, end:null, hotel:'' };
          if(times.length === 1){
            if(/\b(hasta|termina|fin)\b/.test(tNorm)) S.cityMeta[targetCity].end = times[0];
            else S.cityMeta[targetCity].start = times[0];
          }else{
            S.cityMeta[targetCity].start = times[0];
            S.cityMeta[targetCity].end = times[times.length-1];
          }
          await A.generateCityItinerary(targetCity);
          A.renderCityTabs(); A.setActiveCity(targetCity); A.renderCityItinerary(targetCity);
          A.msg(`He ajustado las horas en ${targetCity}.`);
        }
        handled = true;
      }

      // --- f) Recalcular itinerario ---
      if(!handled && /\b(recalcula|replanifica|recompute|replan|recalculate|actualiza|regen|optimiza)\b/.test(tNorm)){
        const targetCity = workingCity;
        if(targetCity){
          await A.generateCityItinerary(targetCity);
          A.renderCityTabs(); A.setActiveCity(targetCity); A.renderCityItinerary(targetCity);
          A.msg(`He recalculado el itinerario de ${targetCity}.`);
        }
        handled = true;
      }

      // Si ya resolvimos algo, verifica si hay ciudades pendientes
      if(handled){
        await checkAndGenerateMissing();
        return;
      }

      // --- g) Edición libre general (fallback) ---
      S.session.push({role:'user', content:text});
      const cityHint = workingCity ? `Active city: ${workingCity}` : '';
      const prompt = `
${CFG.FORMAT}
Edit the current plan. ${cityHint}
Scope: Modifica SOLO la ciudad activa o la mencionada por el usuario; no toques otras ciudades.
Existing plan (keep & adjust): ${A.getItineraryContext()}
Existing meta (per city): ${A.getCityMetaContext()}
Si el usuario pide añadir/ajustar actividades o destinos, responde con B/C/A. No envíes texto plano.
Solicitud: ${text}`.trim();

      try{
        const ans = await A.callAgent(prompt);
        const parsed = A.parseJSON(ans);
        if(parsed){
          A.applyParsedToState(parsed,false);
          A.renderCityTabs(); A.setActiveCity(workingCity||S.activeCity); A.renderCityItinerary(workingCity||S.activeCity);
          A.msg(parsed.followup || '¿Deseas otro ajuste?','ai');
        }else{
          A.msg(ans || 'Listo. ¿Otra cosa?','ai');
        }
        await checkAndGenerateMissing();
      }catch(e){
        console.error(e);
        A.msg('❌ Error de conexión.','ai');
      }
    }

    // ==== EVENTOS ====
    // Evita doble enlace si el script se recarga
    if (!window.__plannerWiredV2) {
      window.__plannerWiredV2 = true;

      const $send   = safeNode(DOM.send)   || document.querySelector('#send-btn');
      const $intake = safeNode(DOM.intake) || document.querySelector('#intake');

      if($send)   $send.addEventListener('click', sendChat);
      if($intake) $intake.addEventListener('keydown', (e)=>{
        if(e.key==='Enter'){ e.preventDefault(); sendChat(); }
      });
    }

    console.log("✅ planner-chat.js v2: puente enlazado y eventos activos.");
  }).catch(err=>{
    console.error("❌ planner-chat.js v2 no pudo iniciar:", err);
  });
})();
