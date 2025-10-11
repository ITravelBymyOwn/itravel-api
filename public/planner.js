/* ============================================================
   SECTION 1 — GLOBAL STATE & CONSTANTS
   ============================================================ */
const API_URL = "https://itravelbymyown-api.vercel.app/api/chat";

let savedDestinations = []; // [{city, days, baseDate:Date|null, hotel:null|string}]
let itineraries = {};       // city -> { byDay:{1:[rows],...}, baseDate:Date|null, currentDay:number }
let cityMeta = {};          // city -> { baseDate:"DD/MM/YYYY"|null, start:"HH:MM"|null, end:"HH:MM"|null, hotel:string }
let session = [];
let activeCity = null;
let isItineraryLocked = false;

const DEFAULT_START = "08:30";
const DEFAULT_END   = "18:00";
const travelerIds = ["p-adults","p-young","p-children","p-infants","p-seniors"];

const qs  = (s,ctx=document)=>ctx.querySelector(s);
const ce  = (t,c)=>{const e=document.createElement(t); if(c) e.className=c; return e;};

/* ============================================================
   SECTION 2 — DATE HELPERS
   ============================================================ */
function parseDMY(str){
  if(!str) return null;
  const m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if(!m) return null;
  const d = +m[1], mo = +m[2]-1, y = +m[3];
  const dt = new Date(y, mo, d);
  if(dt.getFullYear()!==y || dt.getMonth()!==mo || dt.getDate()!==d) return null;
  return dt;
}
function formatDMY(d){
  const dd = String(d.getDate()).padStart(2,"0");
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const yy = d.getFullYear();
  return `${dd}/${mm}/${yy}`;
}
function addDays(d,n){ const x=new Date(d.getTime()); x.setDate(x.getDate()+n); return x; }

/* ============================================================
   SECTION 3 — SIDEBAR UI (ADD/REMOVE ROWS)
   ============================================================ */
const $cityList = qs("#city-list");
function addCityRow(preset={city:"",days:"",date:""}){
  const row = ce("div","city-row");
  const iCity = ce("input"); iCity.placeholder="Ciudad"; iCity.value=preset.city||"";
  const iDays = ce("input"); iDays.type="number"; iDays.placeholder="Días"; iDays.min="1"; iDays.value=preset.days||"";
  const iDate = ce("input"); iDate.type="text"; iDate.placeholder="DD/MM/AAAA (opcional)"; iDate.value=preset.date||"";
  const bDel  = ce("button","remove"); bDel.textContent="✕"; bDel.onclick=()=>row.remove();
  row.append(iCity,iDays,iDate,bDel);
  $cityList.appendChild(row);
}
qs("#add-city-btn").addEventListener("click", ()=>addCityRow());

/* ============================================================
   SECTION 4 — SAVE DESTINATIONS & VALIDATION
   ============================================================ */
const $save = qs("#save-destinations");
const $start = qs("#start-planning");
$save.addEventListener("click", ()=>{
  savedDestinations = [];
  cityMeta = {};
  itineraries = {};
  activeCity = null;

  $cityList.querySelectorAll(".city-row").forEach(r=>{
    const [iCity,iDays,iDate] = r.querySelectorAll("input");
    const city = (iCity.value||"").trim();
    const days = Math.max(1, parseInt(iDays.value||"0",10)||0);
    const baseDate = parseDMY((iDate.value||"").trim());
    if(city && days>0){
      savedDestinations.push({ city, days, baseDate: baseDate||null, hotel: null });
      itineraries[city] = { byDay:{}, baseDate: baseDate||null, currentDay:1 };
      for(let d=1; d<=days; d++) itineraries[city].byDay[d] = [];
      cityMeta[city] = { baseDate: baseDate?formatDMY(baseDate):null, start:null, end:null, hotel:"" };
    }
  });

  if(!savedDestinations.length){
    chatMsg("⚠️ Agrega al menos una ciudad con días válidos.", "ai");
    $start.disabled = true;
    return;
  }
  $start.disabled = false;
  activeCity = savedDestinations[0].city;
  renderCityTabs();
  renderCityItinerary(activeCity);
  chatMsg("✅ Destinos guardados. Pulsa «Iniciar planificación» para comenzar.", "ai");
});

/* ============================================================
   SECTION 5 — START FLOW (META ONLY: HOTEL)
   ============================================================ */
const $chatContainer = qs("#chat-container");
const $chatInput = qs("#chat-input");
const $sendBtn = qs("#send-btn");
let metaIndex = 0; // índice de ciudad para preguntar solo hospedaje
let awaitingHotel = false;

$start.addEventListener("click", ()=>{
  if(!savedDestinations.length) return;
  $chatContainer.style.display = "block";
  metaIndex = 0;
  session = [
    {role:"system", content:"Eres un concierge de viajes premium. Devuelves respuestas estrictamente en JSON según el contrato solicitado."}
  ];
  askHotelFor(metaIndex);
});

function askHotelFor(idx){
  const city = savedDestinations[idx].city;
  activeCity = city;
  renderCityTabs();
  renderCityItinerary(city);
  chatMsg(`🏨 ¿Dónde te vas a hospedar en <strong>${city}</strong>?`, "ai");
  chatMsg(`<small style="display:block;margin-top:.25rem;color:#667085">Si aún no tienes el hotel definido, escribe <strong>Pendiente</strong>. El agente te sugerirá zonas o alojamientos recomendados; más adelante podrás ajustar detalles.</small>`,"ai");
  awaitingHotel = true;
}

/* ============================================================
   SECTION 6 — CITY TABS + RENDER CURRENT
   ============================================================ */
function renderCityTabs(){
  const $tabs = qs("#city-tabs");
  $tabs.innerHTML = "";
  savedDestinations.forEach(({city})=>{
    const b = ce("button","city-tab");
    b.textContent = city;
    if(city===activeCity) b.classList.add("active");
    b.onclick = ()=>{ activeCity=city; renderCityTabs(); renderCityItinerary(city); };
    $tabs.appendChild(b);
  });
}

/* ============================================================
   SECTION 7 — WOW RENDER: TABLES + DAY PAGER
   ============================================================ */
const $itineraryWrap = qs("#itinerary-container");
const $intro = qs("#itinerary-intro");

function renderCityItinerary(city){
  if(!city || !itineraries[city]) return;
  const data = itineraries[city];
  const days = Object.keys(data.byDay).map(n=>+n).sort((a,b)=>a-b);
  $itineraryWrap.innerHTML = "";
  if(!days.length){ $intro.style.display=""; return; }
  $intro.style.display = "none";

  const sections = [];
  const base = data.baseDate;

  days.forEach(dayNum=>{
    const sec = ce("div");
    const title = ce("div","day-title");
    let label = `Día ${dayNum}`;
    if(base){ label += ` (${formatDMY(addDays(base, dayNum-1))})`; }
    title.textContent = label;
    sec.appendChild(title);

    const table = ce("table","itinerary");
    table.innerHTML = `
      <thead>
        <tr>
          <th>Inicio</th><th>Fin</th><th>Actividad</th>
          <th>Desde</th><th>Hacia</th><th>Transporte</th>
          <th>Duración</th><th>Notas</th>
        </tr>
      </thead>
      <tbody></tbody>`;
    const tb = table.querySelector("tbody");
    (data.byDay[dayNum]||[]).forEach(r=>{
      const tr = ce("tr");
      tr.innerHTML = `
        <td>${r.start||""}</td>
        <td>${r.end||""}</td>
        <td>${r.activity||""}</td>
        <td>${r.from||""}</td>
        <td>${r.to||""}</td>
        <td>${r.transport||""}</td>
        <td>${r.duration||""}</td>
        <td>${r.notes||""}</td>`;
      tb.appendChild(tr);
    });
    sec.appendChild(table);
    $itineraryWrap.appendChild(sec);
    sections.push(sec);
  });

  const pager = ce("div","pager");
  const prev = ce("button"); prev.textContent="«";
  const next = ce("button"); next.textContent="»";
  pager.append(prev);
  days.forEach(d=>{ const b=ce("button"); b.textContent=String(d); b.dataset.day=d; pager.appendChild(b); });
  pager.append(next);
  $itineraryWrap.appendChild(pager);

  function show(n){
    sections.forEach((sec,i)=>sec.style.display = days[i]===n ? "block":"none");
    pager.querySelectorAll("button").forEach(b=>b.classList.remove("active"));
    const b = Array.from(pager.querySelectorAll("button")).find(x=>x.dataset.day==String(n));
    if(b) b.classList.add("active");
    prev.classList.toggle("ghost", n===days[0]);
    next.classList.toggle("ghost", n===days.at(-1));
    itineraries[city].currentDay = n;
  }
  pager.addEventListener("click", e=>{
    if(e.target===prev) show(Math.max(days[0], (itineraries[city].currentDay||days[0]) - 1));
    else if(e.target===next) show(Math.min(days.at(-1), (itineraries[city].currentDay||days[0]) + 1));
    else if(e.target.dataset.day) show(+e.target.dataset.day);
  });

  show(itineraries[city].currentDay || days[0]);
}

/* ============================================================
   SECTION 8 — CHAT UI HELPERS
   ============================================================ */
function chatMsg(text, who="ai"){
  if(!text) return;
  const div = ce("div","chat-message "+(who==="user"?"user":"ai"));
  div.innerHTML = String(text);
  const box = qs("#chat-messages");
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

/* ============================================================
   SECTION 9 — SEND/PROCESS MESSAGE
   ============================================================ */
$sendBtn.addEventListener("click", onSend);
$chatInput.addEventListener("keydown",(e)=>{ if(e.key==="Enter"){ e.preventDefault(); onSend(); } });

async function onSend(){
  if(isItineraryLocked){ return showUpsell(); }
  const text = ($chatInput.value||"").trim();
  if(!text) return;
  $chatInput.value = "";
  chatMsg(text,"user");

  if(awaitingHotel){
    const city = savedDestinations[metaIndex].city;
    savedDestinations[metaIndex].hotel = text;
    cityMeta[city].hotel = text;
    awaitingHotel = false;
    metaIndex++;
    if(metaIndex < savedDestinations.length){
      askHotelFor(metaIndex);
      return;
    }
    // ya tenemos hoteles para todas las ciudades -> generar itinerarios
    chatMsg("✨ Perfecto. Estoy generando tus itinerarios…","ai");
    await generateAllCities();
    return;
  }

  // conversación normal (edición libre → se la pasamos al agente con contexto del día visible)
  const city = activeCity || savedDestinations[0]?.city;
  const payload = buildPayload(text);
  const json = await callAgent(payload);
  if(json) applyParsed(json);
}

/* ============================================================
   SECTION 10 — AGENT CONTRACT (REQUEST/RESPONSE)
   ============================================================ */
function buildPayload(followup){
  return {
    model: "gpt-5-nano",
    intake: {
      destinations: savedDestinations.map(d=>({
        name: d.city, days: d.days,
        baseDate: d.baseDate ? formatDMY(d.baseDate) : null,
        hotel: d.hotel || "Pendiente"
      })),
      travelers: Object.fromEntries(travelerIds.map(id=>[id.replace("p-",""), (qs("#"+id).value||"0")])),
      budget: Number(qs("#budget").value||0),
      currency: qs("#currency").value||"USD"
    },
    rules: {
      json_only: true,
      include_transfers: true,
      transfer_buffer_pct: 15,
      default_hours: { start: DEFAULT_START, end: DEFAULT_END }
    },
    followup,
    session_context: session
  };
}

async function callAgent(payload){
  try{
    const res = await fetch(API_URL, {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    });
    if(!res.ok) throw new Error("HTTP "+res.status);
    const data = await res.json();
    // data esperado: { destinations:[{name, rows:[]}, ...], followup:"..." }
    if(data?.followup) chatMsg(data.followup,"ai");
    return data;
  }catch(e){
    console.error(e);
    chatMsg("⚠️ No pude contactar al asistente. Intenta nuevamente.","ai");
    return null;
  }
}

/* ============================================================
   SECTION 11 — APPLY PARSED TO STATE (WOW)
   ============================================================ */
function ensureDays(city, want){
  const byDay = itineraries[city].byDay;
  const current = Object.keys(byDay).map(n=>+n);
  const max = want || Math.max(...current, savedDestinations.find(x=>x.city===city)?.days||1);
  for(let d=1; d<=max; d++) byDay[d] = byDay[d] || [];
}
function applyParsed(parsed){
  if(!parsed?.destinations) return;
  parsed.destinations.forEach(d=>{
    const city = d.name;
    if(!itineraries[city]) itineraries[city] = { byDay:{}, baseDate: null, currentDay:1 };
    const base = savedDestinations.find(x=>x.city===city)?.baseDate || null;
    itineraries[city].baseDate = base;
    (d.rows||[]).forEach(r=>{
      const day = Math.max(1, parseInt(r.day||1,10));
      itineraries[city].byDay[day] = itineraries[city].byDay[day] || [];
      itineraries[city].byDay[day].push({
        start: r.start || DEFAULT_START,
        end: r.end || DEFAULT_END,
        activity: r.activity || "",
        from: r.from || "",
        to: r.to || "",
        transport: r.transport || "",
        duration: r.duration || "",
        notes: r.notes || ""
      });
    });
    ensureDays(city);
  });
  renderCityTabs();
  renderCityItinerary(activeCity || savedDestinations[0]?.city);
}

/* ============================================================
   SECTION 12 — GENERATE ALL CITIES (META COMPLETE)
   ============================================================ */
async function generateAllCities(){
  for(const {city, days} of savedDestinations){
    const baseDate = cityMeta[city]?.baseDate || (itineraries[city].baseDate ? formatDMY(itineraries[city].baseDate) : null);
    const payload = buildPayload(`Genera el itinerario SOLO para "${city}" con ${days} días. Usa formato JSON estricto {destination:"${city}", rows:[...]}. Si no hay horarios dados, aplica ${DEFAULT_START}-${DEFAULT_END}. Incluye traslados con +15% colchón.`);
    const data = await callAgent(payload);
    if(data) applyParsed(data);
  }
  chatMsg("✅ Itinerarios listos. Revisa por ciudad y ajusta lo que necesites.","ai");
}

/* ============================================================
   SECTION 13 — TOOLBAR & MODULES (LOCK GUARD)
   ============================================================ */
function lockGuard(fn){
  return ()=>{ if(isItineraryLocked) return showUpsell(); fn(); };
}
qs("#btn-pdf").addEventListener("click", lockGuard(()=>alert("PDF (futuro)")));
qs("#btn-email").addEventListener("click", lockGuard(()=>alert("Email (futuro)")));
qs("#btn-maps").addEventListener("click", lockGuard(()=>openGoogleMapsCity()));
qs("#btn-transport").addEventListener("click", lockGuard(()=>alert("Transporte sugerido (futuro)")));
qs("#btn-weather").addEventListener("click", lockGuard(()=>alert("Clima (futuro)")));
qs("#btn-clothing").addEventListener("click", lockGuard(()=>alert("Sugerencia de ropa (futuro)")));
qs("#btn-restaurants").addEventListener("click", lockGuard(()=>alert("Restaurantes (futuro)")));
qs("#btn-gas").addEventListener("click", lockGuard(()=>alert("Gasolineras (futuro)")));
qs("#btn-bathrooms").addEventListener("click", lockGuard(()=>alert("Baños (futuro)")));
qs("#btn-lodging").addEventListener("click", lockGuard(()=>alert("Hospedaje recomendado (futuro)")));
qs("#btn-localinfo").addEventListener("click", lockGuard(()=>alert("Info local (futuro)")));

/* ===== mismos módulos duplicados en menú lateral ===== */
qs("#mod-weather").addEventListener("click", ()=>qs("#btn-weather").click());
qs("#mod-clothing").addEventListener("click", ()=>qs("#btn-clothing").click());
qs("#mod-restaurants").addEventListener("click", ()=>qs("#btn-restaurants").click());
qs("#mod-gas").addEventListener("click", ()=>qs("#btn-gas").click());
qs("#mod-bathrooms").addEventListener("click", ()=>qs("#btn-bathrooms").click());
qs("#mod-lodging").addEventListener("click", ()=>qs("#btn-lodging").click());
qs("#mod-transport").addEventListener("click", ()=>qs("#btn-transport").click());
qs("#mod-local").addEventListener("click", ()=>qs("#btn-localinfo").click());

function openGoogleMapsCity(){
  const c = activeCity || savedDestinations[0]?.city;
  if(!c) return;
  window.open(`https://www.google.com/maps/search/${encodeURIComponent(c)}`,"_blank");
}

/* ============================================================
   SECTION 14 — BUSINESS RULES: LOCK & UPSELL + RESET
   ============================================================ */
qs("#confirm-itinerary").addEventListener("click", ()=>{
  isItineraryLocked = true;
  chatMsg("🔒 Itinerario fijado. Para editar y exportar, mejora a Premium.","ai");
});
function showUpsell(){
  qs("#monetization-upsell").style.display = "flex";
}
qs("#upsell-close").addEventListener("click", ()=>qs("#monetization-upsell").style.display="none");
qs("#upsell-cta").addEventListener("click", ()=>alert("Flujo de pago/upgrade (futuro)"));

/* Reiniciar: limpia todo estado y UI */
qs("#reset-planner").addEventListener("click", ()=>{
  if(!confirm("¿Seguro que deseas reiniciar todo?")) return;
  savedDestinations = [];
  itineraries = {};
  cityMeta = {};
  session = [];
  activeCity = null;
  isItineraryLocked = false;
  qs("#city-list").innerHTML = "";
  addCityRow();
  renderCityTabs();
  qs("#itinerary-container").innerHTML = "";
  qs("#itinerary-intro").style.display = "";
  qs("#start-planning").disabled = true;
  $chatContainer.style.display = "none";
  qs("#chat-messages").innerHTML = "";
  chatMsg("♻️ Planner reiniciado.","ai");
});

/* ============================================================
   SECTION 15 — INIT (AUTO FIRST ROW)
   ============================================================ */
window.addEventListener("DOMContentLoaded", ()=>{
  addCityRow();
});
