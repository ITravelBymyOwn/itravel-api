/* ============================================================
   planner-chat.js  (Standalone versión completa y estable)
   ============================================================ */

(() => {
  console.log("✅ planner-chat.js loaded (standalone mode)");

  // ================= GLOBAL ACCESS ============================
  const {
    dom: { $send, $intake, $tabs, $itineraryWrap, $chatM, $chatC },
    helpers: { normalize, extractInt, parseTimesFromText, updateSavedDays },
    api: {
      callAgent,
      parseJSON,
      getItineraryContext,
      getCityMetaContext,
      generateCityItinerary,
      applyParsedToState,
      ensureDays,
      upsertCityMeta,
    },
    ui: { renderCityTabs, renderCityItinerary, msg, askForNextCityMeta, maybeGenerateAllCities },
  } = window.__planner || {};

  let {
    savedDestinations,
    itineraries,
    cityMeta,
    activeCity,
    collectingMeta,
    metaProgressIndex,
    awaitingMetaReply,
    planningStarted,
    batchGenerating,
    globalReviewAsked,
    session,
  } = window.__planner?.state || {};

  if (!$send || !$intake) {
    console.error("planner-chat.js: Missing DOM elements for chat.");
    return;
  }

  /* ============================================================
     HELPERS
  ============================================================ */

  function userWantsReplace(text) {
    const t = (text || "").toLowerCase();
    return /(sustituye|reemplaza|cambia todo|replace|overwrite|desde cero|todo nuevo)/i.test(t);
  }

  function isAcceptance(text) {
    const t = (text || "").toLowerCase().trim();
    return /(^|\b)(ok|listo|esta bien|perfecto|de acuerdo|vale|sounds good|looks good|c’est bon|tout bon|beleza|ta bom)\b/.test(
      t
    );
  }

  function getDayScopeFromText(text) {
    const m = text.match(/\bd[ií]a\s+(\d{1,2})\b/i);
    if (m) return Math.max(1, parseInt(m[1], 10));
    if (/\b(ultimo|último)\s+d[ií]a\b/i.test(text)) return "LAST";
    return null;
  }

  function resolveDayNumber(city, dayScope) {
    if (dayScope === "LAST") {
      const days = Object.keys(itineraries[city]?.byDay || {}).map((n) => parseInt(n, 10));
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
      .replace(/\ben el d[ií]a\s+\d+\b/gi, "")
      .replace(/\bdel d[ií]a\s+\d+\b/gi, "");
    const p = /\b(?:no\s+(?:quiero|deseo)\s+|quita(?:r)?\s+|elimina(?:r)?\s+|remueve(?:r)?\s+|cancelar\s+)(.+)$/i.exec(
      clean
    );
    return p && p[1] ? p[1].trim() : null;
  }

  function hasAskForAlternative(text) {
    const t = text.toLowerCase();
    return /(otra|alternativa|sustituye|reemplaza|cambia por|pon otra|dame opciones|algo diferente|dame otro|sugiere)/i.test(
      t
    );
  }

  function normalizeActivityString(s) {
    return (s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function removeActivityRows(city, dayOrNull, keyword) {
    if (!itineraries[city] || !keyword) return 0;
    const kw = normalizeActivityString(keyword);
    const targetDays = dayOrNull
      ? [dayOrNull]
      : Object.keys(itineraries[city].byDay || {}).map((n) => parseInt(n, 10));
    let removed = 0;
    targetDays.forEach((d) => {
      const rows = itineraries[city].byDay?.[d] || [];
      const before = rows.length;
      itineraries[city].byDay[d] = rows.filter(
        (r) => !normalizeActivityString(r.activity || "").includes(kw)
      );
      removed += Math.max(0, before - (itineraries[city].byDay[d] || []).length);
    });
    ensureDays(city);
    return removed;
  }

  function findCityInText(text) {
    const t = normalize(text);
    for (const { city } of savedDestinations) {
      if (t.includes(normalize(city))) return city;
    }
    return null;
  }

  async function checkAndGenerateMissing() {
    for (const { city } of savedDestinations) {
      const m = cityMeta[city];
      const hasRows = Object.values(itineraries[city]?.byDay || {}).some((a) => a.length > 0);
      if (typeof metaIsComplete === "function" && metaIsComplete(m) && !hasRows) {
        await generateCityItinerary(city);
      }
    }
  }

  /* ============================================================
     CHAT PRINCIPAL
  ============================================================ */
  async function sendChat() {
    const text = ($intake.value || "").trim();
    if (!text) return;
    msg(text, "user");
    $intake.value = "";

    if (collectingMeta) {
      const city = savedDestinations[metaProgressIndex]?.city;
      if (!city) {
        collectingMeta = false;
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
        awaitingMetaReply = false;
        msg(`Perfecto, tengo la información para ${city}.`);
        metaProgressIndex++;
        if (metaProgressIndex < savedDestinations.length) {
          await askForNextCityMeta();
        } else {
          collectingMeta = false;
          msg("Perfecto 🎉 Ya tengo toda la información. Generando itinerarios...");
          await maybeGenerateAllCities();
        }
      } else {
        msg("No logré entender. ¿Podrías repetir la fecha del primer día, horarios y hotel/zona?");
      }
      return;
    }

    // --- Fase 2: conversación normal ---
    const tNorm = normalize(text);
    let handled = false;
    const cityFromText = findCityInText(text);
    const workingCity = cityFromText || activeCity;
    if (cityFromText && cityFromText !== activeCity) {
      setActiveCity(cityFromText);
      renderCityItinerary(cityFromText);
    }

    // --- Agregar días ---
    if (/\b(agrega|añade|sumar?|add)\b.*\bd[ií]a/.test(tNorm)) {
      const addN = extractIntStrict(tNorm) ?? 1;
      if (workingCity) {
        const current =
          savedDestinations.find((x) => x.city === workingCity)?.days ||
          Object.keys(itineraries[workingCity]?.byDay || {}).length ||
          1;
        const newDays = current + addN;
        updateSavedDays(workingCity, newDays);
        ensureDays(workingCity);
        await generateCityItinerary(workingCity);
        renderCityTabs();
        setActiveCity(workingCity);
        renderCityItinerary(workingCity);
        msg(`He añadido ${addN} día${addN > 1 ? "s" : ""} en ${workingCity}.`);
      }
      handled = true;
    }

    // --- Quitar días ---
    if (!handled && /\b(quita|elimina|remueve|remove)\b.*\bd[ií]a/.test(tNorm)) {
      const targetCity = workingCity;
      if (targetCity) {
        const remN = extractIntStrict(tNorm) ?? 1;
        const current =
          savedDestinations.find((x) => x.city === targetCity)?.days ||
          Object.keys(itineraries[targetCity]?.byDay || {}).length ||
          1;
        const newDays = Math.max(1, current - remN);
        updateSavedDays(targetCity, newDays);
        const keys = Object.keys(itineraries[targetCity]?.byDay || {})
          .map((d) => parseInt(d, 10))
          .sort((a, b) => b - a);
        keys.slice(0, remN).forEach((k) => delete itineraries[targetCity].byDay[k]);
        ensureDays(targetCity);
        renderCityTabs();
        setActiveCity(targetCity);
        renderCityItinerary(targetCity);
        msg(`He quitado ${remN} día${remN > 1 ? "s" : ""} en ${targetCity}.`);
      }
      handled = true;
    }

    if (handled) {
      await checkAndGenerateMissing();
      return;
    }

    // --- Fallback general ---
    session.push({ role: "user", content: text });
    const cityHint = workingCity ? `Active city: ${workingCity}` : "";
    const prompt = `
${FORMAT}
Edit the current plan. ${cityHint}
Scope: Modifica SOLO la ciudad activa o la mencionada; no toques otras.
Existing plan: ${getItineraryContext()}
Existing meta: ${getCityMetaContext()}
Solicitud: ${text}`.trim();

    try {
      const ans = await callAgent(prompt);
      const parsed = parseJSON(ans);
      if (parsed) {
        applyParsedToState(parsed, false);
        renderCityTabs();
        setActiveCity(workingCity || activeCity);
        renderCityItinerary(workingCity || activeCity);
        msg(parsed.followup || "¿Deseas otro ajuste?", "ai");
      } else {
        msg(ans || "Listo. ¿Otra cosa?", "ai");
      }
      await checkAndGenerateMissing();
    } catch (e) {
      console.error(e);
      msg("❌ Error de conexión.", "ai");
    }
  }

  /* ============================================================
     EVENTOS
  ============================================================ */
  $send.addEventListener("click", sendChat);
  $intake.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendChat();
    }
  });

  console.log("✅ planner-chat.js initialized correctly");
})();
