/* ============================================================================
 * ITRAVELBYMYOWN — PLANNER CHAT ENGINE (CLIENT)
 * Archivo: planner-chat.js (para servir como script estático en Vercel)
 * Objetivo: Conectar el chat inteligente con la lógica del Planner
 * Dependencias: Requiere que Webflow inyecte window.__planner (puente global)
 * ==========================================================================*/

(function () {
  "use strict";

  // ========= Guard Clauses / Boot =========
  if (typeof window === "undefined") return;
  const warn = (...a) => console.warn("[planner-chat.js]", ...a);
  const log = (...a) => console.log("[planner-chat.js]", ...a);
  const err = (...a) => console.error("[planner-chat.js]", ...a);

  // Espera por window.__planner si aún no está listo
  let readyTries = 0;
  function ensureBridgeOrDie() {
    if (window.__planner && window.__planner.dom && window.__planner.api && window.__planner.ui) {
      return true;
    }
    if (readyTries++ > 80) { // ~4s si se llama cada 50ms
      err("No se encontró window.__planner. Asegura cargar el bloque de puente antes de este script.");
      return false;
    }
    return false;
  }

  // ============ Poly/Utils locales ============
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ====== Bootstrap asincrónico para esperar el puente ======
  (async function boot() {
    while (!ensureBridgeOrDie()) await sleep(50);

    const P = window.__planner;

    // ====== Referencias a estado/UI/API compartidas (del puente) ======
    // Estado (lectura vía getter)
    const getState = () => P.state || {};
    // Patch de flags
    const patchState = (patch) => { P.statePatch = patch || {}; };

    // DOM
    const { $send, $intake, $tabs, $itineraryWrap, $chatM, $chatC } = P.dom || {};
    if (!$send || !$intake) {
      err("Faltan nodos $send o $intake en window.__planner.dom");
    }

    // Helpers y API (del puente)
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

    // ====== Alias de estado con respaldo (lectura)
    function read(varName, fallback) {
      const S = getState();
      return (S && S[varName] !== undefined) ? S[varName] : fallback;
    }

    // ====== Atajos de acceso al estado (solo lectura) ======
    const state = {
      get savedDestinations() { return read("savedDestinations", []); },
      get itineraries() { return read("itineraries", {}); },
      get cityMeta() { return read("cityMeta", {}); },
      get activeCity() { return read("activeCity", null); },
      get collectingMeta() { return read("collectingMeta", false); },
      get metaProgressIndex() { return read("metaProgressIndex", 0); },
      get awaitingMetaReply() { return read("awaitingMetaReply", false); },
      get planningStarted() { return read("planningStarted", false); },
      get batchGenerating() { return read("batchGenerating", false); },
      get globalReviewAsked() { return read("globalReviewAsked", false); },
      get session() { return read("session", []); }
    };

    // ====== Setter de flags (escritura puntual) ======
    function setFlag(key, value) { patchState({ [key]: value }); }
    function setActiveCity(city) { patchState({ activeCity: city }); }

    // ====== Capa de LLM/Agente ======
    // 1) Preferimos el callAgent ya provisto por el puente (backend seguro).
    // 2) Si no existe, probamos endpoints comunes en Vercel.
    const FALLBACK_ENDPOINTS = [
      "/api/planner-chat",
      "/api/chat"
    ];

    async function callAgent(payloadStringOrPrompt) {
      // Si el puente provee callAgent (recomendado), úsalo.
      if (typeof callAgentFromBridge === "function") {
        if (typeof payloadStringOrPrompt === "string") {
          return await callAgentFromBridge(payloadStringOrPrompt);
        } else {
          return await callAgentFromBridge(payloadStringOrPrompt);
        }
      }

      // Fallback: construye payload mínimo desde el estado local
      const message =
        typeof payloadStringOrPrompt === "string"
          ? payloadStringOrPrompt
          : (payloadStringOrPrompt?.message || "");

      const context = {
        activeCityId: state.activeCity || (state.savedDestinations[0]?.city || null),
        activeDayIndex: getVisibleDay(state.activeCity || (state.savedDestinations[0]?.city || "")) - 1,
        itinerary: state.itineraries,
        preferences: { comfortOverAdventure: true, languages: ["es", "en"], units: "metric" }
      };

      const body = JSON.stringify({
        message,
        context,
        history: state.session || []
      });

      // Intenta con los endpoints conocidos
      let lastError;
      for (const ep of FALLBACK_ENDPOINTS) {
        try {
          const r = await fetch(ep, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body
          });
          if (r.ok) {
            const txt = await r.text();
            return txt; // devolver texto; el parse se hace con parseJSON()
          } else {
            lastError = new Error("HTTP " + r.status);
          }
        } catch (e) {
          lastError = e;
        }
      }
      throw lastError || new Error("No se pudo contactar al agente (fallback).");
    }

    function parseJSON(text) {
      if (typeof parseJSONFromBridge === "function") {
        try { return parseJSONFromBridge(text); } catch { /* no-op */ }
      }
      try { return JSON.parse(text); } catch { return null; }
    }

    // ====== FORMATO/PLANTILLAS (coincidente con tu implementación) ======
    const FORMAT = `
FORMATO JSON — B (parcial por día / ciudad):
{
  "destination": "<CIUDAD>",
  "day": <NÚMERO_DÍA>,   // si aplica, cambios locales de un día
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
  "followup": "Texto opcional para el usuario"
}

FORMATO JSON — D (META POR CIUDAD):
{
  "meta": {
    "city": "<CIUDAD>",
    "baseDate": "DD/MM/YYYY",
    "start": "HH:MM" | ["HH:MM", "HH:MM", ...],
    "end": "HH:MM"   | ["HH:MM", "HH:MM", ...],
    "hotel": "Texto libre"
  }
}
`.trim();

    // =====================================================================
    // =================== BLOQUE DE NLU / HELPERS COMPLETOS ================
    // (NO RESUMIR: Incluye exactamente las utilidades y parseos necesarios)
    // =====================================================================

    function userWantsReplace(text) {
      const t = (text || "").toLowerCase();
      return /(sustituye|reemplaza|cambia todo|replace|overwrite|desde cero|todo nuevo)/i.test(t);
    }
    function isAcceptance(text) {
      const t = (text || "").toLowerCase().trim();
      return /(^|\b)(ok|listo|esta bien|perfecto|de acuerdo|vale|sounds good|looks good|c’est bon|tout bon|beleza|ta bom)\b/.test(t);
    }

    function getDayScopeFromText(text) {
      const m = text.match(/\bd[ií]a\s+(\d{1,2})\b/i);
      if (m) return Math.max(1, parseInt(m[1], 10));
      if (/\b(ultimo|último)\s+d[ií]a\b/i.test(text)) return "LAST";
      return null;
    }
    function resolveDayNumber(city, dayScope) {
      if (dayScope === "LAST") {
        const days = Object.keys(state.itineraries[city]?.byDay || {}).map(n => parseInt(n, 10));
        return days.length ? Math.max(...days) : 1;
      }
      return dayScope || null;
    }
    function extractIntStrict(str) {
      const m = str.match(/\b(\d{1,2})\b/);
      if (m) return Math.max(1, parseInt(m[1], 10));
      return null;
    }
    function extractRemovalKeyword(text) {
      const clean = text
        .replace(/\ben el d[ií]a\s+\d+\b/ig, '')
        .replace(/\bdel d[ií]a\s+\d+\b/ig, '');
      const p = /\b(?:no\s+(?:quiero|deseo)\s+|quita(?:r)?\s+|elimina(?:r)?\s+|remueve(?:r)?\s+|cancelar\s+)(.+)$/i.exec(clean);
      return p && p[1] ? p[1].trim() : null;
    }
    function hasAskForAlternative(text) {
      const t = text.toLowerCase();
      return /(otra|alternativa|sustituye|reemplaza|cambia por|pon otra|dame opciones|algo diferente|dame otro|sugiere)/i.test(t);
    }
    function normalizeActivityString(s) {
      return (s || "").toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function removeActivityRows(city, dayOrNull, keyword) {
      const itineraries = state.itineraries;
      if (!itineraries[city] || !keyword) return 0;
      const kw = normalizeActivityString(keyword);
      const targetDays = dayOrNull
        ? [dayOrNull]
        : Object.keys(itineraries[city].byDay || {}).map(n => parseInt(n, 10));
      let removed = 0;
      targetDays.forEach(d => {
        const rows = itineraries[city].byDay?.[d] || [];
        const before = rows.length;
        itineraries[city].byDay[d] = rows.filter(r => !normalizeActivityString(r.activity || '').includes(kw));
        removed += Math.max(0, before - (itineraries[city].byDay[d] || []).length);
      });
      ensureDays(city);
      return removed;
    }

    function findCityInText(text) {
      const t = normalize(text);
      for (const { city } of state.savedDestinations) {
        if (t.includes(normalize(city))) return city;
      }
      return null;
    }

    function getVisibleDay(city) {
      // Si hay pager activo, úsalo; si no, día 1 o currentDay
      const btn = document.querySelector('.pager .active');
      if (btn && /^\d+$/.test(btn.textContent.trim())) return parseInt(btn.textContent.trim(), 10);
      const it = state.itineraries[city];
      return (it && it.currentDay) ? it.currentDay : 1;
    }

    function getDayRowsAsText(city, day) {
      const rows = state.itineraries[city]?.byDay?.[day] || [];
      if (!rows.length) return "No hay actividades registradas.";
      return rows.map(r => `De ${r.start} a ${r.end}: ${r.activity} (${r.from} → ${r.to}, ${r.transport}, ${r.duration}). Notas: ${r.notes}`).join("\n");
    }

    function getAllDaysContextAsText(city) {
      const byDay = state.itineraries[city]?.byDay || {};
      const days = Object.keys(byDay).map(n => parseInt(n, 10)).sort((a, b) => a - b);
      if (!days.length) return "Sin días aún.";
      return days.map(d => {
        const rows = byDay[d] || [];
        if (!rows.length) return `Día ${d}: (vacío)`;
        const items = rows.map(r => `• ${r.start}-${r.end} ${r.activity}`).join('\n');
        return `Día ${d}:\n${items}`;
      }).join('\n\n');
    }

    function reorderCityDays(city, newOrder) {
      const itineraries = state.itineraries;
      const old = itineraries[city]?.byDay || {};
      const days = Object.keys(old).map(n => parseInt(n, 10)).sort((a, b) => a - b);
      if (newOrder.length !== days.length) return false;
      const unique = new Set(newOrder);
      if (unique.size !== newOrder.length) return false;
      if (!newOrder.every(n => days.includes(n))) return false;

      const newByDay = {};
      newOrder.forEach((srcDay, i) => {
        const dstDay = i + 1;
        newByDay[dstDay] = (old[srcDay] || []).map(r => ({ ...r, day: dstDay }));
      });
      itineraries[city].byDay = newByDay;
      itineraries[city].currentDay = 1;
      ensureDays(city);
      return true;
    }

    function swapDays(city, a, b) {
      const byDay = state.itineraries[city]?.byDay || {};
      const A = byDay[a] || [];
      const B = byDay[b] || [];
      byDay[a] = (B || []).map(r => ({ ...r, day: a }));
      byDay[b] = (A || []).map(r => ({ ...r, day: b }));
      state.itineraries[city].byDay = byDay;
      ensureDays(city);
    }

    function parseReorderInstruction(text) {
      const m1 = /reordena(?:r)?\s+los\s+d[ií]as\s+(?:como|a)\s+([\d,\s]+)/i.exec(text);
      if (m1) {
        const arr = m1[1].split(/[, ]+/).filter(Boolean).map(n => parseInt(n, 10)).filter(n => !isNaN(n));
        if (arr.length) return { type: 'sequence', seq: arr };
      }
      const m2 = /(intercambia|swap|cambia)\s+(?:el\s+)?d[ií]a\s+(\d{1,2})\s+(?:y|con)\s+(?:el\s+)?d[ií]a\s+(\d{1,2})/i.exec(text);
      if (m2) return { type: 'swap', a: parseInt(m2[2], 10), b: parseInt(m2[3], 10) };
      const m3 = /haz\s+(?:el\s+)?d[ií]a\s+(\d{1,2})\s+(?:primero|1º|1ro)/i.exec(text);
      if (m3) return { type: 'makeFirst', day: parseInt(m3[1], 10) };
      return null;
    }

    function parseMoveActivityInstruction(text) {
      const m = /(mueve|pasa|lleva)\s+(?:la\s+|el\s+|los\s+|las\s+|\"?'?)(.+?)(?:\"?'?)\s+(?:al|para el)\s+d[ií]a\s+(\d{1,2})/i.exec(text);
      if (m) return { activity: m[2].trim(), toDay: parseInt(m[3], 10) };
      const m2 = /(mueve|pasa|lleva)\s+(?:del|desde el)\s+d[ií]a\s+(\d{1,2})\s+(?:al|para el)\s+d[ií]a\s+(\d{1,2})/i.exec(text);
      if (m2) return { fromDay: parseInt(m2[2], 10), toDay: parseInt(m2[3], 10) };
      return null;
    }

    function extractAddCity(text) {
      const m = /(agrega|añade|add)\s+([a-záéíóúñ\s]+?)\s+(\d{1,2})\s+d[ií]as?/i.exec(text);
      if (m) return { city: m[2].trim().replace(/\s+/g, ' ').replace(/^\w/, c => c.toUpperCase()), days: parseInt(m[3], 10) };
      const m2 = /(agrega|añade|add)\s+([a-záéíóúñ\s]+)$/i.exec(text);
      if (m2) return { city: m2[2].trim().replace(/\s+/g, ' ').replace(/^\w/, c => c.toUpperCase()), days: 1 };
      return null;
    }

    function extractRemoveCity(text) {
      const m = /(elimina|quita|remueve)\s+(?:la\s+ciudad\s+)?([a-záéíóúñ\s]+)$/i.exec(text);
      if (m) return { city: m[2].trim().replace(/\s+/g, ' ').replace(/^\w/, c => c.toUpperCase()) };
      return null;
    }

    function addCityFromChat(name, days = 1) {
      const itineraries = state.itineraries;
      const savedDestinations = state.savedDestinations;
      const order = savedDestinations.length ? Math.max(...savedDestinations.map(x => x.order)) + 1 : 1;
      savedDestinations.push({ city: name, days: Math.max(1, days), order });
      if (!itineraries[name]) itineraries[name] = { byDay: {}, currentDay: 1, baseDate: null };
      if (!state.cityMeta[name]) state.cityMeta[name] = { baseDate: null, start: null, end: null, hotel: '' };
      ensureDays(name);
      renderCityTabs();
      setActiveCity(name);
      renderCityItinerary(name);
    }

    function removeCityFromChat(name) {
      const itineraries = state.itineraries;
      const savedDestinations = state.savedDestinations;
      const idx = savedDestinations.findIndex(x => x.city === name);
      if (idx >= 0) savedDestinations.splice(idx, 1);
      delete itineraries[name];
      delete state.cityMeta[name];
      savedDestinations.forEach((x, i) => x.order = i + 1);
      renderCityTabs();
      setActiveCity(savedDestinations[0]?.city || null);
      if (state.activeCity) renderCityItinerary(state.activeCity);
    }

    function moveActivityBetweenDays(city, fromDayGuess, activityKw, toDay) {
      const fromDay = fromDayGuess || null;
      const removed = removeActivityRows(city, fromDay, activityKw);
      return removed;
    }

    async function checkAndGenerateMissing() {
      for (const { city } of state.savedDestinations) {
        const m = state.cityMeta[city];
        const hasRows = Object.values(state.itineraries[city]?.byDay || {}).some(a => a.length > 0);
        if (typeof window.metaIsComplete === 'function' && window.metaIsComplete(m) && !hasRows) {
          await generateCityItinerary(city);
        }
      }
    }

    // =====================================================================
    // ========================= CHAT PRINCIPAL =============================
    // =====================================================================

    async function sendChat() {
      const text = ($intake.value || "").trim();
      if (!text) return;
      msg(text, 'user');
      $intake.value = '';

      // ======= Fase 1: Recopilación de META por ciudad =======
      if (state.collectingMeta) {
        const city = state.savedDestinations[state.metaProgressIndex]?.city;
        if (!city) {
          patchState({ collectingMeta: false });
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
        if (parsed?.meta) {
          upsertCityMeta(parsed.meta);
          patchState({ awaitingMetaReply: false });
          msg(`Perfecto, tengo la información para ${city}.`);
          patchState({ metaProgressIndex: state.metaProgressIndex + 1 });
          if (state.metaProgressIndex + 1 < state.savedDestinations.length) {
            await askForNextCityMeta();
          } else {
            patchState({ collectingMeta: false });
            msg('Perfecto 🎉 Ya tengo toda la información. Generando itinerarios...');
            await maybeGenerateAllCities();
          }
        } else {
          msg('No logré entender. ¿Podrías repetir la fecha del primer día, horarios y hotel/zona?');
        }
        return;
      }

      // ======= Fase 2: Conversación normal (edición libre e inteligente) =======
      const tNorm = normalize(text);
      let handled = false;

      // Resolver ciudad de trabajo
      const cityFromText = findCityInText(text);
      const workingCity = cityFromText || state.activeCity;
      if (cityFromText && cityFromText !== state.activeCity) {
        setActiveCity(cityFromText);
        renderCityItinerary(cityFromText);
      }

      // --- A) Alta/Baja de ciudades ---
      if (!handled) {
        const addCityReq = extractAddCity(text);
        if (addCityReq) {
          addCityFromChat(addCityReq.city, addCityReq.days);
          msg(`He agregado **${addCityReq.city}** con ${addCityReq.days} día(s). Comparte la fecha del primer día (DD/MM/AAAA), horas de inicio/fin y hotel/zona para generar el itinerario.`);
          patchState({ collectingMeta: true, metaProgressIndex: state.savedDestinations.findIndex(x => x.city === addCityReq.city), awaitingMetaReply: false });
          await askForNextCityMeta();
          handled = true;
        }
      }
      if (!handled) {
        const removeCityReq = extractRemoveCity(text);
        if (removeCityReq) {
          removeCityFromChat(removeCityReq.city);
          msg(`He eliminado la ciudad **${removeCityReq.city}**.`);
          handled = true;
        }
      }
      if (handled) { await checkAndGenerateMissing(); return; }

      // --- B) Agregar días ---
      if (/\b(agrega|añade|sumar?|add)\b.*\bd[ií]a/.test(tNorm) || /\b(un dia mas|1 dia mas)\b/.test(tNorm)) {
        const addN = extractIntStrict(tNorm) ?? 1;
        const hasActivity = /\b(tour|excursion|visita|museo|paseo|segovia|toledo|montserrat|catedral|parque|mercado|playa|ruta)\b/i.test(text);
        const activityDesc = hasActivity ? text : null;

        if (workingCity) {
          const current = state.savedDestinations.find(x => x.city === workingCity)?.days
            || Object.keys(state.itineraries[workingCity]?.byDay || {}).length || 1;
          const newDays = current + addN;
          updateSavedDays(workingCity, newDays);
          ensureDays(workingCity);

          if (hasActivity) {
            const prompt = `
${FORMAT}
Edita el itinerario de "${workingCity}" agregando ${addN} día${addN > 1 ? 's' : ''}.
Incluye como actividad principal: "${activityDesc}" y completa con otras actividades no repetidas ni duplicadas de otros días.
Ajusta horarios y transportes coherentemente.
Devuelve SOLO JSON con "destination":"${workingCity}".`.trim();
            const answer = await callAgent(prompt);
            const parsed = parseJSON(answer);
            if (parsed) { applyParsedToState(parsed, false); }
          } else {
            await generateCityItinerary(workingCity);
          }

          renderCityTabs();
          setActiveCity(workingCity);
          renderCityItinerary(workingCity);
          msg(`He añadido ${addN} día${addN > 1 ? 's' : ''} en ${workingCity}.`);
        }
        handled = true;
      }

      // --- C) Quitar días ---
      if (!handled && (/\b(quita|elimina|remueve|remove)\b.*\bd[ií]a/.test(tNorm) || /\b(ultimo|último)\s+d[ií]a\b/i.test(tNorm))) {
        const targetCity = workingCity;
        if (targetCity) {
          const dayScopeRaw = getDayScopeFromText(text);
          const dayN = resolveDayNumber(targetCity, dayScopeRaw);
          if (dayScopeRaw && dayScopeRaw !== 'LAST') {
            const byDay = state.itineraries[targetCity]?.byDay || {};
            delete byDay[dayN];
            const remain = Object.keys(byDay).map(n => parseInt(n, 10)).sort((a, b) => a - b);
            const newByDay = {};
            remain.forEach((src, i) => { newByDay[i + 1] = (byDay[src] || []).map(r => ({ ...r, day: i + 1 })); });
            state.itineraries[targetCity].byDay = newByDay;
            const curIdx = state.savedDestinations.findIndex(x => x.city === targetCity);
            if (curIdx >= 0) state.savedDestinations[curIdx].days = Math.max(1, remain.length);
            ensureDays(targetCity);
            renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
            msg(`He eliminado el día ${dayN} en ${targetCity}.`);
          } else {
            const remN = extractIntStrict(tNorm) ?? 1;
            const current = state.savedDestinations.find(x => x.city === targetCity)?.days
              || Object.keys(state.itineraries[targetCity]?.byDay || {}).length || 1;
            const newDays = Math.max(1, current - remN);
            const keys = Object.keys(state.itineraries[targetCity]?.byDay || {}).map(d => parseInt(d, 10)).sort((a, b) => b - a);
            keys.slice(0, remN).forEach(k => delete state.itineraries[targetCity].byDay[k]);
            updateSavedDays(targetCity, newDays);
            ensureDays(targetCity);
            renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
            msg(`He quitado ${remN} día${remN > 1 ? 's' : ''} en ${targetCity}.`);
          }
        }
        handled = true;
      }

      // --- D) Reordenar días / swap ---
      if (!handled) {
        const ro = parseReorderInstruction(text);
        if (ro && workingCity) {
          if (ro.type === 'sequence') {
            const ok = reorderCityDays(workingCity, ro.seq);
            if (ok) {
              renderCityTabs(); setActiveCity(workingCity); renderCityItinerary(workingCity);
              msg(`He reordenado los días en ${workingCity} como ${ro.seq.join(', ')} → 1..${ro.seq.length}.`);
            } else {
              msg('No pude reordenar: la secuencia no coincide con el número de días.', 'ai');
            }
          } else if (ro.type === 'swap') {
            swapDays(workingCity, ro.a, ro.b);
            renderCityTabs(); setActiveCity(workingCity); renderCityItinerary(workingCity);
            msg(`He intercambiado el día ${ro.a} con el día ${ro.b} en ${workingCity}.`);
          } else if (ro.type === 'makeFirst') {
            const byDay = state.itineraries[workingCity]?.byDay || {};
            const days = Object.keys(byDay).map(n => parseInt(n, 10)).sort((a, b) => a - b);
            const seq = [ro.day, ...days.filter(d => d !== ro.day)];
            const ok = reorderCityDays(workingCity, seq);
            if (ok) {
              renderCityTabs(); setActiveCity(workingCity); renderCityItinerary(workingCity);
              msg(`He puesto el día ${ro.day} como primero en ${workingCity}.`);
            }
          }
          handled = true;
        }
      }

      // --- E) Mover actividad entre días ---
      if (!handled) {
        const mv = parseMoveActivityInstruction(text);
        if (mv && workingCity) {
          const currentDay = getVisibleDay(workingCity);
          const toDay = mv.toDay || currentDay;
          let fromDay = mv.fromDay || null;
          let act = mv.activity || null;
          if (!act) {
            const kw = extractRemovalKeyword(text);
            if (kw) act = kw;
          }
          if (!act) act = 'actividad seleccionada';
          const removed = moveActivityBetweenDays(workingCity, fromDay, act, toDay);
          const prompt = `
${FORMAT}
En "${workingCity}" mueve "${act}" al día ${toDay}.
- Reubica horarios en el día ${toDay} y optimiza la secuencia (transportes/duraciones realistas).
- Evita duplicar actividades ya planificadas en otros días de la misma ciudad.
- Si la actividad no existía, interprétala y añádela como equivalente.
Devuelve SOLO JSON formato B con "destination":"${workingCity}" (solo cambios del día ${toDay}).`.trim();
          const ans = await callAgent(prompt);
          const parsed = parseJSON(ans);
          if (parsed) {
            applyParsedToState(parsed, false);
            renderCityTabs(); setActiveCity(workingCity); renderCityItinerary(workingCity);
            msg(`He movido "${act}" al día ${toDay} en ${workingCity} y ajustado los horarios.`, 'ai');
          } else {
            renderCityTabs(); setActiveCity(workingCity); renderCityItinerary(workingCity);
            msg(`He quitado "${act}" del día origen. ¿Deseas qué haga exactamente en el día ${toDay}?`, 'ai');
          }
          handled = true;
        }
      }

      // --- F) Sustitución / eliminación de actividades con alternativa ---
      if (!handled && /(no\s+(?:quiero|deseo)|quita|elimina|remueve|cancelar|sustituye|reemplaza|cambia)/i.test(text)) {
        const targetCity = workingCity;
        if (targetCity) {
          const dayScopeRaw = getDayScopeFromText(text);
          const dayN = resolveDayNumber(targetCity, dayScopeRaw);
          const mSwap = /(sustituye|reemplaza|cambia)\s+(?:el\s+)?(.+?)\s+por\s+(.+?)(?:$|\.|,)/i.exec(text);
          if (mSwap) {
            const oldK = mSwap[2].trim();
            const newK = mSwap[3].trim();
            removeActivityRows(targetCity, dayN, oldK);
            const swapPrompt = `
${FORMAT}
En "${targetCity}" ${dayN ? `(día ${dayN})` : ''} elimina "${oldK}" y reemplázalo por actividades equivalentes basadas en "${newK}".
Ajusta automáticamente horarios, duraciones y transiciones; completa huecos y evita duplicados con otros días.
Devuelve SOLO JSON formato B con "destination":"${targetCity}".`.trim();
            const ans = await callAgent(swapPrompt);
            const parsed = parseJSON(ans);
            if (parsed) {
              applyParsedToState(parsed, false);
              renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
              msg(`He reemplazado "${oldK}" por "${newK}" y optimizado el flujo.`, 'ai');
            } else msg(`He eliminado "${oldK}". ¿Qué deseas hacer en su lugar?`, 'ai');
          } else {
            const keyword = extractRemovalKeyword(text);
            if (keyword) {
              const removed = removeActivityRows(targetCity, dayN, keyword);
              renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
              if (removed > 0) {
                if (hasAskForAlternative(text)) {
                  const altPrompt = `
${FORMAT}
En "${targetCity}" ${dayN ? `(día ${dayN})` : ''} el usuario quitó "${keyword}".
Propón nuevas actividades coherentes y optimiza la secuencia del día (horarios, transportes, duraciones).
Evita repetir otras actividades de la ciudad.
Devuelve SOLO JSON formato B con "destination":"${targetCity}".`.trim();
                  const ans = await callAgent(altPrompt);
                  const parsed = parseJSON(ans);
                  if (parsed) {
                    applyParsedToState(parsed, false);
                    renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
                    msg(`He sustituido "${keyword}" por alternativas optimizadas.`, 'ai');
                  }
                } else msg(`He eliminado "${keyword}".`, 'ai');
              } else msg(`No encontré "${keyword}" en ${targetCity}.`, 'ai');
            }
          }
        }
        handled = true;
      }

      // --- G) Detallar/optimizar día visible ---
      if (!handled && /\b(detalla|mas detalle|expande|optimiza|reorganiza|mejora flujo|hazlo mas preciso|con mas tiempo|con mas paradas)\b/i.test(text)) {
        const targetCity = workingCity;
        if (targetCity) {
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
          if (parsed) {
            applyParsedToState(parsed, false);
            renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
            msg(`He optimizado y detallado el día ${currentDay} en ${targetCity}.`, 'ai');
          } else msg('No pude optimizar el flujo.', 'ai');
        }
        handled = true;
      }

      // --- H) Ajuste de horas naturales (meta) ---
      if (!handled && /\b(hora|horario|inicio|fin|empieza|termina|ajusta|cambia)\b/.test(tNorm)) {
        const times = parseTimesFromText(text);
        const targetCity = workingCity;
        if (targetCity && times.length) {
          state.cityMeta[targetCity] = state.cityMeta[targetCity] || { baseDate: null, start: null, end: null, hotel: '' };
          if (times.length === 1) {
            if (/\b(hasta|termina|fin)\b/.test(tNorm)) state.cityMeta[targetCity].end = times[0];
            else state.cityMeta[targetCity].start = times[0];
          } else {
            state.cityMeta[targetCity].start = times[0];
            state.cityMeta[targetCity].end = times[times.length - 1];
          }
          await generateCityItinerary(targetCity);
          renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
          msg(`He ajustado las horas en ${targetCity}.`);
        }
        handled = true;
      }

      // --- I) Replantear todo el itinerario de la ciudad (desde cero) ---
      if (!handled && /(replantea|vuelve a plantear|nuevo plan|desde cero|reset(?:ea)?|comienza de nuevo|hazlo de nuevo)\b/i.test(tNorm)) {
        const targetCity = workingCity;
        if (targetCity) {
          state.itineraries[targetCity].byDay = {};
          await generateCityItinerary(targetCity);
          renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
          msg(`He replanteado por completo el itinerario de ${targetCity}.`);
        }
        handled = true;
      }

      // --- J) Recalcular itinerario (ciudad completa) ---
      if (!handled && /\b(recalcula|replanifica|recompute|replan|recalculate|actualiza)\b/.test(tNorm)) {
        const targetCity = workingCity;
        if (targetCity) {
          await generateCityItinerary(targetCity);
          renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
          msg(`He recalculado el itinerario de ${targetCity}.`);
        }
        handled = true;
      }

      if (handled) { await checkAndGenerateMissing(); return; }

      // --- K) Fallback inteligente (día visible, edición libre) ---
      state.session.push({ role: 'user', content: text });
      const targetCity = workingCity || state.activeCity;
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

      try {
        const ans = await callAgent(prompt);
        const parsed = parseJSON(ans);
        if (parsed) {
          applyParsedToState(parsed, false);
          renderCityTabs(); setActiveCity(targetCity); renderCityItinerary(targetCity);
          msg(parsed.followup || 'He aplicado los cambios y optimizado el día. ¿Quieres otro ajuste?', 'ai');
        } else {
          msg(ans || 'Listo. ¿Otra cosa?', 'ai');
        }
        await checkAndGenerateMissing();
      } catch (e) {
        console.error(e);
        msg('❌ Error de conexión.', 'ai');
      }
    }

    // ===== Bindings de UI (click/enter)
    if ($send) $send.addEventListener('click', sendChat);
    if ($intake) $intake.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
    });

    log("Planner Chat Engine iniciado ✓");
  })();

})();
