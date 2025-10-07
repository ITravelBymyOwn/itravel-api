/* ========================================================================
   planner-chat.js  (SECCIÓN 14 — motor de chat / edición interactiva)
   Modo: standalone sobre Webflow usando el puente window.__planner
   ======================================================================== */
(()=>{

  // -------- util: espera a que el puente esté disponible --------
  function waitForPlanner(maxMs=8000){
    return new Promise((resolve,reject)=>{
      const t0 = Date.now();
      (function poll(){
        const PL = window.__planner;
        if(PL && PL.helpers && PL.api && PL.ui) return resolve(PL);
        if(Date.now()-t0>maxMs) return reject(new Error('window.__planner no disponible'));
        setTimeout(poll,50);
      })();
    });
  }

  // -------- util: obtén un nodo con fallback por selectores --------
  function pickNode(primary, fallbacks){
    if(primary) return primary;
    for(const sel of (fallbacks||[])){
      const n = document.querySelector(sel);
      if(n) return n;
    }
    return null;
  }

  // -------- inicio principal --------
  waitForPlanner().then((PL)=>{
    console.log('✅ planner-chat.js loaded (standalone mode)');

    // ------- shortcuts a helpers / api / ui / estado -------
    const H = PL.helpers;  // { qs,qsa, normalize, extractInt, parseTimesFromText, updateSavedDays }
    const API = PL.api;    // { callAgent, parseJSON, getItineraryContext, getCityMetaContext, generateCityItinerary, applyParsedToState, ensureDays, upsertCityMeta }
    const UI  = PL.ui;     // { renderCityTabs, renderCityItinerary, msg, askForNextCityMeta, maybeGenerateAllCities }

    // estado vivo (leer SIEMPRE desde getters de PL.state)
    const S = ()=>PL.state;
    const PATCH = (p)=>PL.statePatch = p;

    // ------- util NL simples (compatibles con tu versión previa) -------
    function userWantsReplace(text){
      const t=(text||'').toLowerCase();
      return /(sustituye|reemplaza|cambia todo|replace|overwrite|desde cero|todo nuevo)/i.test(t);
    }
    function isAcceptance(text){
      const t=(text||'').toLowerCase().trim();
      return /(^|\b)(ok|listo|esta bien|perfecto|de acuerdo|vale|sounds good|looks good|c’est bon|tout bon|beleza|ta bom)\b/.test(t);
    }

    // ---- Helpers extendidos (usados por el flujo) ----
    function getDayScopeFromText(text){
      const m = (text||'').match(/\bd[ií]a\s+(\d{1,2})\b/i);
      if (m) return Math.max(1, parseInt(m[1],10));
      if (/\b(ultimo|último)\s+d[ií]a\b/i.test(text||'')) return 'LAST';
      return null;
    }
    function resolveDayNumber(city, dayScope){
      const st = S();
      if(dayScope === 'LAST'){
        const days = Object.keys(st.itineraries[city]?.byDay||{}).map(n=>parseInt(n,10));
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
      const st = S();
      if(!st.itineraries[city] || !keyword) return 0;
      const kw = normalizeActivityString(keyword);
      const targetDays = dayOrNull ? [dayOrNull] : Object.keys(st.itineraries[city].byDay||{}).map(n=>parseInt(n,10));
      let removed = 0;
      targetDays.forEach(d=>{
        const rows = st.itineraries[city].byDay?.[d] || [];
        const before = rows.length;
        st.itineraries[city].byDay[d] = rows.filter(r => !normalizeActivityString(r.activity||'').includes(kw));
        removed += Math.max(0, before - (st.itineraries[city].byDay[d]||[]).length);
      });
      API.ensureDays(city);
      return removed;
    }
    function findCityInText(text){
      const t = H.normalize(text||'');
      for(const {city} of S().savedDestinations){
        if(t.includes(H.normalize(city))) return city;
      }
      return null;
    }
    function getVisibleDay(city){
      const btn = document.querySelector('.pager .active');
      if(btn && /^\d+$/.test(btn.textContent.trim())) return parseInt(btn.textContent.trim(),10);
      return S().itineraries[city]?.currentDay || 1;
    }
    function getDayRowsAsText(city, day){
      const rows = S().itineraries[city]?.byDay?.[day] || [];
      if(!rows.length) return "No hay actividades registradas.";
      return rows.map(r=>`De ${r.start} a ${r.end}: ${r.activity} (${r.from} → ${r.to}, ${r.transport}, ${r.duration}). Notas: ${r.notes}`).join("\n");
    }
    function getAllDaysContextAsText(city){
      const byDay = S().itineraries[city]?.byDay || {};
      const days = Object.keys(byDay).map(n=>parseInt(n,10)).sort((a,b)=>a-b);
      if(!days.length) return "Sin días aún.";
      return days.map(d=>{
        const rows = byDay[d]||[];
        if(!rows.length) return `Día ${d}: (vacío)`;
        const items = rows.map(r=>`• ${r.start}-${r.end} ${r.activity}`).join('\n');
        return `Día ${d}:\n${items}`;
      }).join('\n\n');
    }

    // ---- ciudades por chat (alta/baja) ----
    function addCityFromChat(name, days=1){
      const st = S();
      const order = st.savedDestinations.length ? Math.max(...st.savedDestinations.map(x=>x.order)) + 1 : 1;
      st.savedDestinations.push({city:name, days:Math.max(1,days), order});
      if(!st.itineraries[name]) st.itineraries[name] = { byDay:{}, currentDay:1, baseDate:null };
      if(!st.cityMeta[name])   st.cityMeta[name] = { baseDate:null, start:null, end:null, hotel:'' };
      API.ensureDays(name);
      UI.renderCityTabs();
      PATCH({activeCity:name});
      UI.renderCityItinerary(name);
    }
    function removeCityFromChat(name){
      const st = S();
      const idx = st.savedDestinations.findIndex(x=>x.city===name);
      if(idx>=0) st.savedDestinations.splice(idx,1);
      delete st.itineraries[name];
      delete st.cityMeta[name];
      st.savedDestinations.forEach((x,i)=>x.order=i+1);
      UI.renderCityTabs();
      const next = st.savedDestinations[0]?.city || null;
      PATCH({activeCity:next});
      if(next) UI.renderCityItinerary(next);
    }

    // ---- verificación: generar ciudades pendientes si ya hay meta ----
    async function checkAndGenerateMissing(){
      const st = S();
      for(const {city} of st.savedDestinations){
        const m = st.cityMeta[city];
        const hasRows = Object.values(st.itineraries[city]?.byDay || {}).some(a => a.length > 0);
        const metaOk = !!(m && m.baseDate && m.start && m.end && typeof m.hotel === 'string');
        if(metaOk && !hasRows){
          await API.generateCityItinerary(city);
        }
      }
    }

    // =================== CHAT PRINCIPAL ===================
    async function sendChat(){
      const st = S();
      const $intake = pickNode(PL.dom.$intake, ['#intake','textarea#intake','[data-intake]','textarea']);
      if(!$intake){ console.warn('⚠️ Intake input no encontrado'); return; }

      const text = ($intake.value||'').trim();
      if(!text) return;
      UI.msg(text,'user'); 
      $intake.value='';

      // ===== Fase 1: recopilación secuencial de meta =====
      if(st.collectingMeta){
        const city = st.savedDestinations[st.metaProgressIndex]?.city;
        if(!city){ PATCH({collectingMeta:false}); await UI.maybeGenerateAllCities(); return; }

        const extractPrompt = `
Extrae del texto la meta para la ciudad "${city}" en formato D del esquema:
${FORMAT_FOR_AGENT()}
Devuelve SOLO:
{"meta":{"city":"${city}","baseDate":"DD/MM/YYYY","start":"HH:MM" o ["HH:MM",...],"end":"HH:MM" o ["HH:MM",...],"hotel":"Texto"}}
Texto del usuario: ${text}`.trim();

        const answer = await API.callAgent(extractPrompt);
        const parsed = API.parseJSON(answer);

        if(parsed?.meta){
          API.upsertCityMeta(parsed.meta);
          PATCH({awaitingMetaReply:false});
          UI.msg(`Perfecto, tengo la información para ${city}.`);
          PATCH({metaProgressIndex: st.metaProgressIndex + 1});
          if(S().metaProgressIndex < S().savedDestinations.length){
            await UI.askForNextCityMeta();
          }else{
            PATCH({collectingMeta:false});
            UI.msg('Perfecto 🎉 Ya tengo toda la información. Generando itinerarios...');
            await UI.maybeGenerateAllCities();
          }
        }else{
          UI.msg('No logré entender. ¿Podrías repetir la fecha del primer día, horarios y hotel/zona?');
        }
        return;
      }

      // ===== Fase 2: conversación normal / edición =====
      const tNorm = H.normalize(text);
      let handled = false;

      // Resolver ciudad de trabajo (mencionada o activa)
      const cityFromText = findCityInText(text);
      const workingCity = cityFromText || st.activeCity;
      if(cityFromText && cityFromText !== st.activeCity){
        PATCH({activeCity:cityFromText});
        UI.renderCityItinerary(cityFromText);
      }

      // --- Alta de ciudad desde chat ---
      if(!handled){
        const addM = /(agrega|añade|add)\s+([a-záéíóúñ\s]+?)\s+(\d{1,2})\s+d[ií]as?/i.exec(text) 
                  || /(agrega|añade|add)\s+([a-záéíóúñ\s]+)$/i.exec(text);
        if(addM){
          const name = (addM[2]||addM[1]).trim().replace(/\s+/g,' ').replace(/^\w/,c=>c.toUpperCase());
          const days = addM[3] ? parseInt(addM[3],10) : 1;
          addCityFromChat(name, days);
          UI.msg(`He agregado **${name}** con ${days} día(s). Comparte la fecha del primer día (DD/MM/AAAA), horas de inicio/fin y hotel/zona para generar el itinerario.`);
          PATCH({collectingMeta:true, awaitingMetaReply:false, metaProgressIndex: S().savedDestinations.findIndex(x=>x.city===name)});
          await UI.askForNextCityMeta();
          handled = true;
        }
      }
      // --- Baja de ciudad ---
      if(!handled){
        const rmM = /(elimina|quita|remueve)\s+(?:la\s+ciudad\s+)?([a-záéíóúñ\s]+)$/i.exec(text);
        if(rmM){
          const name = rmM[2].trim().replace(/\s+/g,' ').replace(/^\w/,c=>c.toUpperCase());
          removeCityFromChat(name);
          UI.msg(`He eliminado la ciudad **${name}**.`);
          handled = true;
        }
      }
      if(handled){ await checkAndGenerateMissing(); return; }

      // --- Agregar días ---
      if(/\b(agrega|añade|sumar?|add)\b.*\bd[ií]a/.test(tNorm) || /\b(un dia mas|1 dia mas)\b/.test(tNorm)){
        const addN = extractIntStrict(tNorm) ?? 1;
        const hasActivity = /\b(tour|excursion|visita|museo|paseo|segovia|toledo|montserrat|catedral|parque|mercado|playa|ruta)\b/i.test(text);
        const activityDesc = hasActivity ? text : null;

        if(workingCity){
          const current = S().savedDestinations.find(x=>x.city===workingCity)?.days 
            || Object.keys(S().itineraries[workingCity]?.byDay||{}).length || 1;
          const newDays = current + addN;
          H.updateSavedDays(workingCity, newDays);
          API.ensureDays(workingCity);

          if(hasActivity){
            const prompt = `
${FORMAT_FOR_AGENT()}
Edita el itinerario de "${workingCity}" agregando ${addN} día${addN>1?'s':''}.
Incluye como actividad principal: "${activityDesc}" y completa con otras actividades no repetidas ni duplicadas de otros días.
Ajusta horarios y transportes coherentemente.
Devuelve SOLO JSON con "destination":"${workingCity}".`.trim();
            const answer = await API.callAgent(prompt);
            const parsed = API.parseJSON(answer);
            if(parsed){ API.applyParsedToState(parsed,false); }
          }else{
            await API.generateCityItinerary(workingCity);
          }

          UI.renderCityTabs();
          PATCH({activeCity:workingCity});
          UI.renderCityItinerary(workingCity);
          UI.msg(`He añadido ${addN} día${addN>1?'s':''} en ${workingCity}.`);
        }
        handled = true;
      }

      // --- Quitar días (último o específico) ---
      if(!handled && (/\b(quita|elimina|remueve|remove)\b.*\bd[ií]a/.test(tNorm) || /\b(ultimo|último)\s+d[ií]a\b/i.test(tNorm))){
        const targetCity = workingCity;
        if(targetCity){
          const daySpecific = getDayScopeFromText(text);
          if(daySpecific && daySpecific !== 'LAST'){
            const dayN = resolveDayNumber(targetCity, daySpecific);
            const byDay = S().itineraries[targetCity]?.byDay || {};
            delete byDay[dayN];
            const remain = Object.keys(byDay).map(n=>parseInt(n,10)).sort((a,b)=>a-b);
            const newByDay = {};
            remain.forEach((src,i)=>{ newByDay[i+1] = (byDay[src]||[]).map(r=>({...r, day:i+1})); });
            S().itineraries[targetCity].byDay = newByDay;
            const curIdx = S().savedDestinations.findIndex(x=>x.city===targetCity);
            if(curIdx>=0) S().savedDestinations[curIdx].days = Math.max(1, remain.length);
            API.ensureDays(targetCity);
            UI.renderCityTabs(); PATCH({activeCity:targetCity}); UI.renderCityItinerary(targetCity);
            UI.msg(`He eliminado el día ${dayN} en ${targetCity}.`);
          }else{
            const remN = extractIntStrict(tNorm) ?? 1;
            const current = S().savedDestinations.find(x=>x.city===targetCity)?.days 
              || Object.keys(S().itineraries[targetCity]?.byDay||{}).length || 1;
            const newDays = Math.max(1, current - remN);
            const keys = Object.keys(S().itineraries[targetCity]?.byDay||{}).map(d=>parseInt(d,10)).sort((a,b)=>b-a);
            keys.slice(0,remN).forEach(k=>delete S().itineraries[targetCity].byDay[k]);
            H.updateSavedDays(targetCity, newDays);
            API.ensureDays(targetCity);
            UI.renderCityTabs(); PATCH({activeCity:targetCity}); UI.renderCityItinerary(targetCity);
            UI.msg(`He quitado ${remN} día${remN>1?'s':''} en ${targetCity}.`);
          }
        }
        handled = true;
      }

      // --- Sustituir / eliminar actividades (con alternativa) ---
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
${FORMAT_FOR_AGENT()}
En "${targetCity}" ${dayN?`(día ${dayN})`:''} elimina "${oldK}" y reemplázalo por actividades equivalentes basadas en "${newK}".
Ajusta horarios/duraciones/transiciones y evita duplicados.
Devuelve SOLO JSON formato B con "destination":"${targetCity}".`.trim();
            const ans = await API.callAgent(swapPrompt);
            const parsed = API.parseJSON(ans);
            if(parsed){
              API.applyParsedToState(parsed,false);
              UI.renderCityTabs(); PATCH({activeCity:targetCity}); UI.renderCityItinerary(targetCity);
              UI.msg(`He reemplazado "${oldK}" por "${newK}" y optimizado el flujo.`,'ai');
            }else UI.msg(`He eliminado "${oldK}". ¿Qué deseas hacer en su lugar?`,'ai');
          }else{
            const keyword = extractRemovalKeyword(text);
            if(keyword){
              const removed = removeActivityRows(targetCity, dayN, keyword);
              UI.renderCityTabs(); PATCH({activeCity:targetCity}); UI.renderCityItinerary(targetCity);
              if(removed>0){
                if(hasAskForAlternative(text)){
                  const altPrompt = `
${FORMAT_FOR_AGENT()}
En "${targetCity}" ${dayN?`(día ${dayN})`:''} el usuario quitó "${keyword}".
Propón nuevas actividades coherentes y optimiza la secuencia del día.
Evita repetir otras actividades de la ciudad.
Devuelve SOLO JSON formato B con "destination":"${targetCity}".`.trim();
                  const ans = await API.callAgent(altPrompt);
                  const parsed = API.parseJSON(ans);
                  if(parsed){
                    API.applyParsedToState(parsed,false);
                    UI.renderCityTabs(); PATCH({activeCity:targetCity}); UI.renderCityItinerary(targetCity);
                    UI.msg(`He sustituido "${keyword}" por alternativas optimizadas.`,'ai');
                  }
                }else UI.msg(`He eliminado "${keyword}".`,'ai');
              }else UI.msg(`No encontré "${keyword}" en ${targetCity}.`,'ai');
            }
          }
        }
        handled = true;
      }

      // --- Ajuste de horas naturales (meta) ---
      if(!handled && /\b(hora|horario|inicio|fin|empieza|termina|ajusta|cambia)\b/.test(tNorm)){
        const times = H.parseTimesFromText(text);
        const targetCity = workingCity;
        if(targetCity && times.length){
          const st2 = S();
          st2.cityMeta[targetCity] = st2.cityMeta[targetCity] || { baseDate:null, start:null, end:null, hotel:'' };
          if(times.length===1){
            if(/\b(hasta|termina|fin)\b/.test(tNorm)) st2.cityMeta[targetCity].end = times[0];
            else st2.cityMeta[targetCity].start = times[0];
          }else{
            st2.cityMeta[targetCity].start = times[0];
            st2.cityMeta[targetCity].end = times[times.length-1];
          }
          await API.generateCityItinerary(targetCity);
          UI.renderCityTabs(); PATCH({activeCity:targetCity}); UI.renderCityItinerary(targetCity);
          UI.msg(`He ajustado las horas en ${targetCity}.`);
        }
        handled = true;
      }

      // --- Replantear completo (desde cero) ---
      if(!handled && /(replantea|vuelve a plantear|nuevo plan|desde cero|reset(?:ea)?|comienza de nuevo|hazlo de nuevo)\b/i.test(tNorm)){
        const targetCity = workingCity;
        if(targetCity){
          S().itineraries[targetCity].byDay = {};
          await API.generateCityItinerary(targetCity);
          UI.renderCityTabs(); PATCH({activeCity:targetCity}); UI.renderCityItinerary(targetCity);
          UI.msg(`He replanteado por completo el itinerario de ${targetCity}.`);
        }
        handled = true;
      }

      // --- Recalcular ciudad completa ---
      if(!handled && /\b(recalcula|replanifica|recompute|replan|recalculate|actualiza)\b/.test(tNorm)){
        const targetCity = workingCity;
        if(targetCity){
          await API.generateCityItinerary(targetCity);
          UI.renderCityTabs(); PATCH({activeCity:targetCity}); UI.renderCityItinerary(targetCity);
          UI.msg(`He recalculado el itinerario de ${targetCity}.`);
        }
        handled = true;
      }

      if(handled){ await checkAndGenerateMissing(); return; }

      // --- Fallback inteligente: edita día visible de la ciudad activa ---
      const targetCity = workingCity || S().activeCity;
      const currentDay = getVisibleDay(targetCity);
      const currentDayContext = getDayRowsAsText(targetCity, currentDay);
      const allDaysContext = getAllDaysContextAsText(targetCity);
      const prompt = `
${FORMAT_FOR_AGENT()}
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
        const ans = await API.callAgent(prompt);
        const parsed = API.parseJSON(ans);
        if(parsed){
          API.applyParsedToState(parsed,false);
          UI.renderCityTabs(); PATCH({activeCity:targetCity}); UI.renderCityItinerary(targetCity);
          UI.msg(parsed.followup || 'He aplicado los cambios y optimizado el día. ¿Quieres otro ajuste?','ai');
        }else{
          UI.msg(ans || 'Listo. ¿Otra cosa?','ai');
        }
        await checkAndGenerateMissing();
      }catch(e){
        console.error(e);
        UI.msg('❌ Error de conexión.','ai');
      }
    } // fin sendChat

    // ---- formato a usar con el modelo (idéntico a tu core) ----
    function FORMAT_FOR_AGENT(){
      // reutiliza la constante que ya envías desde Webflow; si no existe, define inline
      if(typeof window.__FORMAT_CACHE === 'string') return window.__FORMAT_CACHE;
      const F = `
Devuelve SOLO JSON (sin texto extra) con alguno de estos formatos:
A) {"destinations":[{"name":"City","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"..","from":"..","to":"..","transport":"..","duration":"..","notes":".."}]}], "followup":"Pregunta breve"}
B) {"destination":"City","rows":[{...}],"followup":"Pregunta breve"}
C) {"rows":[{...}],"followup":"Pregunta breve"}
D) {"meta":{"city":"City","baseDate":"DD/MM/YYYY","start":"HH:MM" o ["HH:MM",...],"end":"HH:MM" o ["HH:MM",...],"hotel":"Texto"},"followup":"Pregunta breve"}
Reglas:
- Incluye traslados con transporte y duración (+15% colchón).
- Si faltan datos (p.ej. hora de inicio por día), pregúntalo en "followup" y asume valores razonables.
- Nada de markdown. Solo JSON.`.trim();
      window.__FORMAT_CACHE = F;
      return F;
    }

    // ================== BIND DE EVENTOS (Enter / Send) ==================
    function bindChatEvents(){
      const $send   = pickNode(PL.dom.$send,   ['#send-btn','[data-send]','button#send','button[type="submit"]']);
      const $intake = pickNode(PL.dom.$intake, ['#intake','textarea#intake','[data-intake]','textarea']);

      if(!$send || !$intake){
        // reintento si Webflow aún no ha montado
        setTimeout(bindChatEvents, 150);
        return;
      }

      // Evita doble binding
      if(!$send.__plannerBound){
        $send.addEventListener('click', (e)=>{ e.preventDefault(); sendChat(); });
        $send.__plannerBound = true;
      }
      if(!$intake.__plannerBound){
        $intake.addEventListener('keydown',(e)=>{
          if(e.isComposing) return;                 // IME
          if(e.key==='Enter' && !e.shiftKey){       // Enter simple = enviar
            e.preventDefault();
            sendChat();
          }
        });
        $intake.__plannerBound = true;
      }

      // Observa reemplazos de DOM y re-ata si Webflow re-renderiza
      if(!window.__plannerObserver){
        const obs = new MutationObserver(()=>bindChatEvents());
        obs.observe(document.body, {childList:true, subtree:true});
        window.__plannerObserver = obs;
      }

      console.log('✅ planner-chat.js initialized: handlers attached');
    }

    bindChatEvents();

  }).catch((err)=>{
    console.error('❌ planner-chat.js no pudo inicializarse:', err);
  });

})();
