/* ============================================================
   SECTION 1 — GLOBAL STATE VARIABLES
   ============================================================ */
let savedDestinations = [];
let itineraries = {};
let session = [];
let activeCity = null;
let isItineraryLocked = false;
let awaitingMetaReply = false;
let metaCityIndex = 0;
const DEFAULT_START = "08:30";
const DEFAULT_END = "18:00";

/* ============================================================
   SECTION 2 — HELPER FUNCTIONS (DOM & UTILS)
   ============================================================ */
const qs = (sel) => document.querySelector(sel);
const qsa = (sel) => document.querySelectorAll(sel);
const ce = (tag, cls) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  return el;
};
function msg(text, role = "ai") {
  const div = ce("div", `chat-message ${role}`);
  div.innerHTML = text;
  qs("#chat-messages").appendChild(div);
  qs("#chat-messages").scrollTop = qs("#chat-messages").scrollHeight;
}
function parseDMY(str) {
  if (!str) return null;
  const [d, m, y] = str.split("/").map(Number);
  return new Date(y, m - 1, d);
}
function formatDate(date) {
  return date.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/* ============================================================
   SECTION 3 — SIDEBAR UI: ADD / REMOVE CITY ROWS
   ============================================================ */
function addCityRow() {
  const row = ce("div", "city-row");
  const inputCity = ce("input");
  inputCity.placeholder = "Ciudad";

  const inputDays = ce("input");
  inputDays.type = "number";
  inputDays.placeholder = "Días";

  const inputDate = ce("input");
  inputDate.type = "text";
  inputDate.placeholder = "DD/MM/AAAA (opcional)";

  const btnRemove = ce("button", "remove");
  btnRemove.textContent = "✕";
  btnRemove.onclick = () => row.remove();

  row.append(inputCity, inputDays, inputDate, btnRemove);
  qs("#city-list").appendChild(row);
}

/* ============================================================
   SECTION 4 — SAVE DESTINATIONS
   ============================================================ */
qs("#save-destinations").addEventListener("click", () => {
  savedDestinations = [];
  qsa(".city-row").forEach((row) => {
    const [cityInput, daysInput, dateInput] = row.querySelectorAll("input");
    const city = cityInput.value.trim();
    const days = parseInt(daysInput.value.trim()) || 0;
    const baseDate = parseDMY(dateInput.value.trim());
    if (city && days > 0) {
      savedDestinations.push({ name: city, days, baseDate, hotel: null });
    }
  });

  if (savedDestinations.length > 0) {
    qs("#start-planning").disabled = false;
    msg("✅ Destinos guardados. Pulsa *Iniciar planificación* para comenzar.", "ai");
  } else {
    msg("⚠️ Agrega al menos una ciudad con días válidos.", "ai");
  }
});

/* ============================================================
   SECTION 5 — START PLANNING FLOW
   ============================================================ */
qs("#start-planning").addEventListener("click", () => {
  qs("#chat-container").style.display = "flex";
  activeCity = savedDestinations[0].name;
  metaCityIndex = 0;
  askNextMeta();
});

/* ============================================================
   SECTION 6 — CITY TABS RENDERING
   ============================================================ */
function renderCityTabs() {
  const container = qs("#city-tabs");
  container.innerHTML = "";
  savedDestinations.forEach((d) => {
    const btn = ce("button", "city-tab");
    btn.textContent = d.name;
    if (d.name === activeCity) btn.classList.add("active");
    btn.onclick = () => {
      activeCity = d.name;
      renderItinerary();
      renderCityTabs();
    };
    container.appendChild(btn);
  });
}

/* ============================================================
   SECTION 7 — RENDER ITINERARY (WOW FACTOR)
   ============================================================ */
function renderItinerary() {
  const cityData = itineraries[activeCity];
  const container = qs("#output");
  container.innerHTML = "";
  if (!cityData || !cityData.byDay) return;

  const days = Object.keys(cityData.byDay).sort((a, b) => a - b);
  days.forEach((day) => {
    const dayDiv = ce("div");
    const title = ce("div", "day-title");
    const baseDate = cityData.baseDate;
    let label = `Día ${day}`;
    if (baseDate) {
      const date = new Date(baseDate.getTime());
      date.setDate(date.getDate() + (parseInt(day) - 1));
      label += ` (${formatDate(date)})`;
    }
    title.textContent = label;
    dayDiv.appendChild(title);

    const table = ce("table", "itinerary");
    const thead = ce("thead");
    thead.innerHTML = `<tr>
      <th>Inicio</th><th>Fin</th><th>Actividad</th>
      <th>Desde</th><th>Hacia</th><th>Transporte</th><th>Duración</th><th>Notas</th>
    </tr>`;
    table.appendChild(thead);

    const tbody = ce("tbody");
    cityData.byDay[day].forEach((row) => {
      const tr = ce("tr");
      tr.innerHTML = `
        <td>${row.start || ""}</td>
        <td>${row.end || ""}</td>
        <td>${row.activity || ""}</td>
        <td>${row.from || ""}</td>
        <td>${row.to || ""}</td>
        <td>${row.transport || ""}</td>
        <td>${row.duration || ""}</td>
        <td>${row.notes || ""}</td>
      `;
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    dayDiv.appendChild(table);
    container.appendChild(dayDiv);
  });
}

/* ============================================================
   SECTION 8 — CHAT HANDLER
   ============================================================ */
qs("#send-btn").addEventListener("click", () => {
  if (isItineraryLocked) {
    qs("#monetization-upsell").style.display = "block";
    return;
  }
  const text = qs("#chat-input").value.trim();
  if (!text) return;
  qs("#chat-input").value = "";
  msg(text, "user");
  if (awaitingMetaReply) {
    savedDestinations[metaCityIndex].hotel = text;
    awaitingMetaReply = false;
    metaCityIndex++;
    if (metaCityIndex < savedDestinations.length) {
      askNextMeta();
    } else {
      processMessage("iniciar planificación");
    }
  } else {
    processMessage(text);
  }
});

/* ============================================================
   SECTION 9 — IA PROCESSING
   ============================================================ */
async function processMessage(text) {
  const payload = {
    destinations: savedDestinations.map(d => ({
      name: d.name,
      days: d.days,
      baseDate: d.baseDate ? formatDate(d.baseDate) : null,
      hotel: d.hotel || "Pendiente"
    })),
    followup: text,
    session_context: session
  };

  msg("⏳ Generando itinerario...", "ai");
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  session.push({ role: "user", content: text });
  session.push({ role: "assistant", content: data.followup });
  msg(data.followup, "ai");
  updateItineraries(data.destinations);
}

/* ============================================================
   SECTION 10 — UPDATE ITINERARIES
   ============================================================ */
function updateItineraries(destArray) {
  destArray.forEach((dest) => {
    itineraries[dest.name] = {
      baseDate: savedDestinations.find(d => d.name === dest.name)?.baseDate,
      byDay: {}
    };
    dest.rows.forEach((r) => {
      if (!itineraries[dest.name].byDay[r.day]) itineraries[dest.name].byDay[r.day] = [];
      itineraries[dest.name].byDay[r.day].push({
        start: r.start || DEFAULT_START,
        end: r.end || DEFAULT_END,
        activity: r.activity,
        from: r.from,
        to: r.to,
        transport: r.transport,
        duration: r.duration,
        notes: r.notes || ""
      });
    });
  });
  renderCityTabs();
  renderItinerary();
}

/* ============================================================
   SECTION 11 — TOOLBAR ACTIONS
   ============================================================ */
qs("#export-pdf").addEventListener("click", () => {
  if (isItineraryLocked) return qs("#monetization-upsell").style.display = "block";
  alert("📝 Exportar a PDF (funcionalidad futura)");
});
qs("#export-email").addEventListener("click", () => {
  if (isItineraryLocked) return qs("#monetization-upsell").style.display = "block";
  alert("📩 Enviar por Email (funcionalidad futura)");
});

/* ============================================================
   SECTION 12 — CONFIRM ITINERARY (LOCK)
   ============================================================ */
qs("#confirm-itinerary").addEventListener("click", () => {
  isItineraryLocked = true;
  msg("🔒 Itinerario fijado. Algunas funciones requieren Premium para editar.", "ai");
});

/* ============================================================
   SECTION 13 — MONETIZATION UPSELL
   ============================================================ */
qs("#monetization-upsell").addEventListener("click", () => {
  alert("✨ Desbloquea Premium para editar y exportar itinerarios.");
});

/* ============================================================
   SECTION 14 — META QUESTION FLOW
   ============================================================ */
function askNextMeta() {
  const city = savedDestinations[metaCityIndex].name;
  msg(`📍 ¿Dónde te vas a hospedar en <strong>${city}</strong>?`, "ai");
  msg(`<small style="display:block;font-size:0.75rem;color:#667085;margin-top:0.25rem;">Si aún no tienes el hotel definido, puedes escribir <strong>“Pendiente”</strong>. El agente te sugerirá zonas o alojamientos recomendados. Más adelante en el chat podrás hacer ajustes y elegir la mejor opción.</small>`, "ai");
  awaitingMetaReply = true;
}

/* ============================================================
   SECTION 15 — INIT
   ============================================================ */
window.addEventListener("DOMContentLoaded", () => {
  addCityRow();
});
