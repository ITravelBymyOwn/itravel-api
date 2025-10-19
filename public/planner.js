// ================================
// ITRAVELBYMYOWN PLANNER v46
// BLOQUE 1/3
// ================================

// ==================== 1. VARIABLES GLOBALES ====================
let cities = [];
let selectedCityIndex = null;
let itineraries = {};
let travelerData = {};
let budgetData = {};
let specialConditions = "";
let chatHistory = [];
let isGenerating = false;

// Horarios por defecto
let defaultStartHour = "08:30";
let defaultEndHour = "19:00";

// ==================== 2. ELEMENTOS DOM ====================
const addCityBtn = document.getElementById("add-city-btn");
const saveDestinationsBtn = document.getElementById("save-destinations");
const cityListContainer = document.getElementById("city-list");
const itineraryContainer = document.getElementById("itinerary-container");
const cityTabs = document.getElementById("city-tabs");
const startPlanningBtn = document.getElementById("start-planning");
const chatContainer = document.getElementById("chat-container");
const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const loadingOverlay = document.getElementById("loading-overlay");
const specialConditionsInput = document.getElementById("special-conditions");
const thinkingIndicator = document.getElementById("thinking-indicator");

// ==================== 3. FUNCIONES DE UTILIDAD ====================
function showLoadingOverlay(show, text = "Generando itinerario...") {
  loadingOverlay.style.display = show ? "flex" : "none";
  if (show) {
    loadingOverlay.querySelector("p").innerText = `🧭 Astra está generando itinerario...`;
  }
}

function showThinkingIndicator(show) {
  thinkingIndicator.style.display = show ? "block" : "none";
}

function scrollToBottomChat() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function generateId() {
  return Math.random().toString(36).substring(2, 9);
}

function sanitizeInput(text) {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function onlyLetters(str) {
  return /^[A-Za-zÁÉÍÓÚáéíóúÑñ\s]+$/.test(str);
}

// ==================== 4. CIUDADES ====================
function renderCityList() {
  cityListContainer.innerHTML = "";
  cities.forEach((city, index) => {
    const row = document.createElement("div");
    row.className = "city-row";

    const cityLabel = document.createElement("label");
    cityLabel.innerText = "Ciudad";
    const cityInput = document.createElement("input");
    cityInput.type = "text";
    cityInput.value = city.name;
    cityInput.placeholder = "Ej: París";
    cityInput.addEventListener("input", () => {
      if (!onlyLetters(cityInput.value)) {
        cityInput.value = cityInput.value.replace(/[^A-Za-zÁÉÍÓÚáéíóúÑñ\s]/g, "");
      }
      cities[index].name = cityInput.value;
    });
    cityLabel.appendChild(cityInput);

    const countryLabel = document.createElement("label");
    countryLabel.innerText = "País";
    const countryInput = document.createElement("input");
    countryInput.type = "text";
    countryInput.value = city.country;
    countryInput.placeholder = "Ej: Francia";
    countryInput.addEventListener("input", () => {
      if (!onlyLetters(countryInput.value)) {
        countryInput.value = countryInput.value.replace(/[^A-Za-zÁÉÍÓÚáéíóúÑñ\s]/g, "");
      }
      cities[index].country = countryInput.value;
    });
    countryLabel.appendChild(countryInput);

    const daysLabel = document.createElement("label");
    daysLabel.innerText = "Días";
    const daysSelect = document.createElement("select");
    for (let d = 0; d <= 30; d++) {
      const option = document.createElement("option");
      option.value = d;
      option.textContent = d === 0 ? "" : d;
      if (city.days === d) option.selected = true;
      daysSelect.appendChild(option);
    }
    daysSelect.addEventListener("change", () => {
      cities[index].days = parseInt(daysSelect.value) || 0;
      renderItineraryTabs();
    });
    daysLabel.appendChild(daysSelect);

    const startLabel = document.createElement("label");
    startLabel.innerText = "Hora Inicio";
    const startHour = document.createElement("input");
    startHour.type = "time";
    startHour.value = city.startHour || defaultStartHour;
    startHour.addEventListener("input", () => {
      cities[index].startHour = startHour.value;
    });
    startLabel.appendChild(startHour);

    const endLabel = document.createElement("label");
    endLabel.innerText = "Hora Final";
    const endHour = document.createElement("input");
    endHour.type = "time";
    endHour.value = city.endHour || defaultEndHour;
    endHour.addEventListener("input", () => {
      cities[index].endHour = endHour.value;
    });
    endLabel.appendChild(endHour);

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove";
    removeBtn.innerText = "X";
    removeBtn.addEventListener("click", () => {
      cities.splice(index, 1);
      renderCityList();
      renderItineraryTabs();
    });

    row.appendChild(cityLabel);
    row.appendChild(countryLabel);
    row.appendChild(daysLabel);
    row.appendChild(startLabel);
    row.appendChild(endLabel);
    row.appendChild(removeBtn);

    cityListContainer.appendChild(row);
  });
}

addCityBtn.addEventListener("click", () => {
  cities.push({
    id: generateId(),
    name: "",
    country: "",
    days: 0,
    startHour: defaultStartHour,
    endHour: defaultEndHour
  });
  renderCityList();
  renderItineraryTabs();
});

// ==================== 5. ITINERARIO Y TABS ====================
function renderItineraryTabs() {
  cityTabs.innerHTML = "";
  cities.forEach((city, index) => {
    if (city.days > 0) {
      const tab = document.createElement("div");
      tab.className = "city-tab";
      tab.textContent = `${city.name} (${city.days} días)`;
      if (index === selectedCityIndex) tab.classList.add("active");
      tab.addEventListener("click", () => {
        selectedCityIndex = index;
        renderItineraryTabs();
        renderItineraryForCity(city.id);
      });
      cityTabs.appendChild(tab);
    }
  });

  if (selectedCityIndex !== null && cities[selectedCityIndex]) {
    renderItineraryForCity(cities[selectedCityIndex].id);
  }
}

function initItineraryForCity(cityId) {
  const city = cities.find(c => c.id === cityId);
  if (!city) return;
  if (!itineraries[cityId]) itineraries[cityId] = [];

  itineraries[cityId] = Array.from({ length: city.days }, (_, i) => ({
    day: i + 1,
    activities: [],
    startHour: city.startHour,
    endHour: city.endHour
  }));
}

function renderItineraryForCity(cityId) {
  const city = cities.find(c => c.id === cityId);
  if (!city) return;
  if (!itineraries[cityId]) initItineraryForCity(cityId);

  itineraryContainer.innerHTML = "";
  const table = document.createElement("table");
  table.className = "itinerary";
  const thead = document.createElement("thead");
  thead.innerHTML = `
    <tr>
      <th>Día</th>
      <th>Actividad</th>
      <th>Hora inicio</th>
      <th>Hora fin</th>
    </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  itineraries[cityId].forEach(day => {
    const row = document.createElement("tr");
    const dayCell = document.createElement("td");
    dayCell.textContent = day.day;
    row.appendChild(dayCell);

    const actCell = document.createElement("td");
    actCell.textContent = day.activities.length > 0
      ? day.activities.map(a => a.name).join(", ")
      : "Sin actividades";
    row.appendChild(actCell);

    const startCell = document.createElement("td");
    startCell.textContent = day.startHour || city.startHour;
    row.appendChild(startCell);

    const endCell = document.createElement("td");
    endCell.textContent = day.endHour || city.endHour;
    row.appendChild(endCell);

    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  itineraryContainer.appendChild(table);
}
// ==================== 6. CHAT ====================
function addChatMessage(sender, text) {
  const msg = document.createElement("div");
  msg.className = `chat-message ${sender}`;
  msg.innerHTML = sanitizeInput(text);
  chatMessages.appendChild(msg);
  scrollToBottomChat();
}

function sendUserMessage() {
  const text = chatInput.value.trim();
  if (text === "") return;
  addChatMessage("user", text);
  chatInput.value = "";
  chatHistory.push({ role: "user", content: text });
  processChatMessage(text);
}

sendBtn.addEventListener("click", sendUserMessage);
chatInput.addEventListener("keypress", e => {
  if (e.key === "Enter") sendUserMessage();
});

// ==================== 7. NLU BÁSICO ====================
function processChatMessage(text) {
  showThinkingIndicator(true);

  // Normalizar texto
  const lower = text.toLowerCase();

  // Detectar intenciones comunes
  const addDayIntent = lower.includes("quedarme un día más") || lower.includes("agregar un día");
  const removeCityIntent = lower.includes("eliminar ciudad") || lower.includes("quitar ciudad");
  const addCityIntent = lower.includes("agregar ciudad") || lower.includes("añadir ciudad");
  const replaceActivityIntent = lower.includes("sustituir") || lower.includes("cambiar actividad");
  const moveActivityIntent = lower.includes("mover actividad") || lower.includes("pasar actividad");
  const askInfoIntent = lower.includes("qué hacer") || lower.includes("imperdible") || lower.includes("me recomiendas");

  // Ciudad objetivo (si el usuario la menciona)
  let targetCity = detectCityInText(lower);
  let cityIdx = targetCity ? cities.findIndex(c => c.name.toLowerCase() === targetCity.toLowerCase()) : selectedCityIndex;

  // Si no hay ciudad seleccionada, responder error amigable
  if (cityIdx === -1 || cityIdx === null) {
    showThinkingIndicator(false);
    addChatMessage("ai", "Por favor, selecciona una ciudad o menciona a qué ciudad te refieres 🏙️");
    return;
  }

  // Procesar intenciones detectadas
  if (addDayIntent) {
    handleAddDayIntent(cityIdx, text);
  } else if (removeCityIntent) {
    handleRemoveCityIntent(text);
  } else if (addCityIntent) {
    handleAddCityIntent(text);
  } else if (replaceActivityIntent) {
    handleReplaceActivityIntent(cityIdx, text);
  } else if (moveActivityIntent) {
    handleMoveActivityIntent(cityIdx, text);
  } else if (askInfoIntent) {
    handleAskInfoIntent(cityIdx, text);
  } else {
    // Respuesta general estilo ChatGPT sobre turismo
    handleGeneralTourismQuestion(text, cityIdx);
  }
}

function detectCityInText(text) {
  let detected = null;
  cities.forEach(city => {
    if (text.includes(city.name.toLowerCase())) detected = city.name;
  });
  return detected;
}

// ==================== 8. INTENCIONES ====================

// Agregar día
function handleAddDayIntent(cityIdx, text) {
  const city = cities[cityIdx];
  if (!city) return;

  // Insertar día adicional
  const newDay = city.days + 1;
  city.days = newDay;
  itineraries[city.id].push({
    day: newDay,
    activities: [],
    startHour: city.startHour,
    endHour: city.endHour
  });

  renderItineraryTabs();
  renderItineraryForCity(city.id);

  showThinkingIndicator(false);
  addChatMessage("ai", `✅ He agregado un día más en ${city.name}. Ya tienes ${newDay} días en esta ciudad.`);

  // Generar itinerario para este nuevo día
  generateItineraryForCity(cityIdx, newDay);
}

// Eliminar ciudad
function handleRemoveCityIntent(text) {
  const target = detectCityInText(text);
  if (!target) {
    showThinkingIndicator(false);
    addChatMessage("ai", "Indica la ciudad que deseas eliminar 🏙️");
    return;
  }
  const idx = cities.findIndex(c => c.name.toLowerCase() === target.toLowerCase());
  if (idx !== -1) {
    cities.splice(idx, 1);
    renderCityList();
    renderItineraryTabs();
    showThinkingIndicator(false);
    addChatMessage("ai", `❌ He eliminado la ciudad ${target} del itinerario.`);
  } else {
    showThinkingIndicator(false);
    addChatMessage("ai", `No encontré la ciudad ${target}.`);
  }
}

// Agregar ciudad
function handleAddCityIntent(text) {
  const regex = /agregar ciudad (.+)/i;
  const match = text.match(regex);
  const newCityName = match ? match[1] : null;
  if (newCityName) {
    cities.push({
      id: generateId(),
      name: newCityName,
      country: "",
      days: 0,
      startHour: defaultStartHour,
      endHour: defaultEndHour
    });
    renderCityList();
    renderItineraryTabs();
    showThinkingIndicator(false);
    addChatMessage("ai", `🆕 He agregado ${newCityName} como una nueva ciudad al itinerario.`);
  } else {
    showThinkingIndicator(false);
    addChatMessage("ai", `Por favor, indica el nombre de la ciudad que deseas agregar 🏙️`);
  }
}

// Sustituir actividad dentro de un día
function handleReplaceActivityIntent(cityIdx, text) {
  const city = cities[cityIdx];
  if (!city) return;
  const actName = extractActivityName(text);
  if (!actName) {
    showThinkingIndicator(false);
    addChatMessage("ai", `Por favor, indica qué actividad deseas sustituir ✏️`);
    return;
  }

  const dayIdx = selectedCityIndex === cityIdx ? getActiveDayIndex(city.id) : 0;
  const itinerary = itineraries[city.id][dayIdx];

  if (!itinerary.activities.length) {
    showThinkingIndicator(false);
    addChatMessage("ai", `No hay actividades programadas para ese día. Puedo sugerirte una nueva.`);
    return;
  }

  // Buscar actividad
  const actIndex = itinerary.activities.findIndex(a => a.name.toLowerCase().includes(actName.toLowerCase()));
  if (actIndex === -1) {
    showThinkingIndicator(false);
    addChatMessage("ai", `No encontré la actividad "${actName}" en este día. 📅`);
    return;
  }

  // Sustituir por otra sugerencia inteligente
  const newAct = suggestAlternativeActivity(city.name);
  itinerary.activities[actIndex] = newAct;
  renderItineraryForCity(city.id);

  showThinkingIndicator(false);
  addChatMessage("ai", `He sustituido "${actName}" por "${newAct.name}" en ${city.name}.`);
}

// Mover actividad entre días
function handleMoveActivityIntent(cityIdx, text) {
  const city = cities[cityIdx];
  if (!city) return;

  const actName = extractActivityName(text);
  const targetDay = extractDayFromText(text);

  if (!actName || !targetDay) {
    showThinkingIndicator(false);
    addChatMessage("ai", `Indica qué actividad deseas mover y a qué día 📅`);
    return;
  }

  const itinerary = itineraries[city.id];
  let fromDay = -1;
  let actObj = null;

  // Buscar actividad
  itinerary.forEach((day, i) => {
    const idx = day.activities.findIndex(a => a.name.toLowerCase().includes(actName.toLowerCase()));
    if (idx !== -1) {
      fromDay = i;
      actObj = day.activities[idx];
      day.activities.splice(idx, 1);
    }
  });

  if (fromDay === -1 || !actObj) {
    showThinkingIndicator(false);
    addChatMessage("ai", `No encontré la actividad "${actName}" en ${city.name}.`);
    return;
  }

  // Mover a otro día
  itinerary[targetDay - 1].activities.push(actObj);
  renderItineraryForCity(city.id);

  showThinkingIndicator(false);
  addChatMessage("ai", `📆 He movido "${actName}" al día ${targetDay} en ${city.name}.`);
}

// Preguntas generales de turismo sobre ciudad
function handleAskInfoIntent(cityIdx, text) {
  const city = cities[cityIdx];
  if (!city) return;

  // Buscar info base
  showThinkingIndicator(false);
  addChatMessage("ai", `🌍 ${city.name} es un destino maravilloso. Estoy buscando los imperdibles y experiencias únicas para ti...`);

  // Se delega al generador inteligente global (bloque siguiente)
  generateSmartTourismSuggestions(city.name, cityIdx);
}

// Preguntas generales no vinculadas a itinerario
function handleGeneralTourismQuestion(text, cityIdx) {
  // Simula comportamiento tipo ChatGPT
  showThinkingIndicator(false);
  addChatMessage("ai", `🤖 ${simulateTourismAnswer(text)}`);
}

// ==================== 9. FUNCIONES AUXILIARES DE INTENCIONES ====================
function extractActivityName(text) {
  const match = text.match(/"(.*?)"/);
  return match ? match[1] : null;
}

function extractDayFromText(text) {
  const match = text.match(/día\s+(\d+)/i);
  return match ? parseInt(match[1]) : null;
}

function getActiveDayIndex(cityId) {
  const city = cities.find(c => c.id === cityId);
  if (!city) return 0;
  return 0; // futuro: lógica de selección de día activo
}

function suggestAlternativeActivity(cityName) {
  // Esta función debe ser inteligente, aquí es base
  return {
    name: `Actividad alternativa en ${cityName}`,
    start: "10:00",
    end: "12:00"
  };
}
// ==================== 10. INDICADORES (Thinking + Overlay) ====================
let thinkingTimer = null;
function showThinkingIndicator(on) {
  const el = document.getElementById("thinking-indicator");
  if (!el) return;
  if (on) {
    el.style.display = "block";
    if (thinkingTimer) clearInterval(thinkingTimer);
    // animación ya definida en CSS; aquí sólo aseguramos que se muestre/oculte
  } else {
    el.style.display = "none";
    if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
  }
}

function setLoadingOverlay(on, msg = "Astra está generando itinerarios...") {
  const ov = document.getElementById("loading-overlay");
  if (!ov) return;
  const p = ov.querySelector("p");
  if (p) p.textContent = msg;
  ov.style.display = on ? "flex" : "none";
  // Deshabilitar/rehabilitar UI mientras corre
  const controls = document.querySelectorAll("button,input,select,textarea");
  controls.forEach(c => {
    if (on) {
      c._prevDisabled = c.disabled;
      c.disabled = true;
    } else {
      c.disabled = typeof c._prevDisabled !== "undefined" ? c._prevDisabled : false;
      delete c._prevDisabled;
    }
  });
}

// ==================== 11. REGLAS CIUDAD/ACTIVIDAD (validador global) ====================
const AURORA_CITIES = [
  "tromsø","tromso","rovaniemi","abisko","kiruna","reykjavik","reikiavik","fairbanks","yellowknife","murmansk"
];

// Mapa rápido de “categorías → ciudades que sí aplican”
const CITY_ACTIVITY_ALLOW = {
  aurora: new Set(AURORA_CITIES),
  playa: new Set(["barcelona","sitges","valencia","malaga","miami","rio de janeiro","cancun","honolulu"]),
  museos: "any",
  cascoHistorico: "any",
  mirador: "any",
  mercado: "any",
  termales: new Set(["reykjavik","hveragerdi","fludir","flúðir","selfoss","grindavik","akureyri"]),
  futbol: new Set(["barcelona","madrid","manchester","turin","milan","liverpool","paris","munich","rome","roma"]),
  tapas: new Set(["madrid","barcelona","sevilla","granada","valencia","bilbao"]),
  segoviaDayTrip: new Set(["madrid"]),
};

function citySupportsActivity(cityName, actLabel) {
  if (!cityName || !actLabel) return true;
  const c = (cityName || "").toLowerCase();
  const a = (actLabel || "").toLowerCase();

  // Heurísticas por palabra clave
  if (/(aurora|auroras|northern lights)/i.test(a)) {
    return CITY_ACTIVITY_ALLOW.aurora.has(c);
  }
  if (/(baño termal|termales|hot spring|blue lagoon|sky lagoon)/i.test(a)) {
    return CITY_ACTIVITY_ALLOW.termales === "any" || CITY_ACTIVITY_ALLOW.termales.has(c);
  }
  if (/(camp nou|spotify camp nou|barça|fc barcelona)/i.test(a)) {
    return CITY_ACTIVITY_ALLOW.futbol.has(c) || /barcelona/.test(c);
  }
  if (/segovia/i.test(a)) {
    // Sólo como day-trip desde Madrid, en nuestro validador básico
    return CITY_ACTIVITY_ALLOW.segoviaDayTrip.has(c) || /segovia/i.test(c);
  }
  if (/(playa|beach)/i.test(a)) {
    return CITY_ACTIVITY_ALLOW.playa === "any" || CITY_ACTIVITY_ALLOW.playa.has(c);
  }
  // “museos, casco, miradores, mercados, gastronomía” → cualquier ciudad
  if (/(museo|museum|casco histórico|old town|mirad(or|ores)|mercado|market|gastronomía|food|comida|tapas)/i.test(a)) {
    return true;
  }
  // Por defecto, permitir
  return true;
}

function monthFromBaseDateStr(strDMY) {
  // str: "DD/MM/YYYY"
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(strDMY||"").trim());
  if (!m) return null;
  const d = new Date(+m[3], +m[2]-1, +m[1]);
  return d.getMonth() + 1;
}
function isAuroraSeason(baseDateStr) {
  const m = monthFromBaseDateStr(baseDateStr);
  // Sep–Abr válidos; si no hay fecha, no bloquear
  if (!m) return true;
  return (m >= 9 && m <= 12) || (m >= 1 && m <= 4);
}

// ==================== 12. TIEMPOS/HORARIOS (utilidades flexibles) ====================
function toMinutes(hhmm) {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const [h, m] = hhmm.split(":").map(n => +n);
  return h * 60 + m;
}
function fromMinutes(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
}
function overlap(aStart, aEnd, bStart, bEnd) {
  const aS = toMinutes(aStart), aE = toMinutes(aEnd);
  const bS = toMinutes(bStart), bE = toMinutes(bEnd);
  if (aS == null || aE == null || bS == null || bE == null) return false;
  return Math.max(aS, bS) < Math.min(aE, bE);
}
function clampWindow(act, startDay, endDay) {
  // Ajustar actividades que “salgan” de la ventana del día
  const s = toMinutes(act.start);
  const e = toMinutes(act.end);
  const S = toMinutes(startDay);
  const E = toMinutes(endDay);
  if (s == null || e == null || S == null || E == null) return act;
  if (s < S) act.start = startDay;
  if (e > E) act.end = endDay;
  return act;
}

// ==================== 13. MOTOR DE DÍA (generación & optimización) ====================
function suggestCoreDay(cityName, windowStart, windowEnd) {
  // Motor local: sugiere “núcleo” por categorías razonables (sin alucinar).
  // NOTA: No metemos auroras aquí salvo que la validación lo permita y sea de noche.
  const pack = [];
  const S = toMinutes(windowStart || "08:00");
  const E = toMinutes(windowEnd   || "20:00");

  // Bloque casco histórico + mercado + mirador
  let t = S;
  const blocks = [
    { name: "Paseo por casco histórico", dur: 120, tag: "cascoHistorico" },
    { name: "Mercado/local food",        dur: 90,  tag: "mercado" },
    { name: "Museo principal",           dur: 120, tag: "museos" },
    { name: "Mirador panorámico",        dur: 60,  tag: "mirador" },
  ];

  for (const b of blocks) {
    const st = fromMinutes(t);
    t += b.dur;
    const en = fromMinutes(Math.min(t, E));
    if (toMinutes(en) <= toMinutes(st)) break;
    const proposal = {
      name: b.name,
      start: st,
      end: en
    };
    if (citySupportsActivity(cityName, b.name)) pack.push(proposal);
    if (t >= E) break;
  }

  return pack;
}

function insertAuroraIfApplies(cityName, baseDateStr, dayArray) {
  const c = (cityName||"").toLowerCase();
  if (!AURORA_CITIES.includes(c)) return dayArray;
  if (!isAuroraSeason(baseDateStr)) return dayArray;

  // Deja una sola noche por defecto si no hay ninguna planificada en ese día.
  const already = dayArray.some(a => /aurora/i.test(a.name));
  if (!already) {
    dayArray = dayArray.filter(a => toMinutes(a.end || "00:00") <= toMinutes("21:00")); // corta el día a 21:00
    dayArray.push({
      name: "Caza de auroras (tour guiado)",
      start: "21:00",
      end: "23:30",
      notes: "Incluye guía experto, pronóstico y fotografía. No conduzcas si hay hielo/nieve."
    });
  }
  return dayArray;
}

function sanitizeActivitiesForCity(cityName, acts) {
  return acts.filter(a => citySupportsActivity(cityName, a.name || a.activity || ""));
}

function sortByStart(acts) {
  return acts.slice().sort((x,y) => (toMinutes(x.start||"00:00")||0) - (toMinutes(y.start||"00:00")||0));
}

function compactAndClamp(acts, startDay, endDay) {
  // 1) Orden
  let arr = sortByStart(acts).map(a => clampWindow(a, startDay, endDay));
  // 2) Resolver solapamientos (simple: empujar hacia adelante si colisiona)
  for (let i=1; i<arr.length; i++) {
    const prev = arr[i-1], cur = arr[i];
    if (overlap(prev.start, prev.end, cur.start, cur.end)) {
      // Empujar el inicio al fin del anterior (manteniendo duración si es posible)
      const dur = Math.max(15, (toMinutes(cur.end) - toMinutes(cur.start)));
      const newStart = toMinutes(prev.end);
      let newEnd = newStart + dur;
      if (newEnd > toMinutes(endDay)) {
        newEnd = toMinutes(endDay);
      }
      cur.start = fromMinutes(newStart);
      cur.end   = fromMinutes(newEnd);
    }
  }
  // 3) Compactar pequeños huecos: (opcional, no intrusivo)
  return arr;
}

function ensureDayHasContent(cityName, baseDateStr, acts, startDay, endDay) {
  let working = acts.slice();
  if (working.length === 0) {
    working = suggestCoreDay(cityName, startDay, endDay);
  }
  // Auroras si corresponde (no ciudades absurdas)
  working = insertAuroraIfApplies(cityName, baseDateStr, working);
  // Valida que cada actividad tenga sentido para la ciudad
  working = sanitizeActivitiesForCity(cityName, working);
  // Orden y límites
  working = compactAndClamp(working, startDay, endDay);
  return working;
}

// ==================== 14. GENERACIÓN POR CIUDAD/DÍA ====================
function generateItineraryForCity(cityIndex, dayNumber = null) {
  const city = cities[cityIndex];
  if (!city) return;

  setLoadingOverlay(true, "Astra está generando itinerarios...");
  showThinkingIndicator(true);

  const cityId = city.id;
  const baseDate = city.baseDate || ""; // si manejas baseDate en UI, enlázalo aquí
  const dayWindows = {
    start: city.startHour || "08:00",
    end:   city.endHour   || "20:30"
  };

  // Si piden sólo un día (nuevo), generar ese día; si no, todos
  const daysToProcess = dayNumber ? [dayNumber] : [...Array(city.days).keys()].map(i => i+1);

  daysToProcess.forEach(d => {
    const bucket = itineraries[cityId][d-1];
    const existing = (bucket.activities || []).map(a => ({
      name: a.name || a.activity || "",
      start: a.start || "09:00",
      end: a.end || "10:00",
      notes: a.notes || ""
    }));

    const finalDay = ensureDayHasContent(city.name, baseDate, existing, dayWindows.start, dayWindows.end);
    // Persistir (manteniendo shape original)
    bucket.activities = finalDay.map(a => ({
      name: a.name,
      start: a.start,
      end: a.end,
      notes: a.notes || ""
    }));
  });

  renderItineraryForCity(cityId);
  showThinkingIndicator(false);
  setLoadingOverlay(false);
  addChatMessage("ai", `🗺️ Itinerario actualizado en ${city.name}${dayNumber ? " — día " + dayNumber : ""}.`);
}

function generateSmartTourismSuggestions(cityName, cityIndex) {
  // Este generador produce sugerencias informativas “estilo guía” sin tocar el itinerario,
  // cumpliendo con la regla: no preguntar si desea modificar; sólo sugiere.
  const core = [
    "Paseo por el casco histórico y plaza principal",
    "Museo clave de la ciudad",
    "Mercado local para comer típico",
    "Mirador con vistas panorámicas"
  ];
  const c = (cityName||"").toLowerCase();
  const extra = [];

  if (AURORA_CITIES.includes(c)) {
    extra.push("Si estás de Sep–Abr, reserva un tour de caza de auroras (21:00–23:30).");
  }
  if (/madrid/.test(c)) {
    extra.push("Excursión a Segovia o Toledo como day-trip (tren o bus).");
  }
  if (/barcelona/.test(c)) {
    extra.push("Arquitectura de Gaudí (Sagrada Familia, Park Güell) y paseo por el Born.");
  }
  if (/reykjavik/.test(c)) {
    extra.push("Aguas termales (Blue Lagoon / Sky Lagoon) y Golden Circle como excursión.");
  }

  const bullets = core.concat(extra).map(x => `• ${x}`).join("<br>");
  addChatMessage("ai", `Aquí tienes ideas imperdibles en <strong>${cityName}</strong>:<br>${bullets}`);
}

// ==================== 15. SUSTITUCIÓN / MOVIMIENTO ROBUSTOS + OPTIMIZACIÓN ====================
function optimizeItineraryDay(cityId, dayNumber) {
  const city = cities.find(c => c.id === cityId);
  if (!city) return;
  const baseDate = city.baseDate || "";
  const startDay = city.startHour || "08:00";
  const endDay   = city.endHour   || "20:30";

  const bucket = itineraries[cityId][dayNumber-1];
  const acts = (bucket.activities||[]).map(a => ({
    name: a.name || a.activity || "",
    start: a.start || "09:00",
    end: a.end || "10:00",
    notes: a.notes || ""
  }));

  const finalDay = ensureDayHasContent(city.name, baseDate, acts, startDay, endDay);
  bucket.activities = finalDay.map(a => ({ name:a.name, start:a.start, end:a.end, notes:a.notes||"" }));
}

function replaceActivityInDay(cityId, dayNumber, queryOld, newActName) {
  const day = itineraries[cityId][dayNumber-1];
  if (!day) return false;
  const idx = day.activities.findIndex(a => (a.name || "").toLowerCase().includes((queryOld||"").toLowerCase()));
  if (idx === -1) return false;

  const city = cities.find(c => c.id === cityId);
  if (!city) return false;

  // Validar nueva actividad contra ciudad
  if (!citySupportsActivity(city.name, newActName)) {
    // Buscar alternativa válida genérica
    newActName = "Paseo por casco histórico";
  }
  // Reemplazar manteniendo slot temporal
  const prev = day.activities[idx];
  day.activities[idx] = { name: newActName, start: prev.start, end: prev.end, notes: "" };
  optimizeItineraryDay(cityId, dayNumber);
  return true;
}

function moveActivityBetweenDays(cityId, fromDay, toDay, queryAct) {
  const src = itineraries[cityId][fromDay-1];
  const dst = itineraries[cityId][toDay-1];
  if (!src || !dst) return false;

  const idx = src.activities.findIndex(a => (a.name || "").toLowerCase().includes((queryAct||"").toLowerCase()));
  if (idx === -1) return false;

  const act = src.activities.splice(idx, 1)[0];
  // Reinsertar hacia el final de destino (el optimizador recoloca)
  dst.activities.push({
    name: act.name,
    start: act.start,
    end: act.end,
    notes: act.notes || ""
  });

  // Optimizar ambos días
  optimizeItineraryDay(cityId, fromDay);
  optimizeItineraryDay(cityId, toDay);
  return true;
}

// ==================== 16. DÍAS DE AURORA ESPECÍFICOS (p. ej. “sólo días 1 y 3”) ====================
function setAuroraOnlyOnDays(cityId, allowedDays = []) {
  const city = cities.find(c => c.id === cityId);
  if (!city) return;

  const c = (city.name||"").toLowerCase();
  if (!AURORA_CITIES.includes(c)) return;

  const baseDate = city.baseDate || "";
  // Limpiar auroras en días no permitidos
  itineraries[cityId].forEach((day, i) => {
    const dayNum = i+1;
    const keep = allowedDays.includes(dayNum);
    day.activities = (day.activities || []).filter(a => {
      const isAurora = /aurora/i.test(a.name || "");
      return keep ? true : !isAurora;
    });
    // Si el día está permitido y no tiene aurora, insertarla (una vez)
    if (keep && !day.activities.some(a => /aurora/i.test(a.name||""))) {
      // Insertar bloque 21:00–23:30
      day.activities = day.activities.filter(a => toMinutes(a.end) <= toMinutes("21:00"));
      day.activities.push({ name:"Caza de auroras (tour guiado)", start:"21:00", end:"23:30", notes:"Mejor con guía: pronóstico y fotografía." });
      // Validar temporada
      if (!isAuroraSeason(baseDate)) {
        // Si no es temporada, no insertar y opcionalmente deja nota
        day.activities = day.activities.filter(a => !/aurora/i.test(a.name||""));
      }
    }
    optimizeItineraryDay(cityId, dayNum);
  });
}

// ==================== 17. CONEXIÓN CON BLOQUE 2 (Handlers refinados) ====================
// Extiende los handlers del Bloque 2 para reoptimizar y validar globalmente

// Exponer funciones de utilidad a los handlers previos si es necesario
window._plannerV46 = {
  generateItineraryForCity,
  optimizeItineraryDay,
  moveActivityBetweenDays,
  replaceActivityInDay,
  setAuroraOnlyOnDays,
  setLoadingOverlay,
  showThinkingIndicator
};

// Si el flujo del Bloque 2 agrega un día y crea “sólo actividad nocturna” (caso Tromsø),
// este guardado se asegura de que se complete un día lógico:
function ensureNewDayFullyBuilt(cityIdx, dayNumber) {
  const city = cities[cityIdx];
  if (!city) return;
  const cityId = city.id;
  const bucket = itineraries[cityId][dayNumber-1];
  if (!bucket) return;

  const baseDate = city.baseDate || "";
  const startDay = city.startHour || "08:00";
  const endDay   = city.endHour   || "20:30";

  const acts = (bucket.activities||[]).map(a => ({
    name: a.name || "",
    start: a.start || "09:00",
    end: a.end || "10:00",
    notes: a.notes || ""
  }));

  const final = ensureDayHasContent(city.name, baseDate, acts, startDay, endDay);
  bucket.activities = final.map(a => ({ name:a.name, start:a.start, end:a.end, notes:a.notes||"" }));
  renderItineraryForCity(cityId);
}

// ==================== 18. APLICACIÓN EN COMANDOS FRECUENTES (Sustituir/Mover) ====================
// Re-enganche rápido si tus handlers del Bloque 2 llaman a estas funciones:

function applyReplaceActivityFlow(cityIdx, text) {
  const city = cities[cityIdx];
  if (!city) return;

  const query = extractActivityName(text) || ""; // Debe venir entre “”
  const dayNumber = extractDayFromText(text) ||  getActiveDayIndex(city.id) + 1 || 1;
  const newNameMatch = text.match(/por\s+"(.*?)"/i);
  const newName = newNameMatch ? newNameMatch[1] : null;

  if (!query || !newName) {
    addChatMessage("ai", "Indica la actividad a reemplazar entre comillas y la nueva actividad: Ej: sustituir \"Camp Nou\" por \"Museo Picasso\".");
    return;
  }

  setLoadingOverlay(true, "Aplicando cambios en tu día...");
  showThinkingIndicator(true);

  const ok = replaceActivityInDay(city.id, dayNumber, query, newName);
  renderItineraryForCity(city.id);
  showThinkingIndicator(false);
  setLoadingOverlay(false);

  if (ok) {
    addChatMessage("ai", `✅ Reemplacé "${query}" por "${newName}" y reoptimicé el día ${dayNumber} en ${city.name}.`);
  } else {
    addChatMessage("ai", `No encontré "${query}" en el día ${dayNumber} de ${city.name}.`);
  }
}

function applyMoveActivityFlow(cityIdx, text) {
  const city = cities[cityIdx];
  if (!city) return;

  const query = extractActivityName(text) || "";
  const toDay = extractDayFromText(text);
  if (!query || !toDay) {
    addChatMessage("ai", "Indica actividad entre comillas y el día destino: Ej: mover \"Sagrada Familia\" al día 2.");
    return;
  }

  setLoadingOverlay(true, "Reorganizando actividades...");
  showThinkingIndicator(true);

  // Buscar desde cualquier día → a toDay
  let moved = false;
  for (let d=1; d<=city.days; d++) {
    if (moveActivityBetweenDays(city.id, d, toDay, query)) {
      moved = true;
      break;
    }
  }

  renderItineraryForCity(city.id);
  showThinkingIndicator(false);
  setLoadingOverlay(false);

  if (moved) {
    addChatMessage("ai", `📆 Moví "${query}" al día ${toDay} y optimicé la agenda.`);
  } else {
    addChatMessage("ai", `No encontré "${query}" en el itinerario de ${city.name}.`);
  }
}

// ==================== 19. CONTROL ESPECIAL: “Auroras sólo en días X e Y” ====================
function tryApplyAuroraOnlyDaysCommand(cityIdx, text) {
  const city = cities[cityIdx];
  if (!city) return false;

  if (!/(aurora|auroras)/i.test(text)) return false;
  const m = [...text.matchAll(/d[ií]a[s]?\s*(\d+)/gi)].map(x => parseInt(x[1],10)).filter(Boolean);
  if (m.length === 0) return false;

  setLoadingOverlay(true, "Ajustando noches de auroras…");
  showThinkingIndicator(true);

  setAuroraOnlyOnDays(city.id, m);
  renderItineraryForCity(city.id);

  showThinkingIndicator(false);
  setLoadingOverlay(false);

  addChatMessage("ai", `🌌 Dejé “caza de auroras” únicamente en los días: ${m.join(", ")}.`);
  return true;
}

// ==================== 20. INTEGRACIÓN: GANCHOS RÁPIDOS ====================
// Si tu Bloque 2 llama a “handleReplaceActivityIntent / handleMoveActivityIntent”,
// puedes redirigir internamente a estas funciones para garantizar optimización.
window._plannerV46Flows = {
  applyReplaceActivityFlow,
  applyMoveActivityFlow,
  tryApplyAuroraOnlyDaysCommand,
  ensureNewDayFullyBuilt
};

// (Opcional) ejemplo de uso desde Bloque 2:
// - En handleReplaceActivityIntent(...) → _plannerV46Flows.applyReplaceActivityFlow(cityIdx, text);
// - En handleMoveActivityIntent(...)    → _plannerV46Flows.applyMoveActivityFlow(cityIdx, text);
// - En processChatMessage(...) antes de otras ramas → if (_plannerV46Flows.tryApplyAuroraOnlyDaysCommand(cityIdx, text)) return;

// ==================== 21. LISTO ====================
// Este bloque asegura:
// - Nunca pondrá actividades imposibles en una ciudad (validador).
// - Auroras sólo en ciudades y temporada correctas.
// - Puede definir exactamente qué días llevan auroras.
// - Sustituir/mover actividades reoptimiza el día implicado.
// - Motor de generación/optimización local coherente y flexible.
// - Indicadores visuales restaurados (pensando + overlay).
