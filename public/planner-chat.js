// =============================================================
// planner-chat.js v10 — Motor completo del chat libre e inteligente
// =============================================================
// Compatible con puente window.__planner exportado desde Webflow.
// Requiere que window.__planner.state, .api, y .ui estén disponibles.

(async function(){
  console.log("🚀 planner-chat.js v10 inicializando...");

  // ====== Esperar a que el puente esté listo ======
  function waitForPlanner(maxMs=8000){
    return new Promise((resolve, reject)=>{
      const t0 = Date.now();
      (function poll(){
        if(window.__planner && window.__planner.api && window.__planner.dom){
          return resolve(window.__planner);
        }
        if(Date.now()-t0>maxMs) return reject(new Error("❌ __planner no disponible"));
        setTimeout(poll,50);
      })();
    });
  }

  const PL = await waitForPlanner().catch(e=>{
    console.error(e);
    alert("No se pudo conectar con el motor de planificación (__planner).");
  });
  if(!PL) return;

  const { dom, api, ui, helpers } = PL;
  const { $send, $intake, $chatM } = dom;
  const { callAgent, parseJSON, getItineraryContext, getCityMetaContext,
          generateCityItinerary, applyParsedToState, ensureDays, upsertCityMeta } = api;
  const { renderCityTabs, renderCityItinerary, msg, askForNextCityMeta, maybeGenerateAllCities } = ui;

  let { state } = PL;
  const { savedDestinations } = state;
  console.log("✅ planner-chat.js conectado al puente");

  // =============================================================
  //  SECCIÓN 14: Chat principal / edición interactiva inteligente
  // =============================================================

  function normalize(t){
    return (t||"").toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
      .replace(/\s+/g," ").trim();
  }

  function extractInt(str){
    const m = (str||"").match(/\b(\d{1,2})\b/);
    if(m) return Math.max(1, parseInt(m[1],10));
    if(/\bun\b|\buno\b|\buna\b/.test(str||"")) return 1;
    return 1;
  }

  function getDayScopeFromText(text){
    const m = text.match(/\bd[ií]a\s+(\d{1,2})\b/i);
    if(m) return Math.max(1,parseInt(m[1],10));
    if(/\b(ultimo|último)\s+d[ií]a\b/i.test(text)) return "LAST";
    return null;
  }

  function findCityInText(text){
    const t = normalize(text);
    for(const {city} of savedDestinations){
      if(t.includes(normalize(city))) return city;
    }
    return null;
  }

  function resolveDayNumber(city, dayScope){
    if(dayScope==="LAST"){
      const days = Object.keys(state.itineraries[city]?.byDay||{}).map(n=>parseInt(n,10));
      return days.length ? Math.max(...days) : 1;
    }
    return dayScope || null;
  }

  // ====== CHAT CORE ======
  async function sendChat(){
    const text = ($intake?.value||"").trim();
    if(!text) return;
    msg(text,"user");
    $intake.value="";

    let {
      itineraries, cityMeta, activeCity,
      collectingMeta, metaProgressIndex, awaitingMetaReply,
      session
    } = PL.state;

    const FORMAT = `
Devuelve SOLO JSON (sin texto extra) con alguno de estos formatos:
A) {"destinations":[{"name":"City","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"..","from":"..","to":"..","transport":"..","duration":"..","notes":".."}]}], "followup":"Pregunta breve"}
B) {"destination":"City","rows":[{...}],"followup":"Pregunta breve"}
C) {"rows":[{...}],"followup":"Pregunta breve"}
D) {"meta":{"city":"City","baseDate":"DD/MM/YYYY","start":"HH:MM","end":"HH:MM","hotel":"Texto"},"followup":"Pregunta breve"}
`.trim();

    // ========== FASE 1: Recopilación de metadatos ==========
    if(collectingMeta){
      const city = savedDestinations[metaProgressIndex]?.city;
      if(!city){ PL.statePatch({collectingMeta:false}); await maybeGenerateAllCities(); return; }

      const extractPrompt = `
Extrae del texto la meta para la ciudad "${city}" según formato D del esquema:
${FORMAT}
Texto del usuario: ${text}`.trim();

      const answer = await callAgent(extractPrompt);
      const parsed = parseJSON(answer);

      if(parsed?.meta){
        upsertCityMeta(parsed.meta);
        msg(`Perfecto, tengo la información para ${city}.`);
        PL.statePatch({ awaitingMetaReply:false, metaProgressIndex: metaProgressIndex+1 });
        if(metaProgressIndex+1 < savedDestinations.length){
          await askForNextCityMeta();
        }else{
          PL.statePatch({ collectingMeta:false });
          msg("🎉 Ya tengo toda la información. Generando itinerarios...");
          await maybeGenerateAllCities();
        }
      }else{
        msg("No logré entender. ¿Podrías repetir la fecha del primer día, horarios y hotel/zona?");
      }
      return;
    }

    // ========== FASE 2: Chat normal ==========
    const tNorm = normalize(text);
    const workingCity = findCityInText(text) || activeCity;
    if(!workingCity){
      msg("Por favor menciona una ciudad o inicia planificación con Start Planning.", "ai");
      return;
    }

    // --- Ajuste horario ---
    if(/\b(hora|inicio|fin|empieza|termina)\b/.test(tNorm)){
      const times = helpers.parseTimesFromText(text);
      if(times.length){
        cityMeta[workingCity] = cityMeta[workingCity] || {};
        if(times.length===1){
          if(/\b(hasta|termina|fin)\b/.test(tNorm)) cityMeta[workingCity].end = times[0];
          else cityMeta[workingCity].start = times[0];
        }else{
          cityMeta[workingCity].start = times[0];
          cityMeta[workingCity].end = times[times.length-1];
        }
        await generateCityItinerary(workingCity);
        renderCityTabs(); renderCityItinerary(workingCity);
        msg(`He ajustado las horas en ${workingCity}.`);
        return;
      }
    }

    // --- Replanificar / optimizar ---
    if(/\b(recalcula|replanifica|regen|optimiza|actualiza)\b/.test(tNorm)){
      await generateCityItinerary(workingCity);
      renderCityTabs(); renderCityItinerary(workingCity);
      msg(`He recalculado el itinerario de ${workingCity}.`);
      return;
    }

    // --- Solicitud general libre ---
    session.push({role:"user", content:text});
    const prompt = `
${FORMAT}
Modifica o amplía el itinerario de "${workingCity}" según la instrucción del usuario.
Plan actual: ${getItineraryContext()}
Meta actual: ${getCityMetaContext()}
Instrucción: ${text}`.trim();

    try{
      const ans = await callAgent(prompt);
      const parsed = parseJSON(ans);
      if(parsed){
        applyParsedToState(parsed,false);
        renderCityTabs(); renderCityItinerary(workingCity);
        msg(parsed.followup || "¿Deseas algún ajuste?", "ai");
      }else{
        msg(ans || "Listo. ¿Otro cambio?", "ai");
      }
    }catch(e){
      console.error(e);
      msg("❌ Error al procesar tu solicitud.","ai");
    }
  }

  // ====== Eventos de envío ======
  if($send) $send.addEventListener("click", sendChat);
  if($intake){
    $intake.addEventListener("keydown",(e)=>{
      if(e.key==="Enter"){ e.preventDefault(); sendChat(); }
    });
  }

  console.log("✅ planner-chat.js v10 cargado y operativo.");
})();
