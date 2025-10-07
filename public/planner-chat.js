(() => {
  document.addEventListener('DOMContentLoaded', () => {

    // ===== SECCIÓN 1–15: planner estable =====
    // 🔹 Copia exactamente el script que compartiste (desde “Helpers / Referencias DOM” hasta el final)
    // 🔹 Lo dejamos intacto, solo ajustamos el cierre del wrapper para funcionar desde archivo externo

    <!-- ====== PLANNER SCRIPT (final, stable: sequential meta + full day tables) ====== -->
<script>
document.addEventListener('DOMContentLoaded', () => {

// ===== SECCIÓN 1: Helpers / Referencias DOM / Estado =====
/* ============ Helpers ============ */
const qs  = (s, ctx=document)=>ctx.querySelector(s);
const qsa = (s, ctx=document)=>Array.from(ctx.querySelectorAll(s));
const $cities = qs('#cities-container');
const $addCity = qs('#add-city');
const $save = qs('#save-destinations');
const $start = qs('#start-planning');
const $chatC = qs('#chat-container');
const $chatM = qs('#chat-messages');
const $intake = qs('#intake');
const $send = qs('#send-btn');
const $tabs = qs('#city-tabs');
const $itineraryWrap = qs('#itinerary-container');
const $intro = qs('#itinerary-intro');

const travelerIds = ['p-adults','p-young','p-children','p-infants','p-seniors'];
const API_URL = 'https://itravelbymyown-api.vercel.app/api/chat';

// Estado principal
let savedDestinations = []; // [{city, days, order}]
let itineraries = {};       // itineraries[city] = { byDay:{1:[rows],...}, currentDay:1, baseDate:'DD/MM/YYYY' }
let cityMeta = {};          // cityMeta[city] = { baseDate:'DD/MM/YYYY', start:'HH:MM', end:'HH:MM', hotel:'' }
let session = [];
let activeCity = null;

// Control de conversación
let planningStarted = false;
let metaProgressIndex = 0;   // índice de la ciudad cuya meta estamos pidiendo
let collectingMeta = false;  // bandera: estamos en fase de recolección de meta
let awaitingMetaReply = false; // ✅ nueva bandera: evita repetir preguntas mientras espera respuesta
let batchGenerating = false;   // ✅ controla si está generando múltiples itinerarios
let globalReviewAsked = false; // ✅ evita repetir el mensaje de revisión final

// Throttle para hints
let lastMenuHintTs = 0;
function hintMenuOnce(){
  const now = Date.now();
  if(now - lastMenuHintTs > 180000){ // 3 min
    msg(tone.menuHint);
    lastMenuHintTs = now;
  }
}

// ===== SECCIÓN 2: Idioma y tono =====
// === Idioma / tono (breve) ===
function detectLang(){
  const n = (navigator.language || 'en').toLowerCase();
  if(n.startsWith('es')) return 'es';
  if(n.startsWith('pt')) return 'pt';
  if(n.startsWith('fr')) return 'fr';
  return 'en';
}
const LANG = detectLang();
const tone = {
  es: {
    hi: '¡Bienvenido! 👋 Soy tu concierge de viajes personal.',
    startMeta: (city)=>`Comencemos por **${city}**. Indícame en un solo texto: fecha del primer día (DD/MM/AAAA), horas de inicio y fin para CADA día (pueden ser iguales) y hotel o zona.`,
    contMeta:  (city)=>`Continuemos con **${city}**. En un único texto: fecha del primer día (DD/MM/AAAA), horas de inicio y fin diarias y hotel o zona donde te alojas.`,
    focus: ()=>``, // ✅ vaciado para eliminar mensajes “Ahora estamos en...”
    review: (city)=>`Listo, aquí tienes el itinerario para **${city}**. ¿Quieres que haga algún ajuste o lo dejamos así?`,
    nextAsk: (city)=>`Perfecto. Pasemos a **${city}**. ¿Me compartes la fecha del primer día, horas de inicio/fin y hotel/zona?`,
    menuHint: 'Para info más detallada (clima, transporte, restaurantes, etc.) usa los botones del menú inferior 👇',
    welcomeFlow: 'Te guiaré ciudad por ciudad. Si aún no tienes datos de hotel/horarios, propongo el mejor plan y luego lo ajustamos.'
  },
  en: {
    hi: 'Welcome! 👋 I’m your personal travel concierge.',
    startMeta: (city)=>`Let’s start with **${city}**. In one message: day-1 date (DD/MM/YYYY), daily start/end times (they can match), and your hotel/area.`,
    contMeta:  (city)=>`Let’s continue with **${city}**. In one message: day-1 date (DD/MM/YYYY), daily start/end times, and hotel/area.`,
    focus: ()=>``, // ✅ vacío para no sobrecargar el chat
    review: (city)=>`Here’s **${city}**. Any changes or keep it as is?`,
    nextAsk: (city)=>`Great. Let’s move to **${city}**. Share day-1 date, daily start/end times, and hotel/area.`,
    menuHint: 'For more detail (weather, transport, restaurants,…) use the bottom toolbar 👇',
    welcomeFlow: 'I’ll guide you city-by-city. If you don’t have hotel/times yet, I’ll propose and adjust later.'
  },
  fr: {
    hi: 'Bienvenue ! 👋 Je suis votre concierge de voyage.',
    startMeta: (city)=>`Commençons par **${city}** : date du 1er jour (JJ/MM/AAAA), heures de début/fin par jour, hôtel/quartier.`,
    contMeta:  (city)=>`Continuons avec **${city}** : date du 1er jour, heures quotidiennes début/fin et hôtel/quartier.`,
    focus: ()=>``,
    review: (city)=>`Voici **${city}**. Des modifications à faire ?`,
    nextAsk: (city)=>`Parfait. Passons à **${city}** : date du 1er jour, heures début/fin quotidiennes et hôtel/quartier.`,
    menuHint: 'Pour plus de détails (météo, transports, restaurants…), utilisez la barre en bas 👇',
    welcomeFlow: 'Je vous guide ville par ville. Sans infos, je propose puis j’ajuste.'
  },
  pt: {
    hi: 'Bem-vindo! 👋 Sou o seu concierge de viagens.',
    startMeta: (city)=>`Vamos começar por **${city}**. Em uma mensagem: data do 1º dia (DD/MM/AAAA), horários diários de início/fim e hotel/bairro.`,
    contMeta:  (city)=>`Vamos continuar com **${city}**. Em uma mensagem: data do 1º dia, horários diários e hotel/bairro.`,
    focus: ()=>``,
    review: (city)=>`Aqui está **${city}**. Deseja alguma alteração?`,
    nextAsk: (city)=>`Perfeito. Vamos para **${city}**. Informe data do 1º dia, horários início/fim e hotel/bairro.`,
    menuHint: 'Para mais detalhes (clima, transporte, restaurantes etc.), use a barra inferior 👇',
    welcomeFlow: 'Vou guiá-lo cidade a cidade. Se não tiver os dados, proponho e ajusto.'
  }
}[detectLang()];

// Desactivado completamente cualquier hint automático
let lastCityHint = { name:null, ts:0 };
function uiMsgFocusCity(city){ return; }


// ===== SECCIÓN 3: Utilidades de fecha =====
/* ==== Date helpers (para títulos con fecha) ==== */
function parseDMY(str){
  if(!str) return null;

  // Acepta formatos con o sin año explícito (DD/MM o DD/MM/YYYY)
  const mFull = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  const mShort = str.match(/^(\d{1,2})[\/\-](\d{1,2})(?![\/\-]\d{4})$/);
  
  let day, month, year;
  const now = new Date();
  const currentYear = now.getFullYear();

  if(mFull){
    day = Number(mFull[1]);
    month = Number(mFull[2]) - 1;
    year = Number(mFull[3]);
  } else if(mShort){
    day = Number(mShort[1]);
    month = Number(mShort[2]) - 1;
    year = currentYear;

    // Si la fecha ya pasó este año, asumimos que es del siguiente
    const temp = new Date(year, month, day);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if(temp < today){
      year = currentYear + 1;
    }
  } else {
    return null; // formato no reconocido
  }

  // Validar que la fecha sea válida (por ejemplo 31/02 no lo es)
  const date = new Date(year, month, day);
  if(date.getMonth() !== month || date.getDate() !== day) return null;

  return date;
}

function formatDMY(d){
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yy = d.getFullYear();
  return `${dd}/${mm}/${yy}`;
}

function addDays(d, n){
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}

// ===== SECCIÓN 4: Chat helpers / API =====
/* ============ Chat helpers refinados ============ */

// Renderiza mensaje en el chat
function msg(text, who = 'ai') {
  if (!text) return;
  const div = document.createElement('div');
  div.className = 'chat-message ' + (who === 'user' ? 'user' : 'ai');

  // Evita mostrar JSON o itinerarios largos
  if (/\"(activity|destination|byDay|start|end)\"/.test(text) || text.trim().startsWith('{')) {
    text = '✅ Itinerario actualizado en la interfaz.';
  }

  // Simplifica respuestas largas
  if (text.length > 1200) text = text.slice(0, 1200) + '...';

  div.innerHTML = text.replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  $chatM.appendChild(div);
  $chatM.scrollTop = $chatM.scrollHeight;
}

// Llama al modelo remoto
async function callAgent(inputText) {
  const payload = { model: 'gpt-5-nano', input: inputText, history: session };
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(() => ({ text: '' }));
    const raw = data?.text || '';
    if (/```json|<json>/.test(raw) || /^\{[\s\S]*\}$/.test(raw.trim())) return raw;
    if (/itinerario|día|actividades/i.test(raw) && raw.length > 200)
      return '{"followup":"He actualizado el itinerario correctamente."}';
    return raw;
  } catch (err) {
    console.error('callAgent error:', err);
    return '{"followup":"⚠️ No se pudo contactar con el asistente."}';
  }
}

// Extrae JSON válido
function parseJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  const m1 = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```([\s\S]*?)```/i);
  if (m1 && m1[1]) { try { return JSON.parse(m1[1]); } catch (_) {} }
  const m2 = text.match(/<json>\s*([\s\S]*?)\s*<\/json>/i);
  if (m2 && m2[1]) { try { return JSON.parse(m2[1]); } catch (_) {} }
  try {
    const cleaned = text.replace(/^[^\{]+/, '').replace(/[^\}]+$/, '');
    return JSON.parse(cleaned);
  } catch (_) { return null; }
}

  // ===== SECCIÓN 5: UI — Destinos (crear/validar filas) =====
  /* ============ Save Destinations ============ */
  function rebuildOrderOptions() {
    const rows = qsa('.city-row', $cities);
    const total = rows.length;
    rows.forEach((row, idx) => {
      const sel = qs('.city-order', row);
      const cur = sel.value || (idx+1);
      sel.innerHTML = '';
      for(let i=1;i<=total;i++){
        const opt = document.createElement('option');
        opt.value = i; opt.textContent = `${i}º`;
        sel.appendChild(opt);
      }
      sel.value = Math.min(cur, total);
    });
  }

  function addCityRow(data={city:'',days:'',order:null}) {
    const row = document.createElement('div');
    row.className = 'city-row';
    row.innerHTML = `
      <div>
        <label>City</label>
        <input class="city-name" type="text" placeholder="City or Country" value="${data.city||''}">
      </div>
      <div>
        <label>Days</label>
        <input class="city-days" type="number" min="1" placeholder="e.g. 3" value="${data.days||''}">
      </div>
      <div>
        <label>Visit order</label>
        <select class="city-order"></select>
      </div>
      <div style="align-self:end;">
        <button class="remove" type="button">✖</button>
      </div>`;
    qs('.remove', row).addEventListener('click', () => { row.remove(); rebuildOrderOptions(); validateSave(); });
    $cities.appendChild(row);
    rebuildOrderOptions();
    if(data.order) qs('.city-order', row).value = String(data.order);
  }

  function validateSave(){
    const rows = qsa('.city-row', $cities);
    const ok = rows.length>0 && rows.every(r=>{
      const name = qs('.city-name', r).value.trim();
      const days = parseInt(qs('.city-days', r).value, 10);
      return name && days>0;
    });
    $save.disabled = !ok;
    $start.disabled = savedDestinations.length===0;
  }

  $addCity.addEventListener('click', ()=>{ addCityRow(); validateSave(); });
  $cities.addEventListener('input', validateSave);
  addCityRow(); // fila inicial

  // ===== SECCIÓN 6: Guardar destinos / sincronizar estado =====
  $save.addEventListener('click', () => {
    const rows = qsa('.city-row', $cities);
    const list = rows.map(r => ({
      city: qs('.city-name', r).value.trim(),
      days: Math.max(1, parseInt(qs('.city-days', r).value,10)||0),
      order: parseInt(qs('.city-order', r).value,10)
    })).filter(x=>x.city);

    // Orden
    list.sort((a,b)=>a.order-b.order);
    savedDestinations = list;

    // Asegura estructuras
    savedDestinations.forEach(({city,days})=>{
      if(!itineraries[city]) itineraries[city] = { byDay:{}, currentDay:1, baseDate:null };
      if(!cityMeta[city])    cityMeta[city]    = { baseDate:null, start:null, end:null, hotel:'' };
      const existingDays = Object.keys(itineraries[city].byDay).length;
      if(existingDays < days){
        for(let d=existingDays+1; d<=days; d++) itineraries[city].byDay[d] = itineraries[city].byDay[d] || [];
      }else if(existingDays > days){
        const trimmed={}; for(let d=1; d<=days; d++) trimmed[d]=itineraries[city].byDay[d]||[];
        itineraries[city].byDay = trimmed;
        if(itineraries[city].currentDay>days) itineraries[city].currentDay = days;
      }
    });
    // Elimina ciudades removidas
    Object.keys(itineraries).forEach(c=>{ if(!savedDestinations.find(x=>x.city===c)) delete itineraries[c]; });
    Object.keys(cityMeta).forEach(c=>{ if(!savedDestinations.find(x=>x.city===c)) delete cityMeta[c]; });

    renderCityTabs();
    msg('🟪 Saved your cities & days. Click "Start Planning" when you are ready.');
    $start.disabled = savedDestinations.length===0;
  });

  // ===== SECCIÓN 7: Tabs / Render de Itinerario =====
function setActiveCity(name) {
  if (!name) return;
  activeCity = name;
  qsa('.city-tab', $tabs).forEach(btn => {
    btn.classList.toggle('active', btn.dataset.city === name);
  });
}

/* Mantiene ciudad activa sin reset */
function renderCityTabs() {
  const previousCity = activeCity;
  $tabs.innerHTML = '';
  savedDestinations.forEach(({ city }) => {
    const b = document.createElement('button');
    b.className = 'city-tab' + (city === previousCity ? ' active' : '');
    b.textContent = city;
    b.dataset.city = city;
    b.addEventListener('click', () => {
      setActiveCity(city);
      renderCityItinerary(city);
    });
    $tabs.appendChild(b);
  });

  if (savedDestinations.length) {
    $intro.style.display = 'none';
    const validCity = previousCity && savedDestinations.some(x => x.city === previousCity)
      ? previousCity
      : savedDestinations[0].city;
    setActiveCity(validCity);
    renderCityItinerary(validCity);
  } else {
    $intro.style.display = '';
    $itineraryWrap.innerHTML = '';
    activeCity = null;
  }
}

/* Render día por día con paginación persistente */
function renderCityItinerary(city) {
  if (!city || !itineraries[city]) return;
  const data = itineraries[city];
  const days = Object.keys(data.byDay || {}).map(d => parseInt(d, 10)).sort((a, b) => a - b);
  $itineraryWrap.innerHTML = '';
  if (!days.length) {
    $itineraryWrap.innerHTML = '<p>No activities yet. The assistant will fill them in.</p>';
    return;
  }

  const base = parseDMY(data.baseDate || (cityMeta[city]?.baseDate || ''));
  const sections = [];
  days.forEach(dayNum => {
    const sec = document.createElement('div');
    sec.className = 'day-section';
    const dateLabel = base ? ` (${formatDMY(addDays(base, dayNum - 1))})` : '';
    sec.innerHTML = `
      <div class="day-title">Day ${dayNum}${dateLabel}</div>
      <table class="itinerary">
        <thead>
          <tr>
            <th>Start</th><th>End</th><th>Activity</th><th>From</th>
            <th>To</th><th>Transport</th><th>Duration</th><th>Notes</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>`;
    const tb = qs('tbody', sec);
    (data.byDay[dayNum] || []).forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.start || ''}</td><td>${r.end || ''}</td><td>${r.activity || ''}</td>
        <td>${r.from || ''}</td><td>${r.to || ''}</td><td>${r.transport || ''}</td>
        <td>${r.duration || ''}</td><td>${r.notes || ''}</td>`;
      tb.appendChild(tr);
    });
    $itineraryWrap.appendChild(sec);
    sections.push(sec);
  });

  const pager = document.createElement('div');
  pager.className = 'pager';
  const prev = document.createElement('button'); prev.textContent = '«';
  const next = document.createElement('button'); next.textContent = '»';
  pager.appendChild(prev);
  days.forEach(d => {
    const b = document.createElement('button');
    b.textContent = d;
    b.dataset.day = d;
    pager.appendChild(b);
  });
  pager.appendChild(next);
  $itineraryWrap.appendChild(pager);

  function show(n) {
    sections.forEach((sec, i) => (sec.style.display = days[i] === n ? 'block' : 'none'));
    qsa('button', pager).forEach(x => x.classList.remove('active'));
    const btn = qsa('button', pager).find(x => x.dataset.day == String(n));
    if (btn) btn.classList.add('active');
    prev.classList.toggle('ghost', n === days[0]);
    next.classList.toggle('ghost', n === days[days.length - 1]);
    if (itineraries[city]) itineraries[city].currentDay = n;
  }

  pager.addEventListener('click', e => {
    const t = e.target;
    if (t === prev)
      show(Math.max(days[0], (itineraries[city]?.currentDay || days[0]) - 1));
    else if (t === next)
      show(Math.min(days.at(-1), (itineraries[city]?.currentDay || days[0]) + 1));
    else if (t.dataset.day)
      show(Number(t.dataset.day));
  });

  show(itineraries[city]?.currentDay || days[0]);
}

  // ===== SECCIÓN 8: Serialización para el agente =====
  /* ============ Serialización para el agente ============ */
  function getItineraryContext(){
    const snapshot = Object.fromEntries(
      Object.entries(itineraries).map(([city,data])=>{
        const days = Object.fromEntries(
          Object.entries(data.byDay).map(([d,rows])=>[
            d, rows.map(r=>({
              day:Number(d),
              start:r.start||'', end:r.end||'',
              activity:r.activity||'', from:r.from||'',
              to:r.to||'', transport:r.transport||'',
              duration:r.duration||'', notes:r.notes||''
            }))
          ])
        );
        return [city,{days, baseDate: data.baseDate || null}];
      })
    );
    return JSON.stringify(snapshot);
  }
  function getCityMetaContext(){ return JSON.stringify(cityMeta); }

  // ===== SECCIÓN 9: Construcción de intake y formato JSON =====
  /* ============ Construcción de intake ============ */
  function buildIntake(){
    const list = savedDestinations.map(x=>`${x.city} (${x.days} days, order ${x.order})`).join(' | ');
    const pax = travelerIds.map(id=>`${id.replace('p-','')}:${qs('#'+id).value||0}`).join(', ');
    const stay = (qs('#stay-name').value||'').trim();
    const address = (qs('#stay-address').value||'').trim();
    const budget = Number(qs('#budget').value||0);
    const currency = qs('#currency').value||'USD';
    return [
      `Destinations (order): ${list}`,
      `Travelers: ${pax}`,
      `Accommodation: ${stay ? stay+' - ':''}${address}`,
      `Total Budget: ${budget} ${currency}`,
      `Existing plan (keep & adjust): ${getItineraryContext()}`,
      `Existing meta (per city): ${getCityMetaContext()}`
    ].join('\n');
  }

  const FORMAT = `
Devuelve SOLO JSON (sin texto extra) con alguno de estos formatos:
A) {"destinations":[{"name":"City","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"..","from":"..","to":"..","transport":"..","duration":"..","notes":".."}]}], "followup":"Pregunta breve"}
B) {"destination":"City","rows":[{...}],"followup":"Pregunta breve"}
C) {"rows":[{...}],"followup":"Pregunta breve"}
D) {"meta":{"city":"City","baseDate":"DD/MM/YYYY","start":"HH:MM" o ["HH:MM",...],"end":"HH:MM" o ["HH:MM",...],"hotel":"Texto"},"followup":"Pregunta breve"}
Reglas:
- Incluye traslados con transporte y duración (+15% colchón).
- Si faltan datos (p.ej. hora de inicio por día), pregúntalo en "followup" y asume valores razonables.
- Nada de markdown. Solo JSON.`.trim();

// ===== SECCIÓN 10: Generación de itinerarios por ciudad =====
/* ============ Generación por ciudad cuando la meta está completa ============ */
async function generateCityItinerary(city) {
  const conf  = cityMeta[city] || {};
  const days  = (savedDestinations.find(x => x.city === city)?.days) || 1;
  const baseDate = conf.baseDate || '';
  const start = conf.start || '09:00';
  const end   = conf.end   || '17:00';
  const hotel = conf.hotel || '';

  const instructions = `
${FORMAT}
Eres un planificador experto, cálido y empático (concierge premium). Genera el itinerario SOLO para "${city}" con ${days} días.
- Prioriza IMPERDIBLES de la ciudad.
- Si hay tiempo, sugiere excursiones cercanas (p.ej. desde Madrid: Toledo/Segovia) con transporte recomendado.
- Optimiza tiempos y orden.
- Devuelve formato B con "destination":"${city}".
- No escribas itinerarios en texto plano; responde en JSON válido.

Contexto:
- BaseDate (día 1): ${baseDate}
- Hora inicio: ${Array.isArray(start) ? start.join(', ') : start}
- Hora fin: ${Array.isArray(end) ? end.join(', ') : end}
- Hotel/Zona: ${hotel}

Plan existente: ${getItineraryContext()}
`.trim();

  try {
    const text = await callAgent(instructions);
    session.push({ role: 'assistant', content: text || '' });
    const parsed = parseJSON(text);

    if (parsed) {
      const hasRows = Object.values(itineraries[city]?.byDay || {}).some(a => a.length > 0);
      applyParsedToState(parsed, !hasRows);

      // 🔄 Actualiza baseDate si se obtuvo
      if (itineraries[city] && baseDate) itineraries[city].baseDate = baseDate;

      // 🔄 Mantiene foco en la ciudad afectada
      setActiveCity(city);
      renderCityItinerary(city);

      // 💬 Muestra followup solo si viene en JSON, y en el contexto correcto
      if (parsed.followup && !collectingMeta && !batchGenerating) {
        msg(parsed.followup.replace(/\bBarcelona\b/g, city), 'ai');
      } else if (!parsed.followup && !batchGenerating) {
        msg(`✅ Itinerario actualizado correctamente para ${city}.`, 'ai');
      }
    } else {
      msg(`❌ No pude interpretar el itinerario para ${city}. Dame más detalles y lo ajusto.`, 'ai');
    }
  } catch (e) {
    console.error(e);
    msg(`⚠️ Error al generar el itinerario para ${city}.`, 'ai');
  }
}

function metaIsComplete(m) {
  return !!(m && m.baseDate && m.start && m.end && typeof m.hotel === 'string');
}

async function maybeGenerateAllCities() {
  batchGenerating = true; // 🔒 activa modo grupo
  for (const { city } of savedDestinations) {
    const m = cityMeta[city];
    const hasRows = Object.values(itineraries[city]?.byDay || {}).some(a => a.length > 0);
    if (metaIsComplete(m) && !hasRows) {
      await generateCityItinerary(city);
    }
  }
  batchGenerating = false;

  // 💬 Solo una confirmación global al final
  if (!globalReviewAsked) {
    globalReviewAsked = true;
    msg('✨ Todos los itinerarios fueron generados. ¿Deseas revisarlos o ajustar alguno?', 'ai');
  }
}

function nextPendingCity(fromCity = null) {
  const order = savedDestinations.map(x => x.city);
  const startIdx = fromCity ? Math.max(0, order.indexOf(fromCity)) : -1;
  for (let i = startIdx + 1; i < order.length; i++) {
    const c = order[i];
    const m = cityMeta[c];
    const hasRows = Object.values(itineraries[c]?.byDay || {}).some(a => a.length > 0);
    if (!metaIsComplete(m) || !hasRows) return c;
  }
  return null;
}

// ===== SECCIÓN 11: Flujo secuencial de meta (preguntas iniciales) =====
/* ============ Inicio: flujo secuencial de meta ============ */
async function askForNextCityMeta(){
  if(awaitingMetaReply) return; // evita duplicar preguntas

  if(metaProgressIndex >= savedDestinations.length){
    collectingMeta = false;
    msg('Perfecto 🎉 Ya tengo toda la información. Generando itinerarios...');
    await maybeGenerateAllCities();
    return;
  }

  const city = savedDestinations[metaProgressIndex].city;
  activeCity = city;
  const isFirst = metaProgressIndex === 0;
  awaitingMetaReply = true;

  // Mensaje natural y fluido entre ciudades
  msg(isFirst ? tone.startMeta(city) : tone.contMeta(city));
}

async function generateInitial(){
  if(savedDestinations.length===0){
    alert('Por favor agrega las ciudades primero y guarda los destinos.');
    return;
  }
  $chatC.style.display='flex';
  planningStarted = true;
  metaProgressIndex = 0;
  collectingMeta = true;
  awaitingMetaReply = false;
  batchGenerating = false;
  globalReviewAsked = false;

  session = [
    {role:'system', content:'Eres un planificador/concierge de viajes internacional: cálido, empático y culturalmente adaptable. Devuelves itinerarios en JSON limpio con el formato solicitado.'},
    {role:'user', content: buildIntake()}
  ];

  msg(`${tone.hi} ${tone.welcomeFlow}`);
  await askForNextCityMeta();
}
$start.addEventListener('click', generateInitial);

  // ===== SECCIÓN 12: Merge helpers / actualización de estado =====
  /* ============ Merge helpers para filas/meta ============ */
  function dedupeInto(arr, row){
    const key = (o)=>[o.day,o.start||'',o.end||'',(o.activity||'').trim().toLowerCase()].join('|');
    const has = arr.find(x=>key(x)===key(row));
    if(!has) arr.push(row);
  }

  // ⬇️ FIX IMPORTANTE: no recortar días nuevos que vengan desde el chat/JSON
  function ensureDays(city){
    const byDay = itineraries[city].byDay || {};
    const presentDays = Object.keys(byDay).map(n=>parseInt(n,10));
    const maxPresent = presentDays.length ? Math.max(...presentDays) : 0;
    const saved = savedDestinations.find(x=>x.city===city)?.days || 0;
    const want = Math.max(saved, maxPresent); // ⬅️ usamos el máximo
    const have = presentDays.length;

    if(have<want){ for(let d=have+1; d<=want; d++) itineraries[city].byDay[d]=itineraries[city].byDay[d]||[]; }
    if(have>want){
      const trimmed={};
      for(let d=1; d<=want; d++) trimmed[d]=byDay[d]||[];
      itineraries[city].byDay = trimmed;
    }
  }

  function pushRows(city, rows, replace=false){
    if(!itineraries[city]) itineraries[city] = {byDay:{}, currentDay:1, baseDate:null};
    if(replace) itineraries[city].byDay = {};
    rows.forEach(r=>{
      const d = Math.max(1, parseInt(r.day||1,10));
      if(!itineraries[city].byDay[d]) itineraries[city].byDay[d] = [];
      const row = {
        day:d,
        start:r.start||'', end:r.end||'', activity:r.activity||'',
        from:r.from||'', to:r.to||'', transport:r.transport||'',
        duration:r.duration||'', notes:r.notes||''
      };
      dedupeInto(itineraries[city].byDay[d], row);
    });
    ensureDays(city);
  }

  function upsertCityMeta(meta){
    const name = meta.city || activeCity || savedDestinations[metaProgressIndex]?.city || savedDestinations[0]?.city;
    if(!name) return;
    if(!cityMeta[name]) cityMeta[name] = { baseDate:null, start:null, end:null, hotel:'' };
    if(meta.baseDate) cityMeta[name].baseDate = meta.baseDate;
    if(meta.start)    cityMeta[name].start    = meta.start;
    if(meta.end)      cityMeta[name].end      = meta.end;
    if(typeof meta.hotel === 'string') cityMeta[name].hotel = meta.hotel;
    if(itineraries[name] && meta.baseDate){ itineraries[name].baseDate = meta.baseDate; }
  }

  function applyParsedToState(parsed, forceReplaceAll=false){
    const rootReplace = Boolean(parsed.replace) || forceReplaceAll;

    if(parsed.meta && parsed.meta.city){ upsertCityMeta(parsed.meta); }

    if(Array.isArray(parsed.destinations)){
      parsed.destinations.forEach(d=>{
        if(d.meta && d.meta.city) upsertCityMeta(d.meta);
        const name = d.name || d.meta?.city || activeCity || savedDestinations[0]?.city || 'General';
        const destReplace = rootReplace || Boolean(d.replace);
        pushRows(name, d.rows||[], destReplace);
      });
      return;
    }
    if(parsed.destination && Array.isArray(parsed.rows)){
      const name = parsed.destination || activeCity || savedDestinations[0]?.city || 'General';
      pushRows(name, parsed.rows, rootReplace);
      return;
    }
    if(Array.isArray(parsed.rows)){
      const fallback = activeCity || savedDestinations[0]?.city || 'General';
      pushRows(fallback, parsed.rows, rootReplace);
    }
  }

// ===== SECCIÓN 13: Utilidades de edición (parsers) =====
/* ============ Utilidades edición dinámica ============ */
function normalize(t){
  return t.toLowerCase()
    .replaceAll('á','a').replaceAll('é','e').replaceAll('í','i')
    .replaceAll('ó','o').replaceAll('ú','u');
}

function extractInt(str){
  const m = str.match(/\b(\d{1,2})\b/);
  if(m) return Math.max(1, parseInt(m[1],10));
  if(/\bun\b|\buno\b|\buna\b/.test(str)) return 1;
  return 1;
}

function parseTimesFromText(text){
  const times = [];
  let tnorm = text.toLowerCase()
    .replace(/\s+de\s+la\s+manana/g,'am')
    .replace(/\s+de\s+la\s+tarde/g,'pm')
    .replace(/\s+de\s+la\s+noche/g,'pm')
    .replace(/\s*y\s+media/g,':30')
    .replace(/\s*y\s+cuarto/g,':15')
    .replace(/\s*y\s+45/g,':45')
    .replace(/(\d)\shoras?/g,'$1h')
    .replace(/(\d)\s*h/g,'$1h')
    .replace(/(\d{3,4})\s*(am|pm)?/g,(_,num,ap)=>{
      if(num.length===3) return num[0]+':'+num.slice(1)+(ap||'');
      if(num.length===4) return num.slice(0,2)+':'+num.slice(2)+(ap||'');
      return _;
    });

  const re = /(\b\d{1,2}(:\d{2})?\s*(am|pm|h)?\b)/gi;
  let m;
  while((m=re.exec(tnorm))!==null){
    let t = m[1].trim().toLowerCase();
    let ampm = /(am|pm)$/.exec(t)?.[1];
    t = t.replace(/(am|pm|h)$/,'');
    if(!t.includes(':')) t = t+':00';
    let [h,mi] = t.split(':').map(x=>parseInt(x,10));
    if(ampm==='pm' && h<12) h+=12;
    if(ampm==='am' && h===12) h=0;
    const HH = String(Math.max(0,Math.min(23,h))).padStart(2,'0');
    const MM = String(Math.max(0,Math.min(59,mi||0))).padStart(2,'0');
    times.push(`${HH}:${MM}`);
  }
  return times;
}

function updateSavedDays(city, newDays){
  const idx = savedDestinations.findIndex(x=>x.city===city);
  if(idx>=0){
    savedDestinations[idx] = {...savedDestinations[idx], days: Math.max(1, newDays)};
  }
}

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

// ===== SECCIÓN 15: UX guard =====
/* ============ UX guard ============ */
$start.addEventListener('click', (e)=>{
  if(savedDestinations.length===0){
    e.preventDefault();
    alert('Please add cities & days and press "Save Destinations" first.');
  }
}, {capture:true});

}); // 👈 cierre del document.addEventListener('DOMContentLoaded', ...)
})(); // 👈 cierre del wrapper IIFE

