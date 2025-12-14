/* =========================================================
   ITRAVELBYMYOWN · PLANNER v77 · SECCIONES 1–7 (patch)
   Objetivo: restaurar inserción de la PRIMERA FILA y
   preservar compatibilidad con Sec. 16–21 (contratos).
   — No hay listeners globales aquí que dupliquen los de la Sec.21 —
========================================================= */

/* ==============================
   SECCIÓN 1 · Helpers / Estado
   (compatibles con Sec.16–21)
================================= */
const qs  = (s, r=document)=>r.querySelector(s);
const qsa = (s, r=document)=>Array.from(r.querySelectorAll(s));

/* Estado global mínimo esperado por 16–21 */
window.savedDestinations   = Array.isArray(window.savedDestinations) ? window.savedDestinations : [];
window.itineraries         = window.itineraries || {};
window.cityMeta            = window.cityMeta || {};
window.plannerState        = window.plannerState || {};
window.session             = window.session || [];
window.hasSavedOnce        = !!window.hasSavedOnce;
window.planningStarted     = !!window.planningStarted;
window.collectingHotels    = !!window.collectingHotels;
window.metaProgressIndex   = Number.isFinite(window.metaProgressIndex) ? window.metaProgressIndex : 0;
window.activeCity          = window.activeCity || null;
window.isItineraryLocked   = !!window.isItineraryLocked;

/* Defaults horarios esperados por validaciones posteriores */
const DEFAULT_START = window.DEFAULT_START || '08:30';
const DEFAULT_END   = window.DEFAULT_END   || '19:00';

/* Utilidades de tiempo usadas por varias secciones */
function toMin(hhmm){
  const m = String(hhmm||'').match(/^(\d{1,2}):(\d{2})$/);
  if(!m) return null;
  const h = Math.min(23, Math.max(0, parseInt(m[1],10)));
  const mi= Math.min(59, Math.max(0, parseInt(m[2],10)));
  return h*60+mi;
}
function toHHMM(mins){
  let m = Math.round(Math.max(0, Number(mins)||0));
  m = m % (24*60);
  const h = Math.floor(m/60);
  const mm= m % 60;
  return `${String(h).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
}
function addMinutes(hhmm, add){
  const base = toMin(hhmm);
  if(base==null) return hhmm||DEFAULT_START;
  return toHHMM(base + (Number(add)||0));
}

/* Fechas: DD/MM/AAAA ↔ Date (usado en Sec.21) */
function parseDMY(str){
  const m = String(str||'').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if(!m) return null;
  const d = parseInt(m[1],10), mo = parseInt(m[2],10)-1, y = parseInt(m[3],10);
  const dt = new Date(y, mo, d);
  return (dt && dt.getFullYear()===y && dt.getMonth()===mo && dt.getDate()===d) ? dt : null;
}
function fmtDMY(dt){
  const d = String(dt.getDate()).padStart(2,'0');
  const m = String(dt.getMonth()+1).padStart(2,'0');
  const y = dt.getFullYear();
  return `${d}/${m}/${y}`;
}

/* Pequeño sistema de tonos (usado por Sec.16 en mensajes de arranque) */
const tone = window.tone || {
  hi:      '¡Listo! Empecemos con tus destinos ✨',
  infoTip: 'Tip: Puedes preguntarme dudas en el Info Chat mientras planificamos.',
  askHotelTransport: (city)=>`¿Cuál será tu hotel/zona en <strong>${city}</strong> y qué transporte prefieres (alquiler, público, taxi/uber o recomiéndame)?`,
  confirmAll: 'Perfecto, ya tengo hoteles/zonas y transporte. Generaré tus itinerarios…',
  doneAll: '¡Hecho! Ya puedes revisar y ajustar tus itinerarios.'
};

/* ==============================
   SECCIÓN 2 · Referencias DOM (sin listeners)
   — No dispara nada por sí sola; Sec.21 se encarga de listeners —
================================= */
let $cityList, $addCity, $save, $start, $tabs, $itWrap;
let $chatBox, $chatM, $chatI, $send;
let $confirmCTA, $upsellClose, $sidebar, $infoFloating, $resetBtn, $overlayWOW;

function __wireBaseRefs__(){
  $cityList     = qs('#city-list');
  $addCity      = qs('#add-city');
  $save         = qs('#save-destinations');
  $start        = qs('#start-planning');
  $tabs         = qs('#city-tabs');
  $itWrap       = qs('#itinerary-wrap');

  $chatBox      = qs('#chat-box');
  $chatM        = qs('#chat-messages');
  $chatI        = qs('#chat-input');
  $send         = qs('#chat-send');

  $confirmCTA   = qs('#confirm-cta');
  $upsellClose  = qs('#upsell-close');
  $sidebar      = qs('#sidebar');
  $infoFloating = qs('#info-chat-floating');
  $resetBtn     = qs('#reset-planner');
  $overlayWOW   = qs('#overlay-wow');
}

/* Ejecuta el cableado en cuanto exista el DOM, sin registrar listeners extra */
if (document.readyState !== 'loading') __wireBaseRefs__();
else document.addEventListener('DOMContentLoaded', __wireBaseRefs__);

/* ==============================
   SECCIÓN 3 · Plantilla de fila + addCityRow (contrato clave)
   — Garantiza que SIEMPRE se inserta una .city-row en #city-list —
================================= */
function __buildCityRow(pref={}){
  const row = document.createElement('div');
  row.className = 'city-row';
  row.innerHTML = `
    <input class="city"      type="text"  placeholder="Ciudad" />
    <input class="country"   type="text"  placeholder="País" />
    <input class="baseDate"  type="text"  placeholder="DD/MM/AAAA" />
    <input class="days"      type="number" min="1" step="1" placeholder="Días" />
    <button type="button" class="remove btn ghost" aria-label="Eliminar ciudad">✕</button>
  `;
  // Prefill no bloqueante
  if(pref.city)     row.querySelector('.city').value     = pref.city;
  if(pref.country)  row.querySelector('.country').value  = pref.country;
  if(pref.baseDate) row.querySelector('.baseDate').value = pref.baseDate;
  if(pref.days)     row.querySelector('.days').value     = String(pref.days);

  // ⚠️ No añadimos listeners aquí: Sec.21 gobierna habilitación y guardado.
  // Solo damos remove local para UX básica (no interfiere con Sec.21).
  const $rm = qs('.remove', row);
  $rm?.addEventListener('click', ()=>{
    row.remove();
  });

  return row;
}

/**
 * addCityRow(pref?)
 * CONTRATO con Sec.21: debe existir global y aceptar cero params.
 * No debe hacer early-return. Debe APPEND una .city-row válida en #city-list.
 * Debe retornar la fila creada para usos internos.
 */
function addCityRow(pref={}){
  if(!$cityList) __wireBaseRefs__();
  if(!$cityList) throw new Error('No existe #city-list en el DOM.');

  const row = __buildCityRow(pref);
  $cityList.appendChild(row);
  return row;
}

/* ==============================
   SECCIÓN 4 · Persistencia base + tabs/itinerary (stubs seguros)
   — Mantiene contratos mínimos usados en 16–21
================================= */
function __ensureCityScaffold(city){
  if(!itineraries[city]) itineraries[city] = { byDay:{}, baseDate: (cityMeta[city]?.baseDate||'') };
  if(!cityMeta[city])    cityMeta[city]    = { baseDate:'', hotel:'', transport:'', perDay:[] };
}

function saveDestinations(){
  if(!$cityList) __wireBaseRefs__();
  const rows = qsa('.city-row', $cityList);
  const out = [];
  rows.forEach(r=>{
    const city  = (qs('.city', r)?.value||'').trim();
    const country = (qs('.country', r)?.value||'').trim();
    const days = parseInt((qs('.days', r)?.value||'0'), 10) || 0;
    const base = (qs('.baseDate', r)?.value||'').trim();
    if(city){ out.push({ city, country, days, baseDate: base }); __ensureCityScaffold(city); }
  });
  window.savedDestinations = out;

  // Sincroniza plannerState (no rompe lógicas posteriores)
  if(!plannerState) window.plannerState = {};
  plannerState.destinations = out.map(d=>({ city:d.city, country:d.country, baseDate:d.baseDate, days:d.days }));
  return out;
}

/* Tabs básicos (usados por Sec.19/21 indirectamente) */
function renderCityTabs(){
  if(!$tabs) __wireBaseRefs__();
  if(!$tabs) return;
  $tabs.innerHTML = '';
  savedDestinations.forEach(({city}, idx)=>{
    const b = document.createElement('button');
    b.className = 'tab';
    b.textContent = city || `Ciudad ${idx+1}`;
    b.addEventListener('click', ()=>{
      setActiveCity(city);
      renderCityItinerary(city);
    });
    $tabs.appendChild(b);
  });
}
function setActiveCity(city){
  window.activeCity = city || null;
  // marcador visual mínimo (no interfiere con estilos existentes)
  qsa('#city-tabs .tab').forEach(t=>{
    if(t.textContent === city) t.classList.add('active'); else t.classList.remove('active');
  });
}
function renderCityItinerary(city){
  if(!$itWrap) __wireBaseRefs__();
  if(!$itWrap) return;
  const data = itineraries[city] || { byDay:{} };
  const byDay = data.byDay || {};
  const wrap = document.createElement('div');
  wrap.className = 'it-city';
  wrap.innerHTML = '';
  const days = Object.keys(byDay).map(n=>+n).sort((a,b)=>a-b);
  if(!days.length){
    wrap.innerHTML = `<div class="it-empty">Aún no hay actividades para <strong>${city}</strong>.</div>`;
  }else{
    days.forEach(d=>{
      const group = document.createElement('div');
      group.className = 'it-day';
      group.innerHTML = `<h4>Día ${d}</h4>`;
      const list = document.createElement('ul');
      (byDay[d]||[]).forEach(r=>{
        const li = document.createElement('li');
        li.textContent = `${r.start||''}-${r.end||''} ${r.activity||''}`;
        list.appendChild(li);
      });
      group.appendChild(list);
      wrap.appendChild(group);
    });
  }
  $itWrap.innerHTML = '';
  $itWrap.appendChild(wrap);
}

/* ==============================
   SECCIÓN 5 · Chat base (no invasivo)
   — chatMsg y helpers mínimos que Sec.16/19 esperan
================================= */
function chatMsg(html, who='ai'){
  if(!$chatM) __wireBaseRefs__();
  if(!$chatM) return;
  const b = document.createElement('div');
  b.className = `bubble ${who==='user'?'user':'ai'}`;
  b.innerHTML = html;
  $chatM.appendChild(b);
  $chatM.scrollTop = $chatM.scrollHeight;
}
function setChatBusy(on){
  if(!$chatBox) __wireBaseRefs__();
  try{ $chatBox?.classList?.toggle('busy', !!on); }catch(_){}
}

/* ==============================
   SECCIÓN 6 · Meta helpers (contratos usados por 16–21)
   — Implementaciones seguras/no destructivas
================================= */
function upsertCityMeta({city, hotel, transport, baseDate}={}){
  if(!city) return;
  cityMeta[city] = cityMeta[city] || { baseDate:'', hotel:'', transport:'', perDay:[] };
  if(typeof hotel==='string')     cityMeta[city].hotel = hotel;
  if(typeof transport==='string') cityMeta[city].transport = transport;
  if(typeof baseDate==='string')  cityMeta[city].baseDate = baseDate;
}

function ensureDays(city){
  __ensureCityScaffold(city);
  const current = itineraries[city].byDay || {};
  const conf = savedDestinations.find(d=>d.city===city);
  const want = Math.max(1, parseInt(conf?.days||'1',10));
  for(let d=1; d<=want; d++){
    if(!current[d]) current[d] = [];
  }
  itineraries[city].byDay = current;
}

function pushRows(city, rows=[], replace=false){
  __ensureCityScaffold(city);
  const byDay = itineraries[city].byDay;
  if(replace){
    const grouped = {};
    rows.forEach(r=>{
      const d = Number(r.day)||1;
      (grouped[d]=grouped[d]||[]).push(r);
    });
    Object.keys(grouped).forEach(k=> byDay[k]=grouped[k]);
  }else{
    rows.forEach(r=>{
      const d = Number(r.day)||1;
      (byDay[d]=byDay[d]||[]).push(r);
    });
  }
}

function insertDayAt(city, pos){
  __ensureCityScaffold(city);
  const byDay = itineraries[city].byDay;
  const keys = Object.keys(byDay).map(n=>+n).sort((a,b)=>b-a);
  keys.forEach(d=>{
    if(d>=pos) byDay[d+1] = (byDay[d]||[]).map(x=>({...x, day:d+1}));
  });
  byDay[pos] = byDay[pos] || [];
}

function addMultipleDaysToCity(city, extra=1){
  __ensureCityScaffold(city);
  const byDay = itineraries[city].byDay;
  const total = Object.keys(byDay).map(n=>+n).reduce((m,v)=>Math.max(m,v),0) || 0;
  for(let i=1;i<=extra;i++){
    byDay[total+i] = byDay[total+i] || [];
  }
}

function removeDayAt(city, day){
  __ensureCityScaffold(city);
  const byDay = itineraries[city].byDay;
  delete byDay[day];
  const keys = Object.keys(byDay).map(n=>+n).sort((a,b)=>a-b);
  let idx=1;
  const out = {};
  keys.forEach(d=>{
    out[idx] = (byDay[d]||[]).map(x=>({...x, day:idx}));
    idx++;
  });
  itineraries[city].byDay = out;
}

function swapDays(city, a, b){
  __ensureCityScaffold(city);
  const byDay = itineraries[city].byDay;
  const A = byDay[a]||[]; const B = byDay[b]||[];
  byDay[a] = (B||[]).map(x=>({...x, day:a}));
  byDay[b] = (A||[]).map(x=>({...x, day:b}));
}

function moveActivities(city, fromDay, toDay, query=''){
  __ensureCityScaffold(city);
  const byDay = itineraries[city].byDay;
  const src = byDay[fromDay]||[];
  const dst = byDay[toDay]  ||[];
  const keep=[], move=[];
  if(query){
    const q = query.toLowerCase();
    src.forEach(r => (String(r.activity||'').toLowerCase().includes(q) ? move : keep).push(r));
  }else{
    move.push(...src);
  }
  byDay[fromDay] = keep.map(x=>({...x, day:fromDay}));
  byDay[toDay]   = [...dst, ...move.map(x=>({...x, day:toDay}))];
}

async function rebalanceWholeCity(city, opts={}){
  // Stub no destructivo; Sec.18/19 llaman optimizeDay internamente
  if(!city) return;
  ensureDays(city);
  // Señaliza a otros módulos si lo necesitan
  try { document.dispatchEvent(new CustomEvent('itbmo:rebalanceCity',{detail:{city, opts}})); } catch(_){}
}

async function generateCityItinerary(city){
  // Stub simple: asegura estructura; Sec.16 luego llama optimizeDay/agent
  ensureDays(city);
  const byDay = itineraries[city].byDay || {};
  Object.keys(byDay).forEach(d=>{
    if(!(byDay[d]&&byDay[d].length)){
      byDay[d] = [{
        day: Number(d),
        start: DEFAULT_START,
        end: addMinutes(DEFAULT_START, 90),
        activity: 'Bienvenida y orientación',
        from: `Hotel (${city})`,
        to: 'Centro',
        transport: 'A pie',
        duration: '1h30m',
        notes: 'Ajuste suave de llegada.'
      }];
    }
  });
}

async function runWithConcurrency(tasks=[], limit=2){
  const queue = tasks.slice();
  const runners = new Array(Math.max(1, limit)).fill(0).map(async ()=>{
    while(queue.length){
      const fn = queue.shift();
      try{ await fn(); }catch(e){ console.error('task error', e); }
    }
  });
  await Promise.all(runners);
}

/* ==============================
   SECCIÓN 7 · Salvaguardas y Shims (completa, sin resumir)
   Objetivo:
   - Proveer utilidades y "fallbacks" condicionales para no romper
     implementaciones reales definidas en otras secciones.
   - Cero efectos colaterales de arranque (no listeners, no timers).
   - Mantener compatibilidad con Sec.16–21 (p. ej. showWOW).
================================= */

/* ─────────────────────────────────────────────────────────────
   [7.1] Flags de seguridad en el espacio global
   - No hacen nada por sí solos; sirven para diagnosticar
     y evitar dobles definiciones accidentales.
───────────────────────────────────────────────────────────── */
window.__ITBMO_CORE_FLAGS__ = window.__ITBMO_CORE_FLAGS__ || {
  hasWireBaseRefs: false,
  hasOverlayWOW: false,
  hasChatFallbacks: false,
  hasDataGuards: false,
  hasTextUtils: false,
  hasEventUtils: false,
  hasArrayObjectUtils: false
};

/* ─────────────────────────────────────────────────────────────
   [7.2] WOW Overlay — Fallback no intrusivo
   - Sec.16/18/19/21 llaman showWOW(true|false, msg?)
   - Aquí damos un shim minimalista que NO interfiere si ya existe
   - Si hay #overlay-wow, lo usa. Si no, crea uno temporal in-page.
───────────────────────────────────────────────────────────── */
if (typeof window.showWOW !== 'function') {
  window.showWOW = function showWOW(on, msg) {
    let $ov = document.getElementById('overlay-wow');
    if (!$ov) {
      $ov = document.createElement('div');
      $ov.id = 'overlay-wow';
      $ov.style.position = 'fixed';
      $ov.style.inset = '0';
      $ov.style.display = 'none';
      $ov.style.background = 'rgba(10,10,20,0.45)';
      $ov.style.backdropFilter = 'blur(2px)';
      $ov.style.zIndex = '9999';
      $ov.style.alignItems = 'center';
      $ov.style.justifyContent = 'center';
      $ov.style.padding = '24px';

      const inner = document.createElement('div');
      inner.id = 'overlay-wow-inner';
      inner.style.minWidth = '260px';
      inner.style.maxWidth = '720px';
      inner.style.background = '#0c0f14';
      inner.style.color = '#fff';
      inner.style.borderRadius = '14px';
      inner.style.boxShadow = '0 10px 30px rgba(0,0,0,.35)';
      inner.style.padding = '18px 20px';
      inner.style.textAlign = 'center';
      inner.style.fontSize = '16px';
      inner.style.lineHeight = '1.4';

      const spinner = document.createElement('div');
      spinner.className = 'overlay-wow-spinner';
      spinner.style.width = '28px';
      spinner.style.height = '28px';
      spinner.style.border = '3px solid rgba(255,255,255,0.3)';
      spinner.style.borderTopColor = '#fff';
      spinner.style.borderRadius = '50%';
      spinner.style.margin = '0 auto 10px';
      spinner.style.animation = 'itbmo-rot 1s linear infinite';

      const label = document.createElement('div');
      label.id = 'overlay-wow-label';
      label.textContent = 'Procesando…';

      inner.appendChild(spinner);
      inner.appendChild(label);
      $ov.appendChild(inner);
      document.body.appendChild($ov);

      // Animación mínima (no dependemos de CSS global)
      const style = document.createElement('style');
      style.textContent = `
        @keyframes itbmo-rot { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `;
      document.head.appendChild(style);
    }

    const label = $ov.querySelector('#overlay-wow-label');
    if (typeof msg === 'string' && label) label.textContent = msg;

    $ov.style.display = on ? 'flex' : 'none';

    // Señalización para diagnósticos
    try {
      window.__ITBMO_CORE_FLAGS__.hasOverlayWOW = true;
      document.dispatchEvent(new CustomEvent('itbmo:wow', { detail: { on: !!on, msg: msg || '' } }));
    } catch (_) {}
  };
}

/* ─────────────────────────────────────────────────────────────
   [7.3] Chat fallbacks — infoChatMsg (sólo si no existe)
   - Algunas vistas externas usan infoChatMsg además de chatMsg
   - Aquí proveemos uno mínimo para no romper integraciones.
───────────────────────────────────────────────────────────── */
if (typeof window.infoChatMsg !== 'function') {
  window.infoChatMsg = function infoChatMsg(html, who = 'ai') {
    const box = document.getElementById('info-chat-messages') ||
                document.querySelector('#info-chat-modal .messages') ||
                document.getElementById('info-chat-body');
    if (!box) return;
    const b = document.createElement('div');
    b.className = `bubble ${who === 'user' ? 'user' : 'ai'}`;
    b.innerHTML = html;
    box.appendChild(b);
    box.scrollTop = box.scrollHeight;

    try { window.__ITBMO_CORE_FLAGS__.hasChatFallbacks = true; } catch (_) {}
  };
}

/* ─────────────────────────────────────────────────────────────
   [7.4] Utilidades de texto/HTML
   - escapeHTML / stripTags / normalizeSpaces
   - getSafeString (úsala antes de concatenar)
───────────────────────────────────────────────────────────── */
if (!window.__ITBMO_CORE_FLAGS__.hasTextUtils) {
  function escapeHTML(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function stripTags(str) {
    const tmp = document.createElement('div');
    tmp.innerHTML = String(str ?? '');
    return tmp.textContent || tmp.innerText || '';
  }

  function normalizeSpaces(str) {
    return String(str ?? '').replace(/\s+/g, ' ').trim();
  }

  function getSafeString(v, def = '') {
    const s = (v === null || v === undefined) ? '' : String(v);
    return s.length ? s : def;
  }

  window.escapeHTML = window.escapeHTML || escapeHTML;
  window.stripTags = window.stripTags || stripTags;
  window.normalizeSpaces = window.normalizeSpaces || normalizeSpaces;
  window.getSafeString = window.getSafeString || getSafeString;
  window.__ITBMO_CORE_FLAGS__.hasTextUtils = true;
}

/* ─────────────────────────────────────────────────────────────
   [7.5] Utilidades de arrays/objetos (livianas y puras)
   - deepClone, shallowEqual, uniqBy, groupBy, clamp
   - NO shadowean librerías; son helpers pequeños.
───────────────────────────────────────────────────────────── */
if (!window.__ITBMO_CORE_FLAGS__.hasArrayObjectUtils) {
  function deepClone(obj) {
    try { return structuredClone(obj); } catch (_) {}
    return JSON.parse(JSON.stringify(obj || null));
  }

  function shallowEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) { if (a[k] !== b[k]) return false; }
    return true;
  }

  function uniqBy(arr, keyFn) {
    const out = [], seen = new Set();
    for (const it of (arr || [])) {
      const k = keyFn ? keyFn(it) : it;
      if (!seen.has(k)) { seen.add(k); out.push(it); }
    }
    return out;
  }

  function groupBy(arr, keyFn) {
    const map = {};
    for (const it of (arr || [])) {
      const k = keyFn(it);
      (map[k] = map[k] || []).push(it);
    }
    return map;
  }

  function clamp(n, min, max) {
    n = Number(n); min = Number(min); max = Number(max);
    if (Number.isNaN(n)) n = min;
    return Math.min(max, Math.max(min, n));
  }

  window.deepClone     = window.deepClone     || deepClone;
  window.shallowEqual  = window.shallowEqual  || shallowEqual;
  window.uniqBy        = window.uniqBy        || uniqBy;
  window.groupBy       = window.groupBy       || groupBy;
  window.clamp         = window.clamp         || clamp;

  window.__ITBMO_CORE_FLAGS__.hasArrayObjectUtils = true;
}

/* ─────────────────────────────────────────────────────────────
   [7.6] Data guards (coherencia de estructuras esperadas)
   - Aseguran que estructuras mínimas existan cuando se pidan
   - No reemplazan ni reescriben si ya existen.
───────────────────────────────────────────────────────────── */
if (!window.__ITBMO_CORE_FLAGS__.hasDataGuards) {
  function ensurePlannerState() {
    if (!window.plannerState || typeof window.plannerState !== 'object') {
      window.plannerState = {};
    }
    window.plannerState.destinations = Array.isArray(window.plannerState.destinations)
      ? window.plannerState.destinations
      : [];
    window.plannerState.preferences = window.plannerState.preferences || {};
    window.plannerState.forceReplan = window.plannerState.forceReplan || {};
    window.plannerState.existingActs = window.plannerState.existingActs || {};
    window.plannerState.dayTripPending = window.plannerState.dayTripPending || {};
    return window.plannerState;
  }

  function ensureItinerary(city) {
    if (!city) return null;
    window.itineraries = window.itineraries || {};
    if (!window.itineraries[city]) window.itineraries[city] = { byDay: {}, baseDate: '' };
    const it = window.itineraries[city];
    if (!it.byDay || typeof it.byDay !== 'object') it.byDay = {};
    if (typeof it.baseDate !== 'string') it.baseDate = '';
    return it;
  }

  function ensureCityMeta(city) {
    if (!city) return null;
    window.cityMeta = window.cityMeta || {};
    if (!window.cityMeta[city]) window.cityMeta[city] = { baseDate: '', hotel: '', transport: '', perDay: [] };
    const cm = window.cityMeta[city];
    if (!Array.isArray(cm.perDay)) cm.perDay = [];
    return cm;
  }

  window.ensurePlannerState = window.ensurePlannerState || ensurePlannerState;
  window.ensureItinerary    = window.ensureItinerary    || ensureItinerary;
  window.ensureCityMeta     = window.ensureCityMeta     || ensureCityMeta;

  window.__ITBMO_CORE_FLAGS__.hasDataGuards = true;
}

/* ─────────────────────────────────────────────────────────────
   [7.7] Eventos utilitarios (emit / on / off) — minimalistas
   - No colisionan con EventTarget; son helpers azucarados.
───────────────────────────────────────────────────────────── */
if (!window.__ITBMO_CORE_FLAGS__.hasEventUtils) {
  function onEvent(name, handler, opts) {
    try { document.addEventListener(name, handler, opts || false); } catch (_) {}
  }
  function offEvent(name, handler, opts) {
    try { document.removeEventListener(name, handler, opts || false); } catch (_) {}
  }
  function emitEvent(name, detail) {
    try { document.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {}
  }

  window.onEvent   = window.onEvent   || onEvent;
  window.offEvent  = window.offEvent  || offEvent;
  window.emitEvent = window.emitEvent || emitEvent;

  window.__ITBMO_CORE_FLAGS__.hasEventUtils = true;
}

/* ─────────────────────────────────────────────────────────────
   [7.8] Fallbacks de integración con Sec.18 (opcionales)
   - En la Sec.18 puede existir enforceTransportAndOutOfTown.
   - Aquí proveemos una versión conservadora si no existe.
   - No toca nombres/contratos si ya está definida.
───────────────────────────────────────────────────────────── */
if (typeof window.enforceTransportAndOutOfTown !== 'function') {
  window.enforceTransportAndOutOfTown = function enforceTransportAndOutOfTown(city, rows) {
    const out = [];
    const cityLow = String(city || '').toLowerCase();

    const looksOut = (r) => {
      const a = String(r?.activity || '').toLowerCase();
      const f = String(r?.from || '').toLowerCase();
      const t = String(r?.to || '').toLowerCase();
      const hints = /excursi[oó]n|pen[ií]nsula|costa|glaciar|c[ií]rculo|parque|volc[aá]n|lago|cascada/;
      const notCity = (s) => s && cityLow && !s.includes(cityLow);
      return hints.test(a) || notCity(f) || notCity(t);
    };

    for (const r of (rows || [])) {
      let transport = r.transport || '';
      if (!transport || /^\s*$/.test(transport)) {
        if (looksOut(r)) transport = 'Vehículo alquilado o Tour guiado';
        else transport = /hotel|alojamiento/i.test(String(r?.to || '')) ? 'A pie' : 'A pie';
      }
      out.push({ ...r, transport });
    }
    return out;
  };
}

/* ─────────────────────────────────────────────────────────────
   [7.9] No-ops seguros para contratos invocados condicionalmente
   - Se definen SOLO si no existen.
   - No hacen nada salvo evitar errores de referencia.
───────────────────────────────────────────────────────────── */
if (typeof window.callAgent !== 'function') {
  window.callAgent = async function(){ return '{"rows":[]}'; };
}
if (typeof window.parseJSON !== 'function') {
  window.parseJSON = function(s){ try{ return JSON.parse(String(s||'')); }catch(_){ return null; } };
}
if (typeof window.callInfoAgent !== 'function') {
  window.callInfoAgent = async function(txt){ return { text: 'He obtenido datos. Pregúntame algo concreto.' }; };
}
if (typeof window.normalizeRow !== 'function') {
  window.normalizeRow = function(r){ return r || {}; };
}
if (typeof window.buildIntakeLite !== 'function') {
  window.buildIntakeLite = function(city){ return `Destino: ${city}`; };
}

/* ─────────────────────────────────────────────────────────────
   [7.10] Exposición de utilidades en el namespace global (si no existen)
   - Evita redefinir nombres ya presentes para no romper nada.
───────────────────────────────────────────────────────────── */
(function exposeGlobalsSafely(){
  // Ya se hizo en cada bloque `if`, pero dejamos esta IIFE como
  // punto único para futuras extensiones sin colisiones.
})();

/* ==============================
   SECCIÓN 8 · Tabs + Render
   (ajustada quirúrgicamente p/ coherencia con 9–21, accesibilidad y eventos)
================================= */
function setActiveCity(name){
  if(!name) return;
  activeCity = name;

  // Actualiza estado visual + ARIA
  qsa('.city-tab', $tabs).forEach(b=>{
    const isActive = (b.dataset.city === name);
    b.classList.toggle('active', isActive);
    b.setAttribute('aria-selected', isActive ? 'true' : 'false');
    b.tabIndex = isActive ? 0 : -1;
  });
}

function __renderCityTabButton__(city, isActive){
  const b = document.createElement('button');
  b.className = 'city-tab' + (isActive ? ' active' : '');
  b.textContent = city;
  b.dataset.city = city;
  b.setAttribute('role','tab');
  b.setAttribute('aria-selected', isActive ? 'true' : 'false');
  b.tabIndex = isActive ? 0 : -1;

  // Click → activar pestaña
  b.addEventListener('click', ()=>{
    setActiveCity(city);
    renderCityItinerary(city);
  });

  // Navegación con teclado (← → Home End)
  b.addEventListener('keydown', (e)=>{
    const tabs = qsa('.city-tab', $tabs);
    const idx = tabs.findIndex(x => x === b);
    if(idx === -1) return;

    let target = null;
    if(e.key === 'ArrowRight') target = tabs[(idx+1) % tabs.length];
    else if(e.key === 'ArrowLeft') target = tabs[(idx-1+tabs.length) % tabs.length];
    else if(e.key === 'Home') target = tabs[0];
    else if(e.key === 'End') target = tabs[tabs.length - 1];

    if(target){
      e.preventDefault();
      target.focus();
      const cityTarget = target.dataset.city;
      setActiveCity(cityTarget);
      renderCityItinerary(cityTarget);
    }
  });

  return b;
}

function renderCityTabs(){
  const prev = activeCity;

  // Contenedor con roles ARIA
  $tabs.setAttribute('role','tablist');
  $tabs.setAttribute('aria-label','Ciudades del viaje');

  // Limpieza segura (evita handlers duplicados)
  $tabs.innerHTML = '';

  // Construcción de tabs a partir de destinos guardados
  savedDestinations.forEach(({city})=>{
    const isActive = (city === prev);
    const btn = __renderCityTabButton__(city, isActive);
    $tabs.appendChild(btn);
  });

  if(savedDestinations.length){
    const valid = prev && savedDestinations.some(x=>x.city===prev) ? prev : savedDestinations[0].city;
    setActiveCity(valid);
    renderCityItinerary(valid);
  }else{
    activeCity = null;
    $itWrap.innerHTML = '';
  }
}

/* 🔄 Re-render de tabs cuando se guardan destinos o se resetea el planner */
document.addEventListener('itbmo:destinationsSaved', ()=>{
  try { renderCityTabs(); } catch(_) {}
});
document.addEventListener('itbmo:plannerReset', ()=>{
  try { renderCityTabs(); } catch(_) {}
});

/* ==============================
   SECCIÓN 9 · Render Itinerario
   (ajustada quirúrgicamente p/ coherencia con 10–17 y API INFO→PLANNER)
================================= */
function renderCityItinerary(city){
  if(!city || !itineraries[city]) return;
  const data = itineraries[city];
  const days = Object.keys(data.byDay||{}).map(n=>+n).sort((a,b)=>a-b);

  $itWrap.innerHTML = '';
  if(!days.length){
    $itWrap.innerHTML = '<p>No hay actividades aún. El asistente las generará aquí.</p>';
    return;
  }

  const base = parseDMY(data.baseDate || cityMeta[city]?.baseDate || '');
  const sections = [];

  // 🔎 Utilidades de display (compatibles con normalizaciones de 13–15)
  function isAuroraActivity(txt){
    return /\b(aurora|northern\s+lights?)\b/i.test(String(txt||''));
  }
  function splitValidBadge(notesRaw){
    const notes = String(notesRaw||'');
    const m = notes.match(/valid:\s*([^|]+)(?:\||$)/i);
    if(!m) return { clean: notes.replace(/^\s*valid:\s*/i, '').trim(), badge: null };
    const badge = `valid: ${m[1].trim()}`;
    const clean = notes.replace(m[0], '').replace(/^\s*valid:\s*/i, '').trim().replace(/\s*\|\s*$/,'');
    return { clean, badge };
  }
  function pad2(n){ return String(n).padStart(2,'0'); }
  function minutesToHhMmLabel(mins){
    const total = Math.max(0, Math.round(mins));
    const h = Math.floor(total/60);
    const m = total % 60;
    if(h && m) return `${h}h${pad2(m)}m`;
    if(h) return `${h}h`;
    return `${m}m`;
  }
  function formatDurationForDisplay(val){
    if(val == null) return '';
    const s = String(val).trim();

    // Mantén formatos ya normalizados por el pipeline (e.g., "1h30m", "3h")
    if (/^\d+h(?:[0-5]\d m?)?$/i.test(s) || /^\d+h$/i.test(s)) return s.replace(/\s+/g,''); // "1h30m", "3h"
    if (/^\d+m$/i.test(s)) {
      const mins = parseInt(s,10);
      return minutesToHhMmLabel(mins);
    }
    // Duraciones numéricas "90" → 1h30m
    if (/^\d+$/.test(s)) return minutesToHhMmLabel(parseInt(s,10));
    // Deja pasar otros (p.ej. "45m", "2h00m", "aprox. 1h")
    return s;
  }

  days.forEach(dayNum=>{
    const sec = document.createElement('div');
    sec.className = 'day-section';
    const dateLabel = base ? ` (${formatDMY(addDays(base, dayNum-1))})` : '';
    sec.innerHTML = `
      <div class="day-title"><strong>Día ${dayNum}</strong>${dateLabel}</div>
      <table class="itinerary">
        <thead>
          <tr>
            <th scope="col">Hora inicio</th><th scope="col">Hora final</th><th scope="col">Actividad</th><th scope="col">Desde</th>
            <th scope="col">Hacia</th><th scope="col">Transporte</th><th scope="col">Duración</th><th scope="col">Notas</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    `;
    const tb = qs('tbody', sec);

    (data.byDay[dayNum]||[]).forEach(r=>{
      // Limpiezas suaves de display (no tocan estado):
      const cleanActivity = String(r.activity||'').replace(/^rev:\s*/i, '').trim();

      const { clean: cleanNotes, badge } = splitValidBadge(r.notes||'');
      const tr = document.createElement('tr');

      // 🌌 Highlight visual mínimo para auroras (no intrusivo)
      if (isAuroraActivity(cleanActivity)) tr.classList.add('aurora-row');

      // Badge “valid:” cuando existe
      const notesCell = document.createElement('td');
      notesCell.innerHTML = cleanNotes || '';
      if (badge){
        const b = document.createElement('span');
        b.className = 'badge valid';
        b.textContent = badge;
        // pequeño separador si ya hay notas
        if (cleanNotes) notesCell.insertAdjacentText('afterbegin', '');
        notesCell.appendChild(document.createTextNode(cleanNotes ? ' ' : ''));
        notesCell.insertAdjacentElement('afterbegin', b);
      }

      tr.innerHTML = `
        <td>${r.start||''}</td>
        <td>${r.end||''}</td>
        <td>${cleanActivity}</td>
        <td>${r.from||''}</td>
        <td>${r.to||''}</td>
        <td>${r.transport||''}</td>
        <td>${formatDurationForDisplay(r.duration||'')}</td>
      `;
      tr.appendChild(notesCell);
      tb.appendChild(tr);
    });

    $itWrap.appendChild(sec);
    sections.push(sec);
  });

  // 🔀 Pager compacto
  const pager = document.createElement('div');
  pager.className = 'pager';
  const prev = document.createElement('button'); prev.textContent = '«';
  const next = document.createElement('button'); next.textContent = '»';
  pager.appendChild(prev);
  days.forEach(d=>{
    const b = document.createElement('button');
    b.textContent = d;
    b.dataset.day = d;
    pager.appendChild(b);
  });
  pager.appendChild(next);
  $itWrap.appendChild(pager);

  function show(n){
    sections.forEach((sec,i)=>sec.style.display = (days[i]===n?'block':'none'));
    qsa('button',pager).forEach(x=>x.classList.remove('active'));
    const btn = qsa('button',pager).find(x=>x.dataset.day==String(n));
    if(btn) btn.classList.add('active');
    prev.classList.toggle('ghost', n===days[0]);
    next.classList.toggle('ghost', n===days.at(-1));
    itineraries[city].currentDay = n;
  }
  pager.addEventListener('click', e=>{
    const t = e.target;
    if(t===prev)      show(Math.max(days[0], (itineraries[city].currentDay||days[0])-1));
    else if(t===next) show(Math.min(days.at(-1), (itineraries[city].currentDay||days[0])+1));
    else if(t.dataset.day) show(+t.dataset.day);
  });
  show(itineraries[city].currentDay || days[0]);
}

/* ==============================
   SECCIÓN 10 · Snapshot + Intake
   (ajustada p/ integración con 12, 13, 14, 15, 16, 17, 19–21)
================================= */

// Polyfill suave: garantiza getEffectivePerDay si aún no existe.
// Usa cityMeta → perDay → DEFAULTS (08:30–19:00)
if (typeof getEffectivePerDay !== 'function') {
  function getEffectivePerDay(city, totalDays = 0){
    const baseStart = (typeof DEFAULT_START === 'string' && DEFAULT_START) ? DEFAULT_START : '08:30';
    const baseEnd   = (typeof DEFAULT_END   === 'string' && DEFAULT_END)   ? DEFAULT_END   : '19:00';
    const metaPD = (typeof cityMeta !== 'undefined' && cityMeta?.[city]?.perDay) ? cityMeta[city].perDay : [];
    const byDay = (typeof itineraries !== 'undefined' && itineraries?.[city]?.byDay) ? itineraries[city].byDay : {};
    const want = totalDays || (byDay ? Object.keys(byDay).length : 0) || 1;
    const out = [];
    for (let d=1; d<=want; d++){
      const found = metaPD.find(p=>p.day===d) || {};
      out.push({
        day: d,
        start: found.start || baseStart,
        end:   found.end   || baseEnd
      });
    }
    return out;
  }
}

function getFrontendSnapshot(){
  // Evita caídas si estructuras aún no existen
  const it = (typeof itineraries !== 'undefined' && itineraries) ? itineraries : {};
  const meta = (typeof cityMeta !== 'undefined' && cityMeta) ? cityMeta : {};

  // Normaliza a objeto serializable y compacto (sin funciones ni refs circulares)
  const snapshot = Object.fromEntries(
    Object.entries(it).map(([city, data]) => {
      const baseDate = (data && data.baseDate) || meta[city]?.baseDate || null;
      const transport = meta[city]?.transport || '';
      const daysObj = (data && data.byDay) ? data.byDay : {};
      const days = Object.fromEntries(
        Object.entries(daysObj).map(([d, rows]) => [
          d,
          (Array.isArray(rows) ? rows : []).map(r => ({
            day: +d,
            start: r.start || '',
            end: r.end || '',
            activity: r.activity || '',
            from: r.from || '',
            to: r.to || '',
            transport: r.transport || '',
            duration: r.duration || '',
            notes: r.notes || ''
          }))
        ])
      );
      return [city, { baseDate, transport, days }];
    })
  );

  try {
    return JSON.stringify(snapshot);
  } catch {
    // Fallback ultraseguro por si hubiera caracteres inesperados
    return JSON.stringify({});
  }
}

function buildIntake(){
  const qsSafe = (sel) => (typeof qs === 'function' ? qs(sel) : document.querySelector(sel));

  const pax = [
    ['adults','#p-adults'],
    ['young','#p-young'],
    ['children','#p-children'],
    ['infants','#p-infants'],
    ['seniors','#p-seniors']
  ].map(([k,id])=>`${k}:${qsSafe(id)?.value||0}`).join(', ');

  const budgetVal   = qsSafe('#budget')?.value || 'N/A';
  const currencyVal = qsSafe('#currency')?.value || 'USD';
  const budget = budgetVal !== 'N/A' ? `${budgetVal} ${currencyVal}` : 'N/A';
  const specialConditions = (qsSafe('#special-conditions')?.value||'').trim() || 'N/A';

  // 🧭 Ventanas efectivas por ciudad usando getEffectivePerDay
  if (Array.isArray(savedDestinations)) {
    savedDestinations.forEach(dest=>{
      if(!dest || !dest.city) return;
      if(typeof cityMeta === 'undefined') return;
      if(!cityMeta[dest.city]) cityMeta[dest.city] = {};
      cityMeta[dest.city].perDay = getEffectivePerDay(dest.city, dest.days);
    });
  }

  const list = (Array.isArray(savedDestinations) ? savedDestinations : []).map(x=>{
    const dates = x.baseDate ? `, start=${x.baseDate}` : '';
    return `${x.city} (${x.country||'—'} · ${x.days} días${dates})`;
  }).join(' | ');

  // Incluye un resumen compacto de preferencias globales si existen (no obligatorio)
  const prefs = (typeof plannerState !== 'undefined' && plannerState?.preferences)
    ? JSON.stringify({
        alwaysIncludeDinner: !!plannerState.preferences.alwaysIncludeDinner,
        flexibleEvening: !!plannerState.preferences.flexibleEvening,
        iconicHintsModerate: !!plannerState.preferences.iconicHintsModerate,
        preferDayTrip: !!plannerState.preferences.preferDayTrip,
        preferAurora: !!plannerState.preferences.preferAurora
      })
    : 'N/A';

  return [
    `Destinations: ${list}`,
    `Travelers: ${pax}`,
    `Budget: ${budget}`,
    `Special conditions: ${specialConditions}`,
    `Preferences: ${prefs}`,
    `Existing: ${getFrontendSnapshot()}`
  ].join('\n');
}

// 🧠 Intake compacto por ciudad y rango de días (para prompts ligeros en rebalance y optimizeDay)
function buildIntakeLite(city, range = null){
  const it = (typeof itineraries !== 'undefined' && itineraries?.[city]) ? itineraries[city] : null;
  if(!it) return `City: ${city} (no data)`;

  const daysObj = it.byDay || {};
  let entries = Object.entries(daysObj);

  if(range && typeof range.start === 'number' && typeof range.end === 'number'){
    entries = entries.filter(([d]) => {
      const n = +d; return n >= range.start && n <= range.end;
    });
  }

  const compact = Object.fromEntries(entries.map(([d,rows])=>[
    d,
    (Array.isArray(rows) ? rows : []).map(r=>({
      start: r.start || '',
      end: r.end || '',
      activity: r.activity || '',
      from: r.from || '',
      to: r.to || ''
    }))
  ]));

  // 🧭 Ventanas efectivas para el rango solicitado
  const totalDays = (Array.isArray(savedDestinations)
    ? (savedDestinations.find(x=>x.city===city)?.days || 0)
    : 0);

  let perDayFull = getEffectivePerDay(city, totalDays);
  if(range){
    perDayFull = perDayFull.filter(pd => pd.day >= range.start && pd.day <= range.end);
  }

  const meta = {
    baseDate: it.baseDate || (typeof cityMeta !== 'undefined' && cityMeta?.[city]?.baseDate) || null,
    transport: (typeof cityMeta !== 'undefined' && cityMeta?.[city]?.transport) || '',
    perDay: perDayFull
  };

  try{
    return JSON.stringify({ city, meta, days: compact });
  }catch{
    // Fallback ultra simple si algo raro sucede al serializar
    return `{"city":"${city}","meta":{"baseDate":null,"transport":"","perDay":[]},"days":{}}`;
  }
}

/* ==============================
   SECCIÓN 11 · Contrato JSON / LLM (reforzado v61+)
   (Ajustado para integrarse con 12–21, validator v14 y merges v13)
================================= */
const FORMAT = `
Devuelve SOLO JSON válido (sin markdown) en UNO de estos formatos:

A) {"destinations":[
      {"name":"City",
       "rows":[
         {"day":1,"start":"09:00","end":"10:00","activity":"..","from":"..","to":"..","transport":"..","duration":"..","notes":".."}
       ],
       "rowsByDay": { "1":[{...}], "2":[{...}] }  // opcional
      }
    ],
    "replace": false,
    "followup":"Pregunta breve"
}

B) {"destination":"City",
    "rows":[{...}],
    "rowsByDay": { "1":[{...}] },       // opcional
    "replace": false,
    "followup":"Pregunta breve"
}

C) {"rows":[{...}],                      // aplica a la ciudad activa
    "replace": false,
    "followup":"Pregunta breve"
}

D) {"meta":{
      "city":"City",
      "baseDate":"DD/MM/YYYY",
      "start":"HH:MM" | ["HH:MM",...],
      "end":"HH:MM"   | ["HH:MM",...],
      "hotel":"Texto",
      "transport":"Texto"
    },
    "followup":"Pregunta breve"
}

E) {"itineraries":[                      // múltiple, compatible con merges v13
      {
        "city":"City",
        "rows":[{...}],
        "rowsByDay": { "1":[{...}], "2":[{...}] }, // opcional
        "replace": false
      }
    ],
    "followup":"Pregunta breve"
}

🧭 Campos adicionales opcionales:
- "preferences": {
    "pace": "relax" | "balanced" | "adventure",
    "transport": "public" | "car" | "taxi" | "mixed",
    "kids": true | false,
    "lowWalking": true | false,
    "accessibility": true | false,
    "diet": ["gluten-free","vegan","vegetarian","none"],
    "avoidMuseums": true | false,
    "preferNature": true | false,
    "preferDayTrip": true | false,
    "avoidQueues": true | false,
    "preferTransit": "metro" | "bus" | "walk" | "car",
    "budget": "$" | "$$" | "$$$"
  }
- "dayTripTo": "Nombre del destino para tour de 1 día" (si aplica)
- "locks": {"days":[2,3], "mode":"hard|soft"}
- "constraints": {"replaceRange":{"start":2,"end":4}}
- "remove":[{"day":2,"query":"Museo del Prado"}]
- "planBWeather": true | false

Reglas de generación y plausibilidad:
- Optimiza el/los día(s) afectado(s) (min traslados, agrupa por zonas, respeta ventanas).
- Usa ventanas del usuario si existen; si no, sugiere horas realistas (apertura/cierre) y buffers ≥15 min.
- Valida PLAUSIBILIDAD GLOBAL: geografía, temporada, clima aproximado, logística y tiempos de traslado coherentes.
- Transporte: urbano a pie/metro/bus; interurbano "Vehículo alquilado o Tour/Bus" cuando corresponda.
- Duraciones normalizadas: "45m", "1h", "1h30m" (o "90m"). Máximo 20 filas por día.

🧭 Day trips inteligentes:
- Evalúa imperdibles cercanos (≤ 2 h por trayecto; ≤ 3 h si la estancia en la ciudad > 5 días). Ida y vuelta el mismo día.
- Inserta explícitamente el "Regreso a City" al final del day trip.
- Si el usuario pide "dayTripTo", prográmalo y documenta traslados y subparadas en orden lógico.
- Evita duplicar actividades ya cubiertas; ofrece alternativas razonables cuando aplique.
- Respeta preferencias del viajero (ritmo, niños, movilidad, etc.).

🌌 Auroras (si plausibles para ciudad/fecha):
- Solo de noche (p.ej., 20:00–02:30); 1 evento de auroras por día.
- Añade en "notes" marcador "valid: ..." con justificación breve.
- Transporte coherente (Tour/Bus/Van o vehículo).
- Distribuye noches cuando tenga sentido; evita concentrar todas al final sin motivo.

📝 Notas obligatorias:
- NUNCA dejes "notes" vacío ni "seed"; escribe un tip útil, reserva recomendada, accesibilidad o contexto.
- Marca "Reserva recomendada" cuando corresponda (cupos/aforo/temporada alta).
- Para termales/spas populares sugiere permanencia mínima (~3h) si es relevante.

📌 Fusión de datos (merge por defecto):
- Conserva lo existente; NO borres salvo instrucción explícita ("replace": true o "constraints.replaceRange").
- "rowsByDay" y "rows" son compatibles con el merge del cliente.
- Nada de texto fuera del JSON.`;

/* ==============================
   SECCIÓN 12 · Llamada a Astra (estilo global, v66 inteligencia contextual)
   Base v65, mejoras v66: inteligencia global, imperdibles, energía/ritmo,
   day trips ≤2h (≤3h si >5 días en ciudad), sensibilidad costera, auroras,
   notas obligatorias y optimizaciones de latencia.
   Mantiene compatibilidad con: callAgent, callInfoAgent, parseJSON, session/infoSession,
   MODEL, API_URL, showThinking, setInfoChatBusy, tone, AURORA_DEFAULT_WINDOW, 
   isAuroraCityDynamic, inAuroraSeasonDynamic, getCoordinatesForCity, getHeuristicDayTripContext.
   ────────────────────────────────────────────────────────────
   🔍 v66 — Sección 12 reforzada con inteligencia contextual global
================================= */
async function callAgent(text, useHistory = true, opts = {}){
  // ⏳ Timeout ligeramente más agresivo para mejorar percepción de velocidad
  const { timeoutMs = 45000, cityName = null, baseDate = null } = opts;

  // 🧠 Historial compacto: últimas 12 interacciones para reducir tokens pero mantener contexto
  const history = useHistory
    ? (Array.isArray(session) ? session.slice(Math.max(0, session.length - 12)) : [])
    : [];

  // ───────────────── Heurísticas dinámicas (no bloqueantes) ────────────────
  let heuristicsContext = '';
  let auroraCity = false;
  let auroraSeason = false;
  let dayTripCtx = {};
  let stayDaysForCity = 0; // usado para regla ≤3h si >5 días
  try {
    if (cityName) {
      const coords = (typeof getCoordinatesForCity === 'function') ? getCoordinatesForCity(cityName) : null;
      if (coords && typeof coords.lat === 'number' && typeof coords.lng === 'number') {
        auroraCity = (typeof isAuroraCityDynamic === 'function') ? isAuroraCityDynamic(coords.lat, coords.lng) : false;
      }
      auroraSeason = (typeof inAuroraSeasonDynamic === 'function') ? inAuroraSeasonDynamic(baseDate) : false;
      dayTripCtx = (typeof getHeuristicDayTripContext === 'function') ? (getHeuristicDayTripContext(cityName) || {}) : {};

      // Detecta días de estancia actuales (si existen estructuras globales)
      if (typeof itineraries !== 'undefined' && itineraries[cityName]?.byDay) {
        stayDaysForCity = Object.keys(itineraries[cityName].byDay).length;
      } else if (Array.isArray(savedDestinations)) {
        const d = savedDestinations.find(x => x.city === cityName);
        stayDaysForCity = d?.days || 0;
      }

      const auroraWindow = (typeof AURORA_DEFAULT_WINDOW !== 'undefined')
        ? AURORA_DEFAULT_WINDOW
        : { start: '20:00', end: '02:30' };

      heuristicsContext = `
───────────────────────────────
🧭 CONTEXTO HEURÍSTICO GLOBAL
───────────────────────────────
- Ciudad: ${cityName}
- Estancia (días): ${stayDaysForCity}
- Aurora City: ${auroraCity}
- Aurora Season: ${auroraSeason}
- Aurora Window: ${JSON.stringify(auroraWindow)}
- Day Trip Context: ${JSON.stringify(dayTripCtx)}
      `.trim();
    }
  } catch (err) {
    console.warn('Heurística dinámica no disponible para:', cityName, err);
  }

  // ───────────────── Estilo / Reglas globales reforzadas (v66) ─────────────
  const globalStyle = `
Eres "Astra", planificador internacional experto. Respondes con itinerarios y ediciones **realistas, optimizados y accionables**.

📌 PRIORIDADES (v66):
1) **Imperdibles primero**: identifica y coloca los atractivos icónicos de cada ciudad antes que el resto.
2) **Secuencia lógica y sin estrés**: agrupa por zonas, reduce traslados, incluye buffers (≥15 min).
3) **Sin duplicados**: evita repetir actividades entre días, salvo excepciones de temporada/nocturnas justificadas (e.g., auroras).
4) **Ritmo/Energía**: balancea caminatas, comidas y descansos; evita jornadas maratónicas.
5) **Experiencia local**: incluye gastronomía relevante y momentos fotogénicos cuando aporte valor.
6) **Day trips**: solo si **aportan gran valor** y
   • ≤ 2 h por trayecto (ida) por defecto; 
   • ≤ 3 h por trayecto (ida) si la estancia en la ciudad **es > 5 días** (aplica a esta ciudad).
   Siempre ida y vuelta el mismo día, con traslados claros y agenda secuencial (origen → visitas → regreso).
7) **Sensibilidad costera**: si la ciudad es costera (p.ej. Barcelona), considera paseo marítimo/puerto/playa icónica cuando el tiempo lo permita, sin forzar clima.
8) **Auroras** (si plausible por ciudad/fecha): horario nocturno 20:00–02:30, con \`valid:\` en notas, transporte coherente; puede repetirse varias noches **si** agrega valor.
9) **Notas útiles siempre**: jamás dejes \`notes\` vacío ni \`seed\`; incluye tips de reserva, accesibilidad o contexto.

🕒 HORARIOS:
- Usa ventanas definidas por el usuario si existen; si no, asume base **08:30–19:00**.
- Puedes ampliar para cenas/tours nocturnos/auroras y **compensar el inicio del día siguiente** si corresponde.
- Nunca propongas auroras de día.

🌦️ CLIMA/ESTACIONALIDAD (nivel general):
- Ten en cuenta plausibilidad por estación (sin consultar en vivo); si una actividad es muy sensible al clima, sugiere plan B razonable.

🛡️ SEGURIDAD/RESTRICCIONES:
- Evita zonas con riesgos evidentes y marca alternativas seguras cuando aplique (breve, sin alarmismo).

📄 FORMATO (estricto):
- Usa el contrato JSON que se provee en el prompt de llamada (FORMAT). Nada de markdown ni texto fuera del JSON.
- No excedas 20 filas por día.

${heuristicsContext}
  `.trim();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);

  try{
    if (typeof showThinking === 'function') showThinking(true);

    // 🔽 Cuerpo compacto: evita texto redundante en payload para reducir tokens/latencia
    const payload = {
      model: (typeof MODEL !== 'undefined' ? MODEL : 'gpt-5-reasoning'),
      input: `${globalStyle}\n\n${text}`,
      history
    };

    const apiUrl = (typeof API_URL !== 'undefined' && API_URL) ? API_URL : '/api/chat';

    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });

    // Fail-soft
    const data = res.ok ? await res.json().catch(()=>({text:''})) : {text:''};
    return (data?.text || '');
  } catch(e){
    console.error("Fallo al contactar la API:", e);
    return `{"followup":"${(tone && tone.fail) ? tone.fail : 'No pude completar la acción.'}"}`;
  } finally{
    clearTimeout(timer);
    if (typeof showThinking === 'function') showThinking(false);
  }
}

function parseJSON(s){
  if(!s) return null;
  try{ return JSON.parse(s); }catch(_){}
  const m1 = s.match(/```json\s*([\s\S]*?)```/i) || s.match(/```([\s\S]*?)```/i);
  if(m1 && m1[1]){ try{ return JSON.parse(m1[1]); }catch(_){ } }
  const m2 = s.match(/<json>\s*([\s\S]*?)\s*<\/json>/i);
  if(m2 && m2[1]){ try{ return JSON.parse(m2[1]); }catch(_){ } }
  try{
    const cleaned = s.replace(/^[^\{]+/,'').replace(/[^\}]+$/,'');
    return JSON.parse(cleaned);
  }catch(_){ return null; }
}

/* Info Chat: respuesta breve, factual y accionable (sin JSON) */
async function callInfoAgent(text){
  const history = Array.isArray(infoSession) ? infoSession.slice(Math.max(0, infoSession.length - 12)) : [];
  const globalStyle = `
Eres "Astra", asistente informativo de viajes.
- SOLO respondes preguntas informativas (clima histórico aproximado, visados, movilidad, seguridad, presupuesto, enchufes, mejor época, normas básicas) de forma breve, clara y accionable.
- Considera factores de seguridad básicos y estacionalidad de forma general (sin consultar fuentes en vivo).
- NO propones ediciones de itinerario ni devuelves JSON. Respondes en texto directo.
`.trim();

  try{
    if (typeof setInfoChatBusy === 'function') setInfoChatBusy(true);

    const apiUrl = (typeof API_URL !== 'undefined' && API_URL) ? API_URL : '/api/chat';

    const res = await fetch(apiUrl,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        model: (typeof MODEL !== 'undefined' ? MODEL : 'gpt-5-reasoning'),
        input: `${globalStyle}\n\n${text}`,
        history,
        mode: 'info'
      })
    });

    const data = res.ok ? await res.json().catch(()=>({text:''})) : {text:''};
    const answer = (data?.text || '').trim();

    // Persistimos historial compacto
    if(Array.isArray(infoSession)){
      infoSession.push({ role:'user',      content: text });
      infoSession.push({ role:'assistant', content: answer });
      // Recorte suave para no crecer infinito
      if(infoSession.length > 24) infoSession.splice(0, infoSession.length - 24);
    }

    // Protección por si el modelo devuelve JSON por error
    if (/^\s*\{/.test(answer)) {
      try {
        const j = JSON.parse(answer);
        if (j?.destination || j?.rows || j?.followup) {
          return 'No pude traer la respuesta del Info Chat correctamente. Verifica tu API Key/URL en Vercel o vuelve a intentarlo.';
        }
      } catch { /* no-op */ }
    }

    return answer || '¿Algo más que quieras saber?';
  }catch(e){
    console.error("Fallo Info Chat:", e);
    return (tone && tone.fail) ? tone.fail : 'No se pudo obtener información en este momento.';
  }finally{
    if (typeof setInfoChatBusy === 'function') setInfoChatBusy(false);
  }
}

/* ==============================
   SECCIÓN 13 · Merge / utilidades
   (alineada con 15/16/17/18/19/20/21 y API INFO→PLANNER)
================================= */

/* Dedupe fuerte por (day|start|end|activity_norm) */
function dedupeInto(arr, row){
  // 🔧 Normalización robusta para evitar duplicados multi-idioma
  const key = o => [
    Number(o.day) || 1,
    o.start || '',
    o.end   || '',
    typeof normKey === 'function' ? normKey(o.activity || '') : String(o.activity||'').toLowerCase().trim()
  ].join('|');

  const has = arr.find(x => key(x) === key(row));
  if (!has) arr.push(row);
}

/* Garantiza que existan todos los días definidos para la ciudad */
function ensureDays(city){
  if(!itineraries[city]) itineraries[city] = { byDay:{}, currentDay:1, baseDate: null };
  const byDay = itineraries[city].byDay || {};
  const presentDays = Object.keys(byDay).map(n=>+n).filter(n=>Number.isFinite(n) && n>0);
  const maxPresent = presentDays.length ? Math.max(...presentDays) : 0;

  const savedDef = savedDestinations.find(x=>x.city===city);
  const saved = savedDef ? (Number(savedDef.days)||0) : 0;

  const want = Math.max(saved, maxPresent) || 1;
  for(let d=1; d<=want; d++){
    if(!byDay[d]) byDay[d] = [];
  }
  itineraries[city].byDay = byDay;
}

/* Normalizador de filas (acepta alias de campos del API y del agente) */
function normalizeRow(r = {}, fallbackDay = 1){
  const start   = r.start ?? r.start_time ?? r.startTime ?? r.hora_inicio ?? (typeof DEFAULT_START!=='undefined' ? DEFAULT_START : '08:30');
  const end     = r.end   ?? r.end_time   ?? r.endTime   ?? r.hora_fin    ?? (typeof DEFAULT_END!=='undefined'   ? DEFAULT_END   : '19:00');
  const act     = r.activity ?? r.title ?? r.name ?? r.descripcion ?? r.descripcion_actividad ?? '';
  const from    = r.from ?? r.origin ?? r.origen ?? '';
  const to      = r.to   ?? r.destination ?? r.destino ?? '';
  const trans   = r.transport ?? r.transportMode ?? r.modo_transporte ?? '';
  const durRaw  = r.duration ?? r.durationMinutes ?? r.duracion ?? '';
  const notes   = r.notes ?? r.nota ?? r.comentarios ?? '';

  const duration = (typeof durRaw === 'number')
    ? `${durRaw}m`
    : (String(durRaw)||'');

  const d = Math.max(1, parseInt(r.day ?? r.dia ?? fallbackDay, 10) || 1);

  // 🧩 Mantener banderas usadas río abajo (p.ej. fixOverlaps/orden tabs-safe)
  const cross = !!(r._crossDay);

  return {
    day: d,
    start: start || (typeof DEFAULT_START!=='undefined' ? DEFAULT_START : '08:30'),
    end:   end   || (typeof DEFAULT_END!=='undefined'   ? DEFAULT_END   : '19:00'),
    activity: act || '',
    from, to,
    transport: trans || '',
    duration,
    notes,
    _crossDay: cross
  };
}

/* Dedupe “suave” en el MISMO día por (activity/from/to) normalizados */
function dedupeSoftSameDay(rows){
  const seen = new Set();
  const out = [];
  const nk = (v)=> typeof normKey === 'function' ? normKey(String(v||'')) : String(v||'').toLowerCase().trim();

  for(const r of [...rows].sort((a,b)=> (a.start||'') < (b.start||'') ? -1 : 1)){
    const k = [nk(r.activity), nk(r.from), nk(r.to)].join('|');
    if(seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/**
 * Inserta/mezcla filas en el estado global.
 * - replace=false → hace merge incremental con dedupe
 * - replace=true  → reemplaza por días (solo los afectados)
 * - Limita a 20 filas/día (coherente con validador/IA)
 */
function pushRows(city, rows, replace=false){
  if(!city || !rows) return;
  if(!itineraries[city]) {
    itineraries[city] = {
      byDay:{},
      currentDay:1,
      baseDate: (cityMeta[city]?.baseDate || null)
    };
  }

  const byDay = itineraries[city].byDay;
  const daysToReplace = new Set();

  const mapped = rows.map(raw => normalizeRow(raw, 1));

  if(replace){
    mapped.forEach(obj => { daysToReplace.add(obj.day); });
    daysToReplace.forEach(d => { byDay[d] = []; });
  }

  mapped.forEach(obj=>{
    const d = obj.day;
    if(!byDay[d]) byDay[d] = [];
    dedupeInto(byDay[d], obj);
    byDay[d] = dedupeSoftSameDay(byDay[d]);

    // 🔒 Límite suave (máx 20 por día)
    if(byDay[d].length > 20) byDay[d] = byDay[d].slice(0, 20);
  });

  itineraries[city].byDay = byDay;
  ensureDays(city);
}

/* Upsert de metadatos por ciudad (no destruye campos no provistos) */
function upsertCityMeta(meta){
  const name = meta.city || activeCity || (savedDestinations[0]?.city);
  if(!name) return;

  if(!cityMeta[name]) {
    cityMeta[name] = { baseDate:null, start:null, end:null, hotel:'', transport:'', perDay:[] };
  }

  if(meta.baseDate) cityMeta[name].baseDate = meta.baseDate;
  if(meta.start)    cityMeta[name].start    = meta.start;
  if(meta.end)      cityMeta[name].end      = meta.end;

  if(typeof meta.hotel === 'string')     cityMeta[name].hotel     = meta.hotel;
  if(typeof meta.transport === 'string') cityMeta[name].transport = meta.transport;

  if(Array.isArray(meta.perDay)) cityMeta[name].perDay = meta.perDay;

  // Mantener espejo en itineraries[name]
  if(itineraries[name] && meta.baseDate) {
    itineraries[name].baseDate = meta.baseDate;
  }
}

/**
 * Aplica estructuras provenientes del API/Agente al estado global.
 * Soporta múltiples formatos: {destination, rows}, {destinations:[...]}, {itineraries:[...]}, {meta}, alias destino/destinos.
 * Respeta plannerState.forceReplan[city] para forzar replace por ciudad.
 */
function applyParsedToState(parsed){
  if(!parsed) return;

  // Alias comunes
  if(parsed.itinerary) parsed = parsed.itinerary;
  if(parsed.destinos)  parsed.destinations = parsed.destinos;
  if(parsed.destino && parsed.rows) parsed.destination = parsed.destino;

  if(parsed.meta) upsertCityMeta(parsed.meta);

  // 🧠 Detectar forceReplan por ciudad (coherente con 15/18/19)
  let forceReplanCity = null;
  if (typeof plannerState !== 'undefined' && plannerState.forceReplan) {
    const candidate = parsed.destination || parsed.city || parsed.meta?.city;
    if (candidate && plannerState.forceReplan[candidate]) {
      forceReplanCity = candidate;
    }
  }

  // A) Estructura con múltiples destinos
  if(Array.isArray(parsed.destinations)){
    parsed.destinations.forEach(d=>{
      const name = d.name || d.destination || d.meta?.city || activeCity || (savedDestinations[0]?.city);
      if(!name) return;

      const mustReplace = Boolean(d.replace) || (forceReplanCity === name);

      if(d.rowsByDay && typeof d.rowsByDay === 'object'){
        Object.entries(d.rowsByDay).forEach(([k,rows])=>{
          const dayNum = +k;
          pushRows(name, (rows||[]).map(r=>({ ...r, day: dayNum })), mustReplace);
        });
      } else if(Array.isArray(d.rows)){
        pushRows(name, d.rows, mustReplace);
      }

      // Limpiar flag de replan tras aplicar
      if(forceReplanCity === name && plannerState?.forceReplan){
        delete plannerState.forceReplan[name];
      }
    });
    return;
  }

  // B) Un solo destino con rows
  if(parsed.destination && Array.isArray(parsed.rows)){
    const name = parsed.destination;
    const mustReplace = Boolean(parsed.replace) || (forceReplanCity === name);
    pushRows(name, parsed.rows, mustReplace);

    if(forceReplanCity === name && plannerState?.forceReplan){
      delete plannerState.forceReplan[name];
    }
    return;
  }

  // C) Lista de itinerarios heterogénea
  if(Array.isArray(parsed.itineraries)){
    parsed.itineraries.forEach(x=>{
      const name = x.city || x.name || x.destination || activeCity || (savedDestinations[0]?.city);
      if(!name) return;

      const mustReplace = Boolean(x.replace) || (forceReplanCity === name);

      if(x.rowsByDay && typeof x.rowsByDay==='object'){
        Object.entries(x.rowsByDay).forEach(([k,rows])=>{
          const dayNum = +k;
          pushRows(name, (rows||[]).map(r=>({ ...r, day: dayNum })), mustReplace);
        });
      } else if(Array.isArray(x.rows)) {
        pushRows(name, x.rows, mustReplace);
      }

      if(forceReplanCity === name && plannerState?.forceReplan){
        delete plannerState.forceReplan[name];
      }
    });
    return;
  }

  // D) Fallback: rows sueltos → ciudad activa
  if(Array.isArray(parsed.rows)){
    const city = activeCity || (savedDestinations[0]?.city);
    if(!city) return;
    const mustReplace = Boolean(parsed.replace) || (forceReplanCity === city);
    pushRows(city, parsed.rows, mustReplace);

    if(forceReplanCity === city && plannerState?.forceReplan){
      delete plannerState.forceReplan[city];
    }
  }
}

/* ==============================
   SECCIÓN 13B · Add Multiple Days
   (mejorada con rebalanceo inteligente por rango; integra 18/19/21)
================================= */
function addMultipleDaysToCity(city, extraDays){
  if(!city || extraDays <= 0) return;
  ensureDays(city);

  const byDay = (itineraries[city].byDay || {});
  const days  = Object.keys(byDay).map(n=>+n).sort((a,b)=>a-b);
  const currentMax = days.length ? Math.max(...days) : 0;

  // 🧠 Memoriza el “último día original” si no existía (usado por 19/21)
  if (!itineraries[city].originalDays) {
    itineraries[city].originalDays = currentMax;
  }
  const lastOriginalDay = itineraries[city].originalDays;

  // 🆕 Agregar SOLO días nuevos y crear ventana base si falta
  for(let i=1; i<=extraDays; i++){
    const newDay = currentMax + i;
    if(!byDay[newDay]){ // evita duplicar días
      // insertDayAt se asume global (ya presente en el planner)
      if (typeof insertDayAt === 'function') {
        insertDayAt(city, newDay);
      } else {
        byDay[newDay] = [];
      }

      // Ventanas por defecto si la ciudad no las tiene definidas
      const baseStart = (typeof DEFAULT_START!=='undefined' ? DEFAULT_START : '08:30');
      const baseEnd   = (typeof DEFAULT_END!=='undefined'   ? DEFAULT_END   : '19:00');
      const start = cityMeta[city]?.perDay?.find(x=>x.day===newDay)?.start || baseStart;
      const end   = cityMeta[city]?.perDay?.find(x=>x.day===newDay)?.end   || baseEnd;

      if(!cityMeta[city]) cityMeta[city] = { perDay: [] };
      if(!cityMeta[city].perDay.find(x=>x.day===newDay)){
        cityMeta[city].perDay.push({ day:newDay, start, end });
      }
    }
  }

  // 📝 Sincroniza cantidad total en savedDestinations
  const dest = savedDestinations.find(x=>x.city===city);
  const newLastDay = currentMax + extraDays;
  if(dest) dest.days = newLastDay;

  // 🧭 Rango de rebalanceo: desde el último original hasta el nuevo final
  const rebalanceStart = Math.max(1, lastOriginalDay);
  const rebalanceEnd   = newLastDay;

  // 🧭 Señal de replan para el agente (leído en 15/18/19)
  if (typeof plannerState !== 'undefined') {
    if (!plannerState.forceReplan) plannerState.forceReplan = {};
    plannerState.forceReplan[city] = true;
  }

  // 🧼 Snapshot de actividades existentes (evitar duplicados por agente)
  const allExistingActs = Object.values(itineraries[city].byDay || {})
    .flat()
    .map(r => (typeof normKey === 'function' ? normKey(String(r.activity || '')) : String(r.activity||'').toLowerCase().trim()))
    .filter(Boolean);

  if(!plannerState.existingActs) plannerState.existingActs = {};
  plannerState.existingActs[city] = new Set(allExistingActs);

  // 🔄 Rebalanceo inteligente sólo en el rango afectado
  if (typeof showWOW === 'function') showWOW(true, 'Astra está reequilibrando la ciudad…');

  const customOpts = { start: rebalanceStart, end: rebalanceEnd, avoidDuplicates: true };
  const p = (typeof rebalanceWholeCity === 'function')
    ? rebalanceWholeCity(city, customOpts)
    : Promise.resolve();

  p.catch(err => console.error('Error en rebalance automático:', err))
   .finally(() => { if (typeof showWOW === 'function') showWOW(false); });
}

/* ==============================
   SECCIÓN 13·C — Diagnóstico/Hardening “primera fila”
   (drop-in: colócalo tras SECCIÓN 13 y antes de SECCIÓN 14)
================================= */
(function hardenFirstRow(){
  // Logger + wrapper de pushRows
  const _pushRows = pushRows;
  window.__itbmo_debug = window.__itbmo_debug || {};
  window.__itbmo_debug.events = window.__itbmo_debug.events || [];

  // No tocar tus helpers existentes:
  const _normalizeRow = (typeof normalizeRow === 'function') ? normalizeRow : (r)=>r;
  const _ensureDays   = (typeof ensureDays   === 'function') ? ensureDays   : function(city){
    if(!itineraries[city]) itineraries[city]={byDay:{},currentDay:1,baseDate:null};
    if(!itineraries[city].byDay[1]) itineraries[city].byDay[1]=[];
  };

  pushRows = function(city, rows, replace=false){
    try{
      const before = (itineraries?.[city]?.byDay?.[1] || []).length;
      window.__itbmo_debug.lastCity = city;
      window.__itbmo_debug.lastRows = Array.isArray(rows) ? rows.slice(0,3) : rows;
      window.__itbmo_debug.events.push({ ts: Date.now(), city, replace, before });

      _pushRows(city, rows, replace);

      const after = (itineraries?.[city]?.byDay?.[1] || []).length;
      window.__itbmo_debug.events.at(-1).after = after;

      // ⚠️ Si había filas entrantes pero sigue en 0, la primera se perdió por dedupe o replace indebido
      if ((before===0) && (after===0) && Array.isArray(rows) && rows.length){
        console.warn('⚠️ Primera fila absorbida por merge/dedupe. Reinsertando sin dedupe…');
        _ensureDays(city);
        const first = _normalizeRow(rows[0], 1);
        const d = Math.max(1, parseInt(first.day||1,10));
        if(!itineraries[city].byDay[d]) itineraries[city].byDay[d]=[];
        // Inserción directa (intencionalmente sin dedupe)
        itineraries[city].byDay[d].unshift({
          day: d,
          start: first.start||'08:30',
          end: first.end||'19:00',
          activity: first.activity||'(sin título)',
          from: first.from||'',
          to: first.to||'',
          transport: first.transport||'',
          duration: first.duration||'',
          notes: first.notes||'reinserted:first-row'
        });
        // Render inmediato del día activo/ciudad relevante
        if(typeof renderCityItinerary === 'function'){
          const c = city || (typeof activeCity!=='undefined' ? activeCity : null);
          if(c) renderCityItinerary(c);
        }
      }
    }catch(err){
      console.error('hardenFirstRow wrapper error:', err);
      // En caso de fallo, no bloqueamos el flujo original
      return _pushRows(city, rows, replace);
    }
  };

  // 🚫 CSS safety: impedir que algún theme/tabla oculte la primera fila
  const style = document.createElement('style');
  style.setAttribute('data-itbmo-firstrow-guard','true');
  style.textContent = `
    #itinerary-container table.itinerary tbody tr:first-child {
      display: table-row !important;
      visibility: visible !important;
      opacity: 1 !important;
    }
  `;
  document.head.appendChild(style);

  // Utilidad para inspección rápida desde consola
  window.__probeFirstRow = (city)=>({
    incomingFirstRow: (window.__itbmo_debug?.lastRows && window.__itbmo_debug.lastRows[0]) || null,
    storedFirstRow:   (itineraries?.[city]?.byDay?.[1]?.[0]) || null,
    counters: {
      before: window.__itbmo_debug?.events?.at(-1)?.before ?? null,
      after:  window.__itbmo_debug?.events?.at(-1)?.after  ?? null
    }
  });
})();

/* ==============================
   SECCIÓN 14 · Validación GLOBAL (2º paso con IA) — reforzado
   Base v60 (exacta) + injertos v64 + ⚡ early-exit cuando ENABLE_VALIDATOR=false
   🔧 Alineada con API INFO→PLANNER (v43) y Sec.18/19:
      - Usa callApiChat('planner', { validate: true, city, baseDate, rows }) si existe
      - Fallback local robusto (sin IA) cuando falla o está deshabilitado
      - Mantiene nombre y firma para no romper integraciones
================================= */
if (typeof validateRowsWithAgent !== 'function') {
  async function validateRowsWithAgent(city, rows, baseDate) {
    // Helpers locales (sin dependencias externas)
    const toStr = v => (v == null ? '' : String(v));
    const lc = s => toStr(s).trim().toLowerCase();
    const isAurora = a => /\baurora|northern\s+light(s)?\b/i.test(toStr(a));
    const isThermal = a => /(blue\s*lagoon|bláa\s*lón(i|í)d|laguna\s+azul|termal(es)?|hot\s*spring|thermal\s*bath)/i.test(toStr(a));

    // 📦 Sanitizado local (reutilizado en fast-path y fallback)
    const localSanitize = (inRows = [])=>{
      const sanitized = (inRows||[]).map(r => {
        const notesRaw = toStr(r.notes).trim();
        const notes = notesRaw && lc(notesRaw)!=='seed'
          ? notesRaw
          : 'Sugerencia: verifica horarios, seguridad básica y reserva con antelación.';
        if(isAurora(r.activity)){
          return {
            ...r,
            start: r.start && /^\d{2}:\d{2}$/.test(r.start) ? r.start : '20:30',
            end:   r.end   && /^\d{2}:\d{2}$/.test(r.end)   ? r.end   : '02:00',
            transport: r.transport || 'Tour/Bus/Van',
            notes: /valid:/i.test(notes) ? notes : notes + ' · valid: ventana nocturna auroral (sujeto a clima).'
          };
        }
        if(isThermal(r.activity)){
          let duration = toStr(r.duration).trim();
          if(!duration) duration = '3h';
          return { ...r, duration, notes: /min\s*stay/i.test(notes) ? notes : notes + ' · min stay ~3h (ajustable)' };
        }
        return { ...r, notes };
      });

      // Límite suave de 20 por día + dedupe por actividad canonizada
      const grouped = {};
      sanitized.forEach(r=>{
        const d = Number(r.day)||1;
        (grouped[d] ||= []).push(r);
      });
      const allowed = Object.keys(grouped).flatMap(dStr=>{
        const d = Number(dStr);
        let arr = grouped[d];

        // Dedupe fuerte por actividad canonizada para mismo día
        const seenActs = new Set();
        arr = arr.filter(x=>{
          const k = typeof normKey === 'function' ? normKey(x.activity || '') : (x.activity||'').toLowerCase().trim();
          if(!k) return false;
          if(seenActs.has(k)) return false;
          seenActs.add(k);
          return true;
        });

        if(arr.length <= 20) return arr.map(x=>({...x, day:d}));
        const out=[]; const seen = new Set();
        for(const r of arr){
          const key = (typeof normKey === 'function' ? normKey(r.activity || '') : (r.activity||'').toLowerCase().trim())
                     + '|' + (r.start||'') + '|' + (r.end||'');
          if(!seen.has(key)){
            seen.add(key); out.push({...r, day:d});
          }
          if(out.length===20) break;
        }
        return out;
      });
      return { allowed, removed: [] };
    };

    // ⚡ Fast-path: sin llamada a IA cuando ENABLE_VALIDATOR=false
    if (typeof ENABLE_VALIDATOR !== 'undefined' && ENABLE_VALIDATOR === false) {
      return localSanitize(rows);
    }

    // Post-sanitizado suave para respuestas con IA
    const postSanitize = (arr=[])=>{
      const byDay = {};
      arr.forEach(r=>{
        const d = Number(r.day)||1;
        (byDay[d] ||= []).push(r);
      });
      const out = [];
      for(const dStr of Object.keys(byDay)){
        const d = Number(dStr);
        let dayRows = byDay[d].map(r=>{
          let notes = toStr(r.notes).trim();
          if(!notes || lc(notes)==='seed'){
            notes = 'Sugerencia: verifica horarios, seguridad y reservas con antelación.';
          }
          if(isAurora(r.activity)){
            const start = r.start && /^\d{2}:\d{2}$/.test(r.start) ? r.start : '20:30';
            const end   = r.end   && /^\d{2}:\d{2}$/.test(r.end)   ? r.end   : '02:00';
            const transport = r.transport ? r.transport : 'Tour/Bus/Van';
            if(!/valid:/i.test(notes)) notes = (notes ? notes+' · ' : '') + 'valid: ventana nocturna auroral (sujeto a clima).';
            return {...r, day:d, start, end, transport, notes};
          }
          if(isThermal(r.activity)){
            let duration = toStr(r.duration).trim();
            const isShort =
              (!duration) ||
              (/^(\d{1,2})m$/i.test(duration) && Number(RegExp.$1) < 180) ||
              (/^(\d+(?:\.\d+)?)h$/i.test(duration) && Number(RegExp.$1) < 3);
            if(isShort) duration = '3h';
            if(!/min\s*stay|3h/i.test(notes)) notes = (notes ? notes+' · ' : '') + 'min stay ~3h (ajustable)';
            return {...r, day:d, duration, notes};
          }
          return {...r, day:d, notes};
        });

        // Dedupe por actividad canonizada + límite 20
        const seenActs = new Set();
        dayRows = dayRows.filter(x=>{
          const k = typeof normKey === 'function' ? normKey(x.activity||'') : (x.activity||'').toLowerCase().trim();
          if(!k) return false;
          if(seenActs.has(k)) return false;
          seenActs.add(k);
          return true;
        });

        if(dayRows.length > 20){
          const seen = new Set(); const filtered=[];
          for(const r of dayRows){
            const key = (typeof normKey === 'function' ? normKey(r.activity||'') : (r.activity||'').toLowerCase().trim())
                        + '|' + (r.start||'') + '|' + (r.end||'');
            if(!seen.has(key)){
              seen.add(key);
              filtered.push(r);
            }
            if(filtered.length === 20) break;
          }
          dayRows = filtered;
        }

        out.push(...dayRows);
      }
      return out;
    };

    // ===== Ruta con IA (planner.validate) alineada al API v43 =====
    try{
      if (typeof callApiChat === 'function') {
        const resp = await callApiChat('planner', { validate: true, city, baseDate, rows }, { timeoutMs: 22000, retries: 0 });
        // Respeta contratos de Sec.18: { text: "...JSON..." } o objeto
        const txtOrObj = (typeof resp === 'object' && resp) ? (resp.text ?? resp) : resp;
        let parsed;
        try {
          parsed = typeof txtOrObj === 'string' ? JSON.parse(txtOrObj) : txtOrObj;
        } catch {
          parsed = {};
        }
        if (parsed && Array.isArray(parsed.allowed)) {
          const allowed = postSanitize(parsed.allowed || []);
          const removed = Array.isArray(parsed.removed) ? parsed.removed : [];
          return { allowed, removed };
        }
        // Si la estructura no es la esperada, cae al fallback local
        return localSanitize(rows);
      }

      // Fallback a cliente antiguo si existiera (no obligatorio)
      if (typeof callAgent === 'function') {
        const payload = `
Devuelve SOLO JSON válido:
{
  "allowed":[
    {"day":1,"start":"..","end":"..","activity":"..","from":"..","to":"..","transport":"..","duration":"..","notes":".."}
  ],
  "removed":[
    {"reason":"..","row":{"day":..,"start":"..","end":"..","activity":"..","from":"..","to":"..","transport":"..","duration":"..","notes":".."}}
  ]
}
...
Contexto:
- Ciudad: "${city}"
- Fecha base (Día 1): ${baseDate || 'N/A'}
- Filas a validar: ${JSON.stringify(rows)}
`.trim();
        const res = await callAgent(payload, true);
        let parsed = null;
        try { parsed = typeof res === 'string' ? JSON.parse(res) : res; } catch {}
        if(parsed?.allowed){
          const allowed = postSanitize(parsed.allowed || []);
          const removed = Array.isArray(parsed.removed) ? parsed.removed : [];
          return { allowed, removed };
        }
      }
    }catch(e){
      console.warn('Validator error', e);
    }

    // Fallback local
    return localSanitize(rows);
  }
}

/* ==============================
   SECCIÓN 15 · Generación por ciudad (versión restaurada v65 estable)
   Patch align v43/API + Sec.18/19/20/21 — quirúrgico (sin romper nombres)
================================= */

/* ─────────────────────────────────────────────────────────────
   [15.1] Overlay helpers (mensajes y bloqueo de UI)
   - ✅ Mantiene habilitado solo “reset-planner”
   - 🆕 Bloquea “info-chat-floating”
   - 🆕 Atributo aria-busy + manejo de tabindex (accesibilidad)
───────────────────────────────────────────────────────────── */
function setOverlayMessage(msg='Astra está generando itinerarios…'){
  const p = $overlayWOW?.querySelector('p');
  if(p) p.textContent = msg;
}

function showWOW(on, msg){
  if(!$overlayWOW) return;
  if(msg) setOverlayMessage(msg);
  $overlayWOW.style.display = on ? 'flex' : 'none';
  $overlayWOW.setAttribute('aria-busy', on ? 'true' : 'false');

  const all = qsa('button, input, select, textarea, a');
  all.forEach(el=>{
    // ✅ Mantener habilitado solo el botón de reset
    if (el.id === 'reset-planner') return;

    // 🆕 Bloquear también el botón flotante de Info Chat
    if (el.id === 'info-chat-floating') {
      el.disabled = on;
      return;
    }

    if(on){
      el._prevDisabled = el.disabled;
      el.disabled = true;
      el._prevTabIndex = el.getAttribute('tabindex');
      el.setAttribute('tabindex','-1');
    }else{
      if(typeof el._prevDisabled !== 'undefined'){
        el.disabled = el._prevDisabled;
        delete el._prevDisabled;
      }else{
        el.disabled = false;
      }
      if(typeof el._prevTabIndex !== 'undefined'){
        el.setAttribute('tabindex', el._prevTabIndex);
        delete el._prevTabIndex;
      }else{
        el.removeAttribute('tabindex');
      }
    }
  });
}

/* ─────────────────────────────────────────────────────────────
   SECCIÓN 15.2 · Generación principal por ciudad
   Base v60 + injertos v64 + dedupe global con normKey
   🆕 v75→API v43: primer poblado con doble etapa INFO→PLANNER
   🆕 Robustez: usa callApiChat (si existe) con timeout/reintentos + caché research
   🆕 Auroras: normalización + tope no consecutivo por día ANTES de pushRows
   🆕 Inyección segura post-planner: duration normalizada / cena / retorno a ciudad
   🆕 Rendimiento: optimizeDay sólo en días realmente vacíos o “flacos” (≥ umbral)
   🆕 Coherencia: 1 sola aurora por día + limpieza de transporte tras “Regreso”
───────────────────────────────────────────────────────────── */
async function generateCityItinerary(city){
  window.__cityLocks = window.__cityLocks || {};
  if (window.__cityLocks[city]) { console.warn(`[Mutex] Generación ya en curso para ${city}`); return; }
  window.__cityLocks[city] = true;

  const toHHMM = s => String(s||'').trim();
  const parseHHMM = (hhmm)=>{
    const m = /^(\d{1,2}):(\d{2})$/.exec(toHHMM(hhmm));
    if(!m) return null;
    const h = Math.min(23, Math.max(0, +m[1]));
    const min = Math.min(59, Math.max(0, +m[2]));
    return {h, min};
  };
  const addMinutes = (hhmm, mins)=>{
    const t = parseHHMM(hhmm);
    if(!t) return null;
    let total = t.h*60 + t.min + mins;
    while(total < 0) total += 24*60;
    total = total % (24*60);
    const h = Math.floor(total/60);
    const m = total % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  };

  /* ==================== Helpers API ==================== */
  const hasCallApiChat = (typeof callApiChat === 'function');

  async function callPlannerAPI_withResearch(researchJson){
    if (hasCallApiChat) {
      const resp = await callApiChat('planner', { research_json: researchJson }, { timeoutMs: 42000, retries: 1 });
      const txt  = (typeof resp === 'object' && resp) ? (resp.text ?? resp) : resp;
      return cleanToJSONPlus(txt || resp) || {};
    }
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "planner", research_json: researchJson }),
    });
    if (!resp.ok) throw new Error(`API planner HTTP ${resp.status}`);
    const data = await resp.json();
    return cleanToJSONPlus(data?.text || data) || {};
  }

  async function callInfoAPI(context){
    if (hasCallApiChat) {
      const resp = await callApiChat('info', { context }, { timeoutMs: 32000, retries: 1 });
      const txt  = (typeof resp === 'object' && resp) ? (resp.text ?? resp) : resp;
      return cleanToJSONPlus(txt || resp) || {};
    }
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "info", context }),
    });
    if (!resp.ok) throw new Error(`API info HTTP ${resp.status}`);
    const data = await resp.json();
    return cleanToJSONPlus(data?.text || data) || {};
  }

  async function callPlannerAPI_legacy(messages, opts = {}) {
    const payload = { mode: "planner", messages };
    if (opts.itinerary_id) payload.itinerary_id = opts.itinerary_id;
    if (typeof opts.version === 'number') payload.version = opts.version;

    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(`API planner(legacy) HTTP ${resp.status}`);
    const data = await resp.json();
    const text = data?.text || "";
    // 🔧 Alineado con v43: tolerante a prólogos/epílogos
    return cleanToJSONPlus(text) || {};
  }

  function hasCoverageForAllDays(rows, totalDays){
    if(!Array.isArray(rows) || !rows.length) return false;
    const flags = new Set(rows.map(r=>Number(r.day)||1));
    for(let d=1; d<=totalDays; d++){ if(!flags.has(d)) return false; }
    return true;
  }
  // 🆕 umbral de “día flaco”
  function dayIsTooThin(city, day, min=3){
    const cur = itineraries[city]?.byDay?.[day] || [];
    return cur.filter(r=>!!r.activity).length < min;
  }

  try {
    const dest  = savedDestinations.find(x=>x.city===city);
    if(!dest) return;

    const perDay = Array.from({length:dest.days}, (_,i)=>{
      const src  = (cityMeta[city]?.perDay||[])[i] || dest.perDay?.[i] || {};
      return { day:i+1, start: src.start || DEFAULT_START, end: src.end || DEFAULT_END };
    });

    const baseDate = cityMeta[city]?.baseDate || dest.baseDate || '';
    const hotel    = cityMeta[city]?.hotel || '';
    const transport= cityMeta[city]?.transport || 'recomiéndame';
    const forceReplan = !!(plannerState?.forceReplan && plannerState.forceReplan[city]);

    let heuristicsContext = '';
    try{
      const coords = getCoordinatesForCity(city);
      const dayTripContext = getHeuristicDayTripContext(city) || {};
      heuristicsContext = `
───────────────────────────────
🧭 CONTEXTO HEURÍSTICO GLOBAL
───────────────────────────────
- Ciudad: ${city}
- Coords: ${coords ? JSON.stringify(coords) : 'N/D'}
- Day Trip Context: ${JSON.stringify(dayTripContext)}
      `.trim();
    }catch(err){
      console.warn('Heurística no disponible:', city, err);
      heuristicsContext = '⚠️ Sin contexto heurístico disponible.';
    }

    const intakeText = `
${FORMAT}
**Genera únicamente ${dest.days} día/s para "${city}"** (tabs ya existen en UI).
Ventanas base por día (UI): ${JSON.stringify(perDay)}.
Hotel/zona: ${hotel || 'a determinar'} · Transporte preferido: ${transport || 'a determinar'}.
Requisitos:
- Cobertura completa días 1–${dest.days} (sin días vacíos).
- Rutas madre → subparadas; inserta "Regreso a ${city}" en day-trips.
- Horarios plausibles: base 08:30–19:00; buffers ≥15m.
- Transporte coherente: urbano a pie/metro; interurbano vehículo/tour si no hay bus local.
- Duraciones normalizadas ("1h30m", "45m"). Máx 20 filas/día.
Notas:
- Breves y útiles (con "valid:" cuando aplique).
- Si el research trae auroras, respétalas tal cual (ventana/nota/duración).
Contexto adicional:
${heuristicsContext}
INTAKE:
${buildIntake()}
`.trim();

    if (typeof setOverlayMessage === 'function') {
      try { setOverlayMessage(`Generando itinerario para ${city}…`); } catch(_) {}
    }

    /* =================== Doble etapa INFO→PLANNER con caché =================== */
    window.__researchCache = window.__researchCache || {};
    const cached = window.__researchCache[city];

    let parsed = null;
    try{
      const context = __collectPlannerContext__(city, 1);
      const research = cached || await callInfoAPI(context);
      if(!cached) window.__researchCache[city] = research;
      const structured = await callPlannerAPI_withResearch(research);
      parsed = structured;
    }catch(errInfoPlanner){
      console.warn('[generateCityItinerary] INFO→PLANNER falló, uso LEGACY:', errInfoPlanner);
      const apiMessages = [{ role: "user", content: intakeText }];
      const current = itineraries?.[city] || null;
      parsed = await callPlannerAPI_legacy(apiMessages, {
        itinerary_id: current?.itinerary_id,
        version: typeof current?.version === 'number' ? current.version : undefined,
      });
    }

    if(parsed && (parsed.rows || parsed.destination)){
      const rowsFromApi = Array.isArray(parsed.rows) ? parsed.rows : [];
      // 1 sola pasada de normalización → performance
      let tmpRows = rowsFromApi.map(r=>normalizeRow(r));

      // Dedupe contra lo ya existente
      const existingActs = Object.values(itineraries[city]?.byDay||{}).flat().map(r=>normKey(String(r.activity||'')));
      tmpRows = tmpRows.filter(r=>!existingActs.includes(normKey(String(r.activity||''))));

      // Fixes suaves
      if(typeof applyTransportSmartFixes==='function') tmpRows=applyTransportSmartFixes(tmpRows);
      if(typeof applyThermalSpaMinDuration==='function') tmpRows=applyThermalSpaMinDuration(tmpRows);
      if(typeof sanitizeNotes==='function') tmpRows=sanitizeNotes(tmpRows);

      // === PIPELINE COHERENTE (una sola pasada por transformación pesada) ===
      // A) normalizaciones
      if(typeof normalizeDurationLabel==='function') tmpRows = tmpRows.map(normalizeDurationLabel);
      if(typeof normalizeAuroraWindow==='function')  tmpRows = tmpRows.map(normalizeAuroraWindow);
      // B) auroras: 1 por día + tope no consecutivo (cap global)
      if(typeof enforceOneAuroraPerDay==='function') tmpRows = enforceOneAuroraPerDay(tmpRows);
      if(typeof enforceAuroraCapForDay==='function' && typeof suggestedAuroraCap==='function'){
        const cap = suggestedAuroraCap(dest.days || tmpRows.reduce((m,r)=>Math.max(m, Number(r.day)||1), 1));
        const byDayTmp = {}; tmpRows.forEach(r => { const d=Number(r.day)||1; (byDayTmp[d]=byDayTmp[d]||[]).push(r); });
        const rebuilt = [];
        Object.keys(byDayTmp).map(n=>+n).sort((a,b)=>a-b).forEach(day=>{
          rebuilt.push(...enforceAuroraCapForDay(city, day, byDayTmp[day], cap));
        });
        tmpRows = rebuilt;
      }
      // C) transporte (relleno sólo si falta / coherencia out-of-town)
      if(typeof enforceTransportAndOutOfTown==='function') tmpRows = enforceTransportAndOutOfTown(city, tmpRows);
      // D) anti-solapes + cruce nocturno tabs-safe
      if(typeof fixOverlaps==='function') tmpRows = fixOverlaps(tmpRows);
      // E) retorno a ciudad si day-trip
      if(typeof ensureReturnRow==='function') tmpRows = ensureReturnRow(city, tmpRows);
      // F) limpiar transporte en actividades urbanas posteriores al regreso
      if(typeof clearTransportAfterReturn==='function') tmpRows = clearTransportAfterReturn(city, tmpRows);
      // G) cena si procede (preferencia global activada en Sec.16)
      if(plannerState?.preferences?.alwaysIncludeDinner && typeof injectDinnerIfMissing==='function'){
        tmpRows = injectDinnerIfMissing(city, tmpRows);
      }
      // H) poda de genéricos redundantes
      if(typeof pruneGenericPerDay==='function') tmpRows = pruneGenericPerDay(tmpRows);

      // Empuje a estado
      pushRows(city, tmpRows, !!forceReplan);

      // Render/optimización sólo donde hace falta
      ensureDays(city);
      const totalDays = dest.days || Object.keys(itineraries[city].byDay||{}).length || 1;

      const hasAll = hasCoverageForAllDays(tmpRows, totalDays);
      for(let d=1; d<=totalDays; d++){
        const need = forceReplan || !hasAll || dayIsTooThin(city, d, 3);
        if (need){ /* eslint-disable no-await-in-loop */ await optimizeDay(city,d); }
      }

      renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
      if(forceReplan && plannerState?.forceReplan) delete plannerState.forceReplan[city];
      if(plannerState?.preferences){ delete plannerState.preferences.preferDayTrip; delete plannerState.preferences.preferAurora; }
      $resetBtn?.removeAttribute('disabled');
      return;
    }

    // Fallback visual si el API no trajo JSON válido
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    $resetBtn?.removeAttribute('disabled');
    chatMsg('⚠️ Fallback local: sin respuesta JSON válida del API.','ai');

  } catch(err){
    console.error(`[ERROR] generateCityItinerary(${city})`, err);
    chatMsg(`⚠️ No se pudo generar el itinerario para <strong>${city}</strong>.`, 'ai');
  } finally {
    delete window.__cityLocks[city];
  }
}

/* ==============================
   SECCIÓN 15.3 · Rebalanceo global por ciudad
   v69 (base)  → 🆕 Ruta moderna: usa optimizeDay (INFO→PLANNER) en rango
   Dedupe robusto y fallback local se conservan cuando aplica
================================= */

/* ——— Utilitarios LOCALES (scope de la sección) ——— */
function __canonTxt__(s){
  return String(s||'')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^\p{L}\p{N}\s]/gu,' ')
    .replace(/\s+/g,' ')
    .trim();
}
function __isGenericActivity__(name){
  const t = __canonTxt__(name);
  const generic = [
    'desayuno','almuerzo','comida','merienda','cena',
    'descanso','relax','tiempo libre','libre',
    'traslado','transfer','check in','check-in','check out','check-out',
    'shopping','compras'
  ];
  if (generic.some(g => t === g || t.startsWith(g+' ') || (' '+t+' ').includes(' '+g+' '))) return true;
  if (t.split(' ').length <= 2 && /^(almuerzo|cena|desayuno|traslado|descanso)$/i.test(t)) return true;
  return false;
}
function __stripStopWords__(s){
  const STOP = ['the','la','el','los','las','de','del','da','do','dos','das','di','du','a','al','en','of','and','y','e'];
  const toks = s.split(' ').filter(w=>w && !STOP.includes(w));
  return toks.join(' ').trim() || s;
}
function __aliasKey__(base){
  const ALIAS = [
    ['park guell','parc guell','parque guell','parque güell','park güell','güell park','guell park','guell'],
    ['sagrada familia','basilica sagrada familia','templo expiatorio de la sagrada familia','templo de la sagrada familia'],
    ['casa batllo','casa batlló','batllo','batlló'],
    ['la rambla','las ramblas','rambla'],
    ['barceloneta','playa de la barceloneta'],
    ['gothic quarter','barrio gotico','barrio gótico','gothic','gotico','gótico'],
    ['ciutadella','parc de la ciutadella','parque de la ciutadella','ciutadella park'],
    ['born','el borne','el born'],
    ['old town','ciudad vieja','casco antiguo','centro historico','centro histórico'],
  ];
  for(const group of ALIAS){
    const norm = group.map(__canonTxt__);
    if(norm.some(a=>base.includes(a))) return norm[0];
  }
  return base;
}
function __placeKey__(name){
  const raw = String(name||'').trim();
  if(!raw) return '';
  if(__isGenericActivity__(raw)) return '';
  const base = __stripStopWords__(__canonTxt__(raw));
  return __aliasKey__(base);
}
function __buildPrevActivityKeySet__(byDay, start){
  const keys = new Set();
  const days = Object.keys(byDay).map(n=>+n).sort((a,b)=>a-b);
  for(const d of days){
    if(d >= start) break;
    for(const r of (byDay[d]||[])){
      const k = __placeKey__(r.activity||'');
      if(k) keys.add(k);
    }
  }
  return keys;
}
function __keysToExampleList__(keys, limit=80){
  return Array.from(keys).slice(0, limit);
}

/* ——— Rebalanceo por rango (ruta moderna) ——— */
async function rebalanceWholeCity(city, rangeOpt = {}){
  if(!city || !itineraries[city]) return;

  const data     = itineraries[city];
  const baseDate = data.baseDate || cityMeta[city]?.baseDate || '';
  const byDay    = data.byDay || {};
  const allDays  = Object.keys(byDay).map(n=>+n).sort((a,b)=>a-b);
  if(!allDays.length) return;

  const start = Math.max(1, parseInt(rangeOpt.start||1,10));
  const end   = Math.max(start, parseInt(rangeOpt.end||allDays[allDays.length-1],10));

  // Conservamos set de exclusión (informativo; las deducciones duras ya las maneja optimizeDay)
  const prevKeySet = __buildPrevActivityKeySet__(byDay, start);
  const prevExamples = __keysToExampleList__(prevKeySet);

  showWOW(true, `Reequilibrando ${city}…`);

  try{
    // 🆕 Reequilibrio con **optimizeDay** (INFO→PLANNER) para cada día del rango
    for(let d=start; d<=end; d++){
      /* eslint-disable no-await-in-loop */
      await optimizeDay(city, d);
    }
  }catch(err){
    console.warn('[rebalanceWholeCity] optimizeDay rango falló. Intento de salvataje local.', err);

    // ✅ Fallback seguro: ordenar por horario sin tocar "day"
    const merged = { ...(itineraries[city].byDay || {}) };
    Object.keys(merged).forEach(d=>{
      merged[d] = (merged[d]||[]).map(normalizeRow)
        .sort((a,b)=>(a.start||'')<(b.start||'')?-1:1);
    });
    itineraries[city].byDay = merged;
  }

  renderCityTabs();
  setActiveCity(city);
  renderCityItinerary(city);
  showWOW(false);
}

/* ==============================
   SECCIÓN 16 · Inicio (hotel/transport)
   v60 base + overlay bloqueado global hasta terminar todas las ciudades
   (concurrencia controlada vía runWithConcurrency)
   + Mejora: resolutor inteligente de hotel/zona y banderas globales de cena/vespertino/auroras
   + Patch align v43/API + Sec.18/19 (quirúrgico, sin romper nombres)
   + HOTFIX v77.3: persistencia y tabs — asegura D1 y pintado del primer tab
================================= */

async function startPlanning(){
  // 🔒 Asegura persistencia y tabs antes de iniciar (hotfix)
  try {
    if (!Array.isArray(window.savedDestinations) || !savedDestinations.length) {
      if (typeof saveDestinations === 'function') window.saveDestinations();
    }
    if ($tabs && !$tabs.children.length && typeof renderCityTabs === 'function') {
      renderCityTabs();
    }
  } catch(_) {}

  if(!Array.isArray(window.savedDestinations) || savedDestinations.length===0) return;

  // UI inicial
  if ($chatBox) $chatBox.style.display='flex';
  planningStarted = true;
  collectingHotels = true;
  session = [];
  metaProgressIndex = 0;

  // 🛠️ Preferencias globales consumidas por optimizador (Sec.18) y Chat (Sec.19)
  // Mantener claves exactas para compatibilidad:
  if(!plannerState) window.plannerState = {};
  if(!plannerState.preferences) plannerState.preferences = {};
  plannerState.preferences.alwaysIncludeDinner = true;   // cena visible en franja correcta
  plannerState.preferences.flexibleEvening     = true;   // ventana vespertina flexible
  plannerState.preferences.iconicHintsModerate = true;   // icónicos con frecuencia moderada

  // 1) Saludo inicial
  chatMsg(`${tone.hi}`);

  // 2) Tip del Info Chat (una sola vez)
  chatMsg(`${tone.infoTip}`, 'ai');

  // 3) Comienza flujo de solicitud de hotel/zona y transporte
  askNextHotelTransport();
}

/* ====== Resolutor inteligente de Hotel/Zona (fuzzy & alias) ====== */
const hotelResolverCache = {}; // cache por ciudad
function _normTxt(s){
  return String(s||'')
    .normalize('NFD').replace(/\p{Diacritic}/gu,'')
    .toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
}
function _tokenSet(str){
  return new Set(_normTxt(str).split(' ').filter(Boolean));
}
function _jaccard(a,b){
  const A=_tokenSet(a), B=_tokenSet(b);
  const inter = [...A].filter(x=>B.has(x)).length;
  const uni   = new Set([...A,...B]).size || 1;
  return inter/uni;
}
function _levRatio(a,b){
  // usa levenshteinDistance disponible (Sec.17)
  const A=_normTxt(a), B=_normTxt(b);
  const maxlen = Math.max(A.length,B.length) || 1;
  return (maxlen - levenshteinDistance(A,B))/maxlen;
}

// Pre-carga alias por ciudad: nombres populares, barrios, POIs cercanos, etc.
function preloadHotelAliases(city){
  if(!city) return;
  if(!plannerState.hotelAliases) plannerState.hotelAliases = {};
  if(plannerState.hotelAliases[city]) return;

  const base = [city];
  const extras = [
    'centro','downtown','old town','historic center','main square','cathedral',
    'harbor','port','university','station','bus terminal','train station'
  ];

  // si existen referencias del usuario en cityMeta (últimos hoteles elegidos), úsalas
  const prev = (cityMeta?.[city]?.hotel ? [cityMeta[city].hotel] : []);
  plannerState.hotelAliases[city] = [...new Set([...base, ...extras, ...prev])];
}

function resolveHotelInput(userText, city){
  const raw = String(userText||'').trim();
  if(!raw) return {text:'', confidence:0};

  // 1) Atajos: links → conf alta
  if(/^https?:\/\//i.test(raw)){
    return { text: raw, confidence: 0.98, resolvedVia: 'url' };
  }

  // 2) Si el usuario da “zona/landmark”, intenta casar con alias y POIs ya vistos
  const candidates = new Set();

  // Aliases precargados
  (plannerState.hotelAliases?.[city] || []).forEach(x=>candidates.add(x));

  // Heurística: añade nombres de sitios del itinerario actual (si existe)
  const byDay = itineraries?.[city]?.byDay || {};
  Object.values(byDay).flat().forEach(r=>{
    if(r?.activity) candidates.add(r.activity);
    if(r?.to)       candidates.add(r.to);
    if(r?.from)     candidates.add(r.from);
  });

  // Hotel previo del usuario si existía
  if(cityMeta?.[city]?.hotel) candidates.add(cityMeta[city].hotel);

  // 3) Puntuar por mezcla: Jaccard de tokens + Levenshtein ratio
  let best = { text: raw, confidence: 0.50, resolvedVia: 'raw' };
  const list = [...candidates].filter(Boolean);
  for(const c of list){
    const j = _jaccard(raw, c);
    const l = _levRatio(raw, c);
    // mezcla: 60% Jaccard + 40% Levenshtein ratio
    const score = 0.6*j + 0.4*l;
    if(score > (best.score||0)){
      best = { text: c, confidence: Math.max(0.55, Math.min(0.99, score)), resolvedVia: 'alias', score };
    }
  }

  // 4) Cache y retorno
  hotelResolverCache[city] = hotelResolverCache[city] || {};
  hotelResolverCache[city][raw] = best;
  return best;
}

function askNextHotelTransport(){
  // ✅ Si ya se procesaron todos los destinos → generar itinerarios
  if(metaProgressIndex >= savedDestinations.length){
    collectingHotels = false;
    chatMsg(tone.confirmAll);

    (async ()=>{
      // 🔒 Mantener UI bloqueada durante la generación global
      showWOW(true, 'Astra está generando itinerarios…');

      // ⚙️ Concurrencia controlada (v60): respeta runWithConcurrency
      const taskFns = savedDestinations.map(({city}) => async () => {
        // generateCityItinerary debe activar el pipeline INFO→PLANNER mediante Sec.18/19
        if (typeof generateCityItinerary === 'function') {
          await generateCityItinerary(city);
        } else if (typeof ensureDays === 'function' && typeof optimizeDay === 'function') {
          // Fallback seguro (no cambia nombres): genera días y optimiza cada uno
          ensureDays(city);
          const total = Object.keys(itineraries?.[city]?.byDay || {}).length;
          for (let d = 1; d <= total; d++) {
            await optimizeDay(city, d);
          }
        }
      });
      await runWithConcurrency(taskFns);

      // ✅ Al terminar TODAS las ciudades, desbloquear UI
      showWOW(false);
      chatMsg(tone.doneAll);
      try { document.dispatchEvent(new CustomEvent('itbmo:allCitiesPlanned', { detail: { cities: savedDestinations.map(d=>d.city) } })); } catch(_) {}
    })();
    return;
  }

  // 🧠 Validación y persistencia del destino actual
  const city = savedDestinations[metaProgressIndex].city;
  if(!cityMeta[city]){
    cityMeta[city] = { baseDate: null, hotel:'', transport:'', perDay: [] };
  }

  // 🔎 Pre-carga de alias/POIs para ayudar al usuario a escribir “a su manera”
  preloadHotelAliases(city);

  // ⛔ Debe esperar explícitamente hotel/zona antes de avanzar (requisito)
  const currentHotel = cityMeta[city].hotel || '';
  if(!currentHotel.trim()){
    setActiveCity(city);
    renderCityItinerary(city);
    chatMsg(tone.askHotelTransport(city), 'ai');
    return; // 👈 No avanza hasta que el usuario indique hotel/zona
  }

  // 🧭 Avanzar al siguiente destino si ya hay hotel guardado
  metaProgressIndex++;
  askNextHotelTransport();
}

/* ============================================================
   HOTFIX v77.3 — Persistencia + Tabs (quirúrgico, no rompe nombres)
   - Sincroniza tripleta de fecha → .baseDate (DD/MM/AAAA)
   - Asegura itineraries[city].byDay[1] para poder pintar la tabla
   - Reconstruye y activa el primer tab si no hay uno activo
============================================================ */

/* Helpers locales de fecha (tripleta → DMY) */
function __pad2_fix__(n){ n=Number(n)||0; return String(n).padStart(2,'0'); }
function __year4_fix__(y){ y=String(y||'').trim(); if(/^\d{2}$/.test(y)) return '20'+y; return /^\d{4}$/.test(y)? y : ''; }
function __tripletToDMY__(row){
  if(!row) return '';
  const d = (row.querySelector('.baseDay')   || {}).value;
  const m = (row.querySelector('.baseMonth') || {}).value;
  const y = (row.querySelector('.baseYear')  || {}).value;
  const dd = __pad2_fix__(d), mm = __pad2_fix__(m), yyyy = __year4_fix__(y);
  if(!dd || !mm || !yyyy) return '';
  return `${dd}/${mm}/${yyyy}`;
}
function __ensureHiddenBaseDate__(row){
  if(!row) return '';
  let base = row.querySelector('.baseDate');
  if(!base){
    base = document.createElement('input');
    base.type = 'text';
    base.className = 'baseDate';
    base.style.display = 'none';
    row.appendChild(base);
  }
  const dmy = __tripletToDMY__(row);
  if(dmy) base.value = dmy;
  return base.value || '';
}

/* ====== SAVE (override quirúrgico) ======
   Lee filas garantizando fecha válida y estructura mínima.
   ⚠️ FIX: usa un contexto seguro si $cityList aún no existe.
*/
(function hotfix_saveDestinations_v77_3(){
  const orig = typeof saveDestinations === 'function' ? saveDestinations : null;

  window.saveDestinations = function(){
    // 🔧 Asegurar $cityList si todavía no está seteado
    try {
      if (!window.$cityList || !(window.$cityList instanceof Element)) {
        window.$cityList = document.querySelector('#city-list') || null;
      }
    } catch(_) {}

    // ⚠️ Contexto SEGURO para buscar filas aunque $cityList aún no esté listo
    const ctx = (window.$cityList && window.$cityList.nodeType === 1)
      ? window.$cityList
      : (document.querySelector('#city-list') || document);

    const rows = qsa('.city-row', ctx);
    const out = [];

    rows.forEach((r)=>{
      const city    = (r.querySelector('.city')    || {}).value?.trim()    || '';
      const country = (r.querySelector('.country') || {}).value?.trim()    || '';
      const daysStr = (r.querySelector('.days')    || {}).value?.trim()    || '0';
      const days    = Math.max(0, parseInt(daysStr, 10) || 0);

      // Fecha: tripleta preferida, fallback .baseDate
      let baseDate = __tripletToDMY__(r);
      if(!baseDate){
        const baseEl = r.querySelector('.baseDate');
        baseDate = (baseEl?.value || '').trim();
      }
      // Sincronizar .baseDate para pipelines que la necesiten
      if(!r.querySelector('.baseDate')) __ensureHiddenBaseDate__(r);
      if(!baseDate) baseDate = __ensureHiddenBaseDate__(r);

      if(city && country && days > 0 && /^(\d{2})\/(\d{2})\/(\d{4})$/.test(baseDate)){
        out.push({ city, country, days, baseDate });
      }
    });

    // Persistir en estado global
    window.savedDestinations = out;

    // Llamar al original si existe (por side-effects adicionales)
    if(orig){ try { orig(); } catch(e){ console.warn('[HOTFIX] saveDestinations(orig) error:', e); } }

    // Inicializar estructuras mínimas para pintar el primer tab
    if(Array.isArray(savedDestinations) && savedDestinations.length){
      savedDestinations.forEach(({city, days, baseDate})=>{
        if(!window.itineraries) window.itineraries = {};
        if(!itineraries[city]) itineraries[city] = { byDay: {}, baseDate, originalDays: Math.max(days||0, 1) };
        if(!itineraries[city].byDay) itineraries[city].byDay = {};
        // Asegurar Day 1 con array aunque esté vacío (la tabla se pinta)
        if(!Array.isArray(itineraries[city].byDay[1])) itineraries[city].byDay[1] = [];
        // Sincronizar baseDate si aún no está
        if(!itineraries[city].baseDate && baseDate) itineraries[city].baseDate = baseDate;

        // cityMeta ventanas por día (para overlaps/horas) — mínimo D1
        if(!window.cityMeta) window.cityMeta = {};
        if(!cityMeta[city]) cityMeta[city] = { baseDate, hotel:'', transport:'', perDay: [] };
        if(!Array.isArray(cityMeta[city].perDay)) cityMeta[city].perDay = [];
        const hasD1 = cityMeta[city].perDay.some(x=>x.day===1);
        if(!hasD1){
          cityMeta[city].perDay.push({ day: 1, start: (typeof DEFAULT_START==='string'? DEFAULT_START : '08:30'),
                                            end: (typeof DEFAULT_END  ==='string'? DEFAULT_END   : '19:00') });
        }
      });
    }

    // Reconstruir tabs inmediatamente tras guardar
    try { renderCityTabs(); } catch(e){ console.warn('[HOTFIX] renderCityTabs error:', e); }

    return out;
  };
})();

/* ====== TABS (override quirúrgico) ======
   Reconstruye tabs y activa el primero si no hay activo.
*/
(function hotfix_renderCityTabs_v77_3(){
  const orig = typeof renderCityTabs === 'function' ? renderCityTabs : null;

  window.renderCityTabs = function(){
    if(!$tabs) return;
    $tabs.innerHTML = '';

    const list = Array.isArray(savedDestinations) ? savedDestinations : [];
    if(!list.length){
      // Sin tabs -> limpiar vista
      if($itWrap) $itWrap.innerHTML = '';
      if(orig){ try { orig(); } catch(e){} }
      return;
    }

    // Crear botones de tabs
    list.forEach(({city})=>{
      const btn = document.createElement('button');
      btn.className = 'city-tab';
      btn.textContent = city;
      btn.dataset.city = city;
      btn.addEventListener('click', ()=>{
        try { setActiveCity(city); } catch(e){ console.warn('[HOTFIX] setActiveCity click error:', e); }
      });
      $tabs.appendChild(btn);
    });

    // Activar el tab actual o el primero
    let target = window.activeCity && list.some(d => d.city === window.activeCity)
      ? window.activeCity
      : list[0].city;

    try { setActiveCity(target); } catch(e){
      console.warn('[HOTFIX] setActiveCity init error:', e);
      // fallback: pinta al menos la tabla del primero si hay renderer
      if(typeof renderCityItinerary === 'function'){
        try { renderCityItinerary(target); } catch(_) {}
      }
    }

    if(orig){ try { orig(); } catch(e){} }
  };
})();

/* ====== setActiveCity (override muy acotado) ======
   Asegura clase .active en el tab, currentDay=1 y render inmediato.
*/
(function hotfix_setActiveCity_v77_3(){
  const orig = typeof setActiveCity === 'function' ? setActiveCity : null;

  window.setActiveCity = function(city){
    window.activeCity = city;

    // Marcar visualmente el tab activo
    if($tabs){
      qsa('.city-tab', $tabs).forEach(b=>{
        b.classList.toggle('active', b.dataset.city === city);
      });
    }

    // Asegurar estructura mínima
    if(!window.itineraries) window.itineraries = {};
    if(!itineraries[city]) itineraries[city] = { byDay: {}, baseDate: (savedDestinations.find(d=>d.city===city)?.baseDate || ''), originalDays: 1 };
    if(!itineraries[city].byDay) itineraries[city].byDay = {};
    if(!Array.isArray(itineraries[city].byDay[1])) itineraries[city].byDay[1] = [];

    // Día visible por defecto
    itineraries[city].currentDay = 1;

    // Pintar tabla del día actual
    if(typeof renderCityItinerary === 'function'){
      try { renderCityItinerary(city); } catch(e){ console.warn('[HOTFIX] renderCityItinerary error:', e); }
    }

    if(orig){ try { orig(city); } catch(e){} }
  };
})();

/* ============================================================
   SECCIÓN 18 · Edición/Manipulación + Optimización + Validación
   Base v73 — Ajuste flexible FINAL (quirúrgico) → Patch v77.2
   Cambios clave en este patch:
   • (LEGACY-RESTORE) Inserción de PRIMERA FILA idéntica a la lógica vieja:
     - Si un día queda/está vacío, se siembra una fila inicial segura
       antes del pipeline (respetando ventana perDay y defaults).
     - La semilla NO pisa filas existentes, ni duplica si hay contenido.
   • Mantengo 100 % la lógica INFO → PLANNER y todo el pipeline posterior.
   • Resto de funciones intactas respecto a v77.1 (quirúrgico).
   ============================================================ */

/* ------------------------------------------------------------------
   Utilidades base (si no existen en otras secciones, se definen aquí)
------------------------------------------------------------------- */
if (typeof __toMinHHMM__ !== 'function') {
  function __toMinHHMM__(t) {
    const m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
    const mi = Math.min(59, Math.max(0, parseInt(m[2], 10)));
    return h * 60 + mi;
  }
}
if (typeof __toHHMMfromMin__ !== 'function') {
  function __toHHMMfromMin__(mins) {
    let m = Math.round(Math.max(0, Number(mins) || 0));
    m = m % (24 * 60);
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }
}
if (typeof __addMinutesSafe__ !== 'function') {
  function __addMinutesSafe__(hhmm, add) {
    const base = __toMinHHMM__(hhmm);
    if (base == null) return hhmm || '09:00';
    const target = base + (Number(add) || 0);
    return __toHHMMfromMin__(target);
  }
}

/* ------------------------------------------------------------------
   Detección de nocturnas / auroras / out-of-town
------------------------------------------------------------------- */
if (typeof __isNightRow__ !== 'function') {
  function __isNightRow__(r) {
    const act = String(r?.activity || '').toLowerCase();
    const notes = String(r?.notes || '').toLowerCase();
    const sMin = __toMinHHMM__(r?.start);
    const eMin = __toMinHHMM__(r?.end);
    if (/auroras?|northern\s*lights/.test(act)) return true;
    if (/noche|nocturn/.test(notes)) return true;
    if (sMin != null && sMin >= 18 * 60) return true;
    if (eMin != null && e >= 24 * 60) return true;
    return false;
  }
}
if (typeof isOutOfTownRow !== 'function') {
  // Fallback conservador: considera out-of-town si hay palabras clave
  function isOutOfTownRow(city, r) {
    const a = (r?.activity || '').toLowerCase();
    const f = (r?.from || '').toLowerCase();
    const t = (r?.to || '').toLowerCase();
    const c = String(city || '').toLowerCase();
    const hints = /excursi[oó]n|pen[ií]nsula|costa|glaciar|c[ií]rculo|parque|volc[aá]n|lago|cascada/;
    const notCity = (str) => str && c && !str.includes(c);
    return hints.test(a) || notCity(f) || notCity(t);
  }
}

/* ------------------------------------------------------------------
   Normalizadores (duración y ventana de auroras)
------------------------------------------------------------------- */
if (typeof normalizeDurationLabel !== 'function') {
  function normalizeDurationLabel(r) {
    const raw = String(r?.duration || '').trim();
    let minutes = 0;
    let m = raw.match(/(\d+)\s*h(?:\s*(\d+)\s*m)?/i);
    if (m) {
      minutes = parseInt(m[1], 10) * 60 + (m[2] ? parseInt(m[2], 10) : 0);
    } else {
      m = raw.match(/(\d+)\s*m/i);
      if (m) minutes = parseInt(m[1], 10);
    }
    if (!minutes) {
      const s = __toMinHHMM__(r?.start), e = __toMinHHMM__(r?.end);
      if (s != null && e != null) minutes = ((e - s) + 24 * 60) % (24 * 60);
      if (!minutes) minutes = 60;
    }
    const h = Math.floor(minutes / 60);
    const mm = minutes % 60;
    const label = h ? (mm ? `${h}h${mm}m` : `${h}h`) : `${mm}m`;
    return { ...r, duration: label };
  }
}
if (typeof normalizeAuroraWindow !== 'function') {
  function normalizeAuroraWindow(r) {
    const act = String(r?.activity || '');
    if (!/\bauroras?\b|\bnorthern\s+lights?\b/i.test(act)) return r;

    const fallbackStart = '20:15';
    const fallbackEnd = '00:15';

    let s = __toMinHHMM__(r?.start);
    let e = __toMinHHMM__(r?.end);
    let d = String(r?.duration || '').trim();

    if (s == null || e == null || e <= s) {
      s = __toMinHHMM__(fallbackStart);
      e = __toMinHHMM__(fallbackEnd) + 24 * 60; // cruza medianoche
    }

    const dur = (function () {
      const md = d.match(/(\d+)\s*h(?:\s*(\d+)\s*m)?/i);
      const mm = d.match(/(\d+)\s*m/i);
      if (md) return parseInt(md[1], 10) * 60 + (md[2] ? parseInt(md[2], 10) : 0);
      if (mm) return parseInt(mm[1], 10);
      return ((e - s) + 24 * 60) % (24 * 60) || 240; // 4h
    })();

    const startHH = __toHHMMfromMin__(Math.min(Math.max(s, 18 * 60), (23 * 60) + 59));
    const endHH = __toHHMMfromMin__(e % (24 * 60));
    const lbl = dur >= 60 ? (dur % 60 ? `${Math.floor(dur / 60)}h${dur % 60}m` : `${Math.floor(dur / 60)}h`) : `${dur}m`;
    return { ...r, start: startHH, end: endHH, duration: lbl, _crossDay: true };
  }
}

/* ------------------------------------------------------------------
   Reglas de auroras (cap/no consecutivas/una por día)
------------------------------------------------------------------- */
function __isAuroraName__(txt) { return /\bauroras?\b|\bnorthern\s+lights?\b/i.test(String(txt || '')); }

function countAuroraNights(city) {
  const byDay = itineraries[city]?.byDay || {};
  let c = 0;
  for (const d of Object.keys(byDay)) {
    const rows = byDay[d] || [];
    if (rows.some(r => __isAuroraName__(r.activity))) c++;
  }
  return c;
}

function suggestedAuroraCap(stayDays) {
  if (stayDays >= 5) return 2;
  if (stayDays >= 3) return 1;
  return 1;
}

function isConsecutiveAurora(city, day) {
  const byDay = itineraries[city]?.byDay || {};
  const prev = byDay[day - 1] || [], next = byDay[day + 1] || [];
  return prev.some(r => __isAuroraName__(r.activity)) || next.some(r => __isAuroraName__(r.activity));
}

function enforceAuroraCapForDay(city, day, rows, cap) {
  const already = countAuroraNights(city);
  const willAdd = rows.some(r => __isAuroraName__(r.activity));
  if (!willAdd) return rows;
  if (isConsecutiveAurora(city, day)) return rows.filter(r => !__isAuroraName__(r.activity));
  if (already >= cap) return rows.filter(r => !__isAuroraName__(r.activity));
  return rows;
}

function enforceOneAuroraPerDay(rows) {
  const byDay = {};
  rows.forEach(r => { const d = Number(r.day) || 1; (byDay[d] = byDay[d] || []).push(r); });
  const out = [];
  Object.keys(byDay).map(n => +n).sort((a, b) => a - b).forEach(day => {
    let seen = false;
    for (const r of byDay[day]) {
      if (__isAuroraName__(r.activity)) { if (seen) continue; seen = true; }
      out.push(r);
    }
  });
  return out;
}

/* ------------------------------------------------------------------
   Poda de genéricos y limpieza de transporte post-Regreso
------------------------------------------------------------------- */
function pruneGenericPerDay(rows) {
  const byDay = {}; rows.forEach(r => { const d = Number(r.day) || 1; (byDay[d] = byDay[d] || []).push(r); });
  const out = [];
  for (const d of Object.keys(byDay)) {
    const list = byDay[d];
    let seen = { desayuno: false, almuerzo: false, cena: false };
    const dayHasContent = list.filter(r => !/d[ií]a\s*libre/i.test(String(r.activity || ''))).length >= 3;
    for (const r of list) {
      const a = String(r.activity || '').toLowerCase();
      if (/desayuno\b/.test(a)) { if (seen.desayuno) continue; seen.desayuno = true; }
      if (/almuerzo\b|comida\b/.test(a)) { if (seen.almuerzo) continue; seen.almuerzo = true; }
      if (/cena\b/.test(a)) { if (seen.cena) continue; seen.cena = true; }
      if (/d[ií]a\s*libre/.test(a) && dayHasContent) continue;
      out.push(r);
    }
  }
  return out;
}

function clearTransportAfterReturn(city, rows) {
  const cityLow = String(city || '').toLowerCase();
  let afterReturn = false;
  return rows.map(r => {
    const act = String(r.activity || '').toLowerCase();
    const to = String(r.to || '').toLowerCase();
    if (/regreso/.test(act) || (to.includes('hotel') && to.includes(cityLow))) { afterReturn = true; return r; }
    if (afterReturn && !isOutOfTownRow(city, r)) {
      return { ...r, transport: (r.transport && /pie|metro|bus|uber|taxi/i.test(r.transport)) ? r.transport : 'A pie' };
    }
    return r;
  });
}

/* ------------------------------------------------------------------
   Overlaps & orden tabs-safe (no altera "day")
------------------------------------------------------------------- */
function fixOverlaps(rows) {
  const toMin = __toMinHHMM__;
  const toHH = __toHHMMfromMin__;
  const durMin = (d) => {
    if (!d) return 0;
    const m = String(d).match(/(\d+)\s*h(?:\s*(\d+)\s*m)?/i);
    if (m) return parseInt(m[1], 10) * 60 + (m[2] ? parseInt(m[2], 10) : 0);
    const m2 = String(d).match(/(\d+)\s*m/i);
    if (m2) return parseInt(m2[1], 10);
    return 0;
  };

  const expanded = rows.map(r => {
    let s = toMin(r.start || '');
    let e = toMin(r.end || '');
    const d = durMin(r.duration || '');
    let cross = false;

    if (s != null && (e == null || e <= s)) {
      if (__isNightRow__(r) || (d > 0 && s >= 18 * 60)) {
        e = (e != null ? e : s + Math.max(d, 60)) + 24 * 60;
        cross = true;
      } else {
        e = e != null ? (e <= s ? s + Math.max(d, 60) : e) : s + Math.max(d, 60);
      }
    } else if (s == null && e != null && d > 0) {
      s = e - d; if (s < 0) s = 9 * 60;
    } else if (s == null && e == null) {
      s = 9 * 60; e = s + 60;
    }

    return { __s: s, __e: e, __d: d, __cross: cross, raw: r };
  });

  expanded.sort((a, b) => (a.__s || 0) - (b.__s || 0));

  const out = [];
  let prevEnd = null;
  for (const item of expanded) {
    let { __s: s, __e: e, __d: d, __cross: cross, raw: r } = item;

    if (prevEnd != null && s < prevEnd + 15) {
      const shift = (prevEnd + 15) - s;
      s += shift; e += shift;
    }
    prevEnd = Math.max(prevEnd ?? 0, e);

    const finalDur = d > 0 ? r.duration : `${Math.max(60, e - s)}m`;

    const isNight = __isNightRow__(r);
    if (isNight && s >= 24 * 60) { e -= 24 * 60; s -= 24 * 60; cross = true; }

    const startHH = isNight ? toHH(Math.min(Math.max(s, 18 * 60), (23 * 60) + 59)) : toHH(s);
    const endHH = toHH(e);

    out.push({ ...r, start: startHH, end: endHH, duration: finalDur, _crossDay: (r._crossDay || cross || e >= 24 * 60) ? true : false });
  }
  return out;
}

function __normalizeDayField__(city, r) {
  let d = Number(r.day);
  if (!Number.isFinite(d) || d < 1) d = 1;
  const total = (itineraries[city]?.originalDays) || (cityMeta[city]?.days) || 0;
  if (total > 0 && d > total) d = total;
  return { ...r, day: d };
}

function __sortRowsTabsSafe__(rows) {
  return [...rows].sort((a, b) => {
    const da = Number(a.day) || 1, db = Number(b.day) || 1;
    if (da !== db) return da - db;
    const sa = __toMinHHMM__(a.start) || 0, sb = __toMinHHMM__(b.start) || 0;
    const wa = (a._crossDay && sa < 360) ? sa + 24 * 60 : sa;
    const wb = (b._crossDay && sb < 360) ? sb + 24 * 60 : sb;
    return wa - wb;
  });
}

/* ------------------------------------------------------------------
   “Regreso a {city}” en day-trips (sin duplicar si ya existe)
------------------------------------------------------------------- */
function ensureReturnRow(city, rows) {
  const byDay = {};
  for (const r of rows) { const d = Number(r.day) || 1; (byDay[d] = byDay[d] || []).push(r); }
  const out = [];
  const cityLbl = String(city || '').trim();
  Object.keys(byDay).map(n => +n).sort((a, b) => a - b).forEach(day => {
    const list = byDay[day].slice();
    const hasOut = list.some(r => isOutOfTownRow(city, r));
    const hasReturn = list.some(r => {
      const act = String(r.activity || '').toLowerCase();
      const to = String(r.to || '').toLowerCase();
      const cty = String(cityLbl || '').toLowerCase();
      return /regreso/.test(act) || (to.includes('hotel') && to.includes(cty));
    });
    if (hasOut && !hasReturn) {
      const endBase = (cityMeta[city]?.perDay?.find(x => x.day === day)?.end) || DEFAULT_END || '19:00';
      const lastEnd = list.reduce((mx, r) => Math.max(mx, __toMinHHMM__(r.end) || 0), __toMinHHMM__(endBase) || 1140);
      const startRet = __toHHMMfromMin__(Math.max(lastEnd, __toMinHHMM__(endBase) || 1140));
      const endRet = __addMinutesSafe__(startRet, 45);
      list.push({
        day,
        start: startRet,
        end: endRet,
        activity: `Regreso a ${cityLbl}`,
        from: list[list.length - 1]?.to || 'Excursión',
        to: `Hotel (${cityLbl})`,
        transport: 'Vehículo alquilado o Tour guiado',
        duration: '45m',
        notes: 'Cierre del day trip y retorno al hotel.'
      });
    }
    out.push(...list);
  });
  return out;
}

/* ------------------------------------------------------------------
   Inyección de cena (respeta preferencia global)
------------------------------------------------------------------- */
if (typeof injectDinnerIfMissing !== 'function') {
  function injectDinnerIfMissing(city, rows) {
    const prefer = plannerState?.preferences?.alwaysIncludeDinner;
    if (!prefer) return rows;
    const byDay = {}; rows.forEach(r => { const d = Number(r.day) || 1; (byDay[d] = byDay[d] || []).push(r); });
    const out = [];
    Object.keys(byDay).map(n => +n).sort((a, b) => a - b).forEach(day => {
      const list = byDay[day].slice();
      const hasDinner = list.some(r => /cena\b/i.test(String(r.activity || '')));
      if (!hasDinner) {
        const endMax = list.reduce((mx, r) => Math.max(mx, __toMinHHMM__(r.end) || 0), __toMinHHMM__('19:30'));
        const start = __toHHMMfromMin__(Math.max(endMax, __toMinHHMM__('19:30')));
        const end = __addMinutesSafe__(start, 75);
        list.push({
          day,
          start,
          end,
          activity: 'Cena',
          from: 'Centro',
          to: 'Restaurante local',
          transport: 'A pie',
          duration: '1h15m',
          notes: 'Reserva sugerida si es sitio popular.'
        });
      }
      out.push(...list);
    });
    return out;
  }
}

/* ------------------------------------------------------------------
   Callers al API (INFO/PLANNER) con fallback robusto (si no existe)
------------------------------------------------------------------- */
if (typeof callApiChat !== 'function') {
  async function callApiChat(mode, payload = {}, { timeoutMs = 32000, retries = 0 } = {}) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ mode, ...payload })
      });
      clearTimeout(id);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      return data; // { text: "..." }
    } catch (e) {
      clearTimeout(id);
      if (retries > 0) return callApiChat(mode, payload, { timeoutMs, retries: retries - 1 });
      throw e;
    }
  }
}

/* ------------------------------------------------------------------
   Parse seguro de respuestas del API y unificador
------------------------------------------------------------------- */
if (typeof safeParseApiText !== 'function') {
  function safeParseApiText(txt) {
    if (!txt) return {};
    if (typeof txt === 'object') return txt;
    try { return JSON.parse(String(txt)); } catch { return { text: String(txt) }; }
  }
}
if (typeof unifyRowsFormat !== 'function') {
  function unifyRowsFormat(obj, city) {
    if (!obj) return { rows: [] };
    if (Array.isArray(obj.rows)) return obj;
    if (Array.isArray(obj?.itinerary?.rows)) return { rows: obj.itinerary.rows };
    // a veces viene como {days:[{day:1, rows:[...]}]}
    if (Array.isArray(obj.days)) {
      const rows = [];
      for (const d of obj.days) {
        const dayNum = Number(d.day) || 1;
        (d.rows || []).forEach(r => rows.push({ ...r, day: r.day || dayNum }));
      }
      return { rows };
    }
    return { rows: [] };
  }
}

/* ------------------------------------------------------------------
   VALIDACIÓN con agente (si no existe, pasa-through)
------------------------------------------------------------------- */
if (typeof validateRowsWithAgent !== 'function') {
  async function validateRowsWithAgent(city, rows, baseDate) {
    try {
      const resp = await callApiChat('planner', { validate: true, city, baseDate, rows }, { timeoutMs: 22000, retries: 0 });
      const parsed = safeParseApiText(resp?.text ?? resp);
      if (Array.isArray(parsed?.allowed)) return parsed;
      return { allowed: rows, rejected: [] };
    } catch {
      return { allowed: rows, rejected: [] };
    }
  }
}

/* ------------------------------------------------------------------
   (LEGACY-RESTORE) Semilla de PRIMERA FILA idéntica a la lógica vieja
   - Si un día está vacío (o sólo tiene placeholders inútiles), se inyecta
     una fila segura inicial ANTES del pipeline.
   - Respeta ventana perDay (DEFAULT_START/END) y no duplica si ya hay algo.
------------------------------------------------------------------- */
if (typeof __legacySeedFirstRowIfEmpty !== 'function') {
  function __legacySeedFirstRowIfEmpty(city, day, rows) {
    const list = Array.isArray(rows) ? rows.slice() : [];
    // ¿Ya hay contenido real?
    const hasReal = list.some(r => (r?.activity || '').trim());
    if (hasReal) return list;

    // Ventana segura
    const pd = (cityMeta?.[city]?.perDay || []).find(x => x.day === day) || {};
    const start = pd.start || (typeof DEFAULT_START !== 'undefined' ? DEFAULT_START : '08:30');
    const end   = __addMinutesSafe__(start, 45);

    // Semilla legacy “Desayuno”
    const seed = {
      day,
      start,
      end,
      activity: 'Desayuno',
      from: `Hotel (${city})`,
      to: 'Cafetería local',
      transport: 'A pie',
      duration: '45m',
      notes: 'Semilla inicial (legacy) para arrancar el día.'
    };
    return [seed];
  }
}

/* ------------------------------------------------------------------
   OPTIMIZACIÓN por día: INFO → PLANNER → pipeline coherente
   + LEGACY: aseguro PRIMERA FILA antes del pipeline si el día está vacío
------------------------------------------------------------------- */
async function optimizeDay(city, day) {
  const data = itineraries[city];
  const baseDate = data?.baseDate || cityMeta[city]?.baseDate || '';

  const rows = (data?.byDay?.[day] || []).map(r => ({
    day, start: r.start || '', end: r.end || '', activity: r.activity || '',
    from: r.from || '', to: r.to || '', transport: r.transport || '',
    duration: r.duration || '', notes: r.notes || '', _crossDay: !!r._crossDay
  }));

  // Protección de filas “fijas” (ej. Blue Lagoon)
  const protectedRows = rows.filter(r => {
    const act = (r.activity || '').toLowerCase();
    return act.includes('laguna azul') || act.includes('blue lagoon');
  });

  // (LEGACY) Si no hay filas reales, siembra la primera fila antes de cualquier agente
  let workingRows = __legacySeedFirstRowIfEmpty(city, day, rows);

  try {
    // 1) INFO
    const context = (typeof __collectPlannerContext__ === 'function') ? __collectPlannerContext__(city, day) : { city, day };
    const infoRaw = await callApiChat('info', { context }, { timeoutMs: 32000, retries: 1 });
    const infoData = (typeof infoRaw === 'object' && infoRaw) ? infoRaw : { text: String(infoRaw || '') };
    const research = safeParseApiText(infoData?.text ?? infoData);

    // 2) PLANNER
    const plannerRaw = await callApiChat('planner', { research_json: research }, { timeoutMs: 42000, retries: 1 });
    const plannerData = (typeof plannerRaw === 'object' && plannerRaw) ? plannerRaw : { text: String(plannerRaw || '') };
    const structured = safeParseApiText(plannerData?.text ?? plannerData) || {};

    const unified = unifyRowsFormat(structured, city);
    let finalRows = (unified?.rows || []).map(x => ({ ...x, day: x.day || day }));

    // Si el agente devolvió vacío, conservamos la semilla legacy
    if (!finalRows.length && workingRows.length) finalRows = workingRows.slice();

    // === PIPELINE COHERENTE (mismas transformaciones que en 15.2) ===
    finalRows = finalRows.map(normalizeDurationLabel);
    finalRows = finalRows.map(normalizeAuroraWindow);
    finalRows = enforceOneAuroraPerDay(finalRows);
    if (typeof enforceTransportAndOutOfTown === 'function') finalRows = enforceTransportAndOutOfTown(city, finalRows);
    finalRows = fixOverlaps(finalRows);
    finalRows = finalRows.map(r => __normalizeDayField__(city, r));
    if (protectedRows.length) {
      finalRows = [...finalRows, ...protectedRows].map(r => __normalizeDayField__(city, r));
      finalRows = fixOverlaps(finalRows);
    }
    finalRows = ensureReturnRow(city, finalRows);
    finalRows = clearTransportAfterReturn(city, finalRows);
    if (typeof injectDinnerIfMissing === 'function') finalRows = injectDinnerIfMissing(city, finalRows);
    finalRows = pruneGenericPerDay(finalRows);
    finalRows = __sortRowsTabsSafe__(finalRows);

    // VALIDACIÓN
    const val = await validateRowsWithAgent(city, finalRows, baseDate);
    if (typeof pushRows === 'function') pushRows(city, val.allowed, false);
    try { document.dispatchEvent(new CustomEvent('itbmo:rowsUpdated', { detail: { city } })); } catch (_) {}

    // Render inmediato si la ciudad optimizada es la activa
    try {
      if (typeof activeCity !== 'undefined' && activeCity === city) {
        if (typeof renderCityTabs === 'function') renderCityTabs();
        if (typeof setActiveCity === 'function') setActiveCity(city);
        if (typeof renderCityItinerary === 'function') renderCityItinerary(city);
      }
    } catch(_) {}

  } catch (e) {
    console.error('optimizeDay INFO→PLANNER error:', e);
    // Fallback conservador:
    let safeRows = (rows.length ? rows : workingRows).map(r => __normalizeDayField__(city, r));
    safeRows = fixOverlaps(ensureReturnRow(city, injectDinnerIfMissing(city, safeRows)));
    safeRows = clearTransportAfterReturn(city, safeRows);
    safeRows = __sortRowsTabsSafe__(safeRows);
    const val = await validateRowsWithAgent(city, safeRows, baseDate);
    if (typeof pushRows === 'function') pushRows(city, val.allowed, false);
    try { document.dispatchEvent(new CustomEvent('itbmo:rowsUpdated', { detail: { city } })); } catch (_) {}
    try {
      if (typeof activeCity !== 'undefined' && activeCity === city) {
        if (typeof renderCityTabs === 'function') renderCityTabs();
        if (typeof setActiveCity === 'function') setActiveCity(city);
        if (typeof renderCityItinerary === 'function') renderCityItinerary(city);
      }
    } catch(_) {}
  }
}

/* ==============================
   SECCIÓN 19 · Chat handler (global)
   v71.fix — Extensión de días estable + integración INFO→PLANNER
   - Mantiene flujos existentes (add/swap/move/etc.)
   - Rebalanceos y optimizaciones llaman a optimizeDay (que ya usa INFO→PLANNER)
   - Respeta y registra preferencias/condiciones del usuario
   - Patch v77.3 (quirúrgico): fix en render tras mover actividades
================================= */

/* Wrapper global para Info Agent usando API v43 (si no existe) */
if (typeof callInfoAgent !== 'function') {
  async function callInfoAgent(queryText) {
    try {
      const cityCtx = (typeof activeCity !== 'undefined' && activeCity) ? activeCity : (savedDestinations?.[0]?.city || '');
      const baseContext =
        (typeof __collectPlannerContext__ === 'function')
          ? __collectPlannerContext__(cityCtx || '', null, { question: queryText })
          : {
              city: cityCtx || '',
              question: queryText || '',
              preferences: plannerState?.preferences || {},
              meta: cityMeta?.[cityCtx] || {}
            };

      const resp = await callApiChat('info', { context: baseContext }, { timeoutMs: 28000, retries: 1 });
      const parsed = safeParseApiText(resp?.text ?? resp);

      // Preferimos texto llano si viene; si no, serializamos el JSON de research de forma amigable.
      if (typeof parsed === 'string') return parsed;
      if (parsed && typeof parsed.text === 'string') return parsed.text;
      return 'He obtenido la información. Si quieres, puedo usarla para ajustar tu itinerario.';
    } catch (e) {
      console.error('callInfoAgent error:', e);
      return 'No pude obtener la información en este momento. Intenta nuevamente o especifica más detalles.';
    }
  }
}

async function onSend(){
  const text = ($chatI.value||'').trim();
  if(!text) return;
  chatMsg(text,'user');
  $chatI.value='';

  // Colecta hotel/transporte
  if(collectingHotels){
    const city = savedDestinations[metaProgressIndex].city;

    // Resolver inteligentemente el hotel/zona (tolera typos, idiomas, landmarks)
    const res = resolveHotelInput(text, city);
    const resolvedHotel = res.text || text;

    // Detección de transporte (conserva tu lógica original)
    const transport = (/recom/i.test(text)) ? 'recomiéndame'
      : (/alquilad|rent|veh[ií]culo|coche|auto|carro/i.test(text)) ? 'vehículo alquilado'
      : (/metro|tren|bus|autob[uú]s|p[uú]blico/i.test(text)) ? 'transporte público'
      : (/uber|taxi|cabify|lyft/i.test(text)) ? 'otros (Uber/Taxi)'
      : '';

    upsertCityMeta({ city, hotel: resolvedHotel, transport });

    // Feedback al usuario según confianza del match
    if(res.resolvedVia==='url' || (res.confidence||0) >= 0.80){
      chatMsg(`🏨 Tomé <strong>${resolvedHotel}</strong> como tu referencia de hotel/zona en <strong>${city}</strong>.`, 'ai');
    }else if((res.confidence||0) >= 0.65){
      chatMsg(`🏨 Usaré <strong>${resolvedHotel}</strong> como referencia en <strong>${city}</strong> (interpretado por similitud). Si deseas otro, escríbelo con más detalle o pega el link.`, 'ai');
    }else{
      chatMsg(`🏨 Registré tu referencia para <strong>${city}</strong>. Si tienes el <em>link</em> del lugar exacto o el nombre preciso, compártelo para afinar distancias.`, 'ai');
    }

    // Activar preferAurora automáticamente si la ciudad es apta
    try{
      const canon = (typeof normalizeCityForGeo==='function') ? normalizeCityForGeo(city) : city;
      const coords = (typeof getCoordinatesForCity==='function') ? (getCoordinatesForCity(canon) || getCoordinatesForCity(city)) : null;
      const auroraCity = coords && (typeof isAuroraCityDynamic==='function') ? isAuroraCityDynamic(coords.lat, coords.lng) : false;

      if(!coords){
        const low = String(canon||city||'').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'');
        if(/\breikj?avik\b|\breikiavik\b|\breykiavik\b|\breykjavik\b/.test(low)) { if(!plannerState.preferences) plannerState.preferences={}; plannerState.preferences.preferAurora = true; }
        if(/\btroms[oø]\b|\btromso\b/.test(low)) { if(!plannerState.preferences) plannerState.preferences={}; plannerState.preferences.preferAurora = true; }
      }else if(auroraCity){
        if(!plannerState.preferences) plannerState.preferences = {};
        plannerState.preferences.preferAurora = true;
      }
    }catch(_){ /* no-op */ }

    metaProgressIndex++;
    askNextHotelTransport();
    return;
  }

  // Cambio de hotel
  const hotelChangeMatch = text.match(/^(?:hotel|zona|direcci[oó]n):?\s*(.+)$/i);
  if(hotelChangeMatch && activeCity){
    const newHotelRaw = hotelChangeMatch[1].trim();
    const city = activeCity;

    // Resolver también en cambios de hotel
    const res = resolveHotelInput(newHotelRaw, city);
    const newHotel = res.text || newHotelRaw;

    if(!cityMeta[city]) cityMeta[city] = { baseDate:null, hotel:'', transport:'', perDay:[] };
    const prevHotel = cityMeta[city].hotel || '';
    if(newHotel && newHotel !== prevHotel){
      cityMeta[city].hotel = newHotel;

      if(res.resolvedVia==='url' || (res.confidence||0) >= 0.80){
        chatMsg(`🏨 Actualicé el hotel/zona de <strong>${city}</strong> a <strong>${newHotel}</strong>. Reajustando itinerario…`, 'ai');
      }else if((res.confidence||0) >= 0.65){
        chatMsg(`🏨 Apliqué <strong>${newHotel}</strong> como nueva referencia en <strong>${city}</strong> (interpretado por similitud). Reajustando itinerario…`, 'ai');
      }else{
        chatMsg(`🏨 Actualicé tu referencia en <strong>${city}</strong>. Si tienes el link exacto, compártelo. Reajustando itinerario…`, 'ai');
      }

      showWOW(true,'Reequilibrando tras cambio de hotel…');
      await rebalanceWholeCity(city);
      showWOW(false);
      chatMsg('✅ Itinerario reequilibrado tras el cambio de hotel.','ai');
    } else {
      chatMsg('ℹ️ El hotel ya estaba configurado con esa información.','ai');
    }
    return;
  }

  const intent = intentFromText(text);

  // Day trip preferencia libre
  if(intent.type === 'free_edit' && /\b(tour de un d[ií]a|excursi[oó]n de un d[ií]a|viaje de un d[ií]a|escapada|salida de un d[ií]a)\b/i.test(text)){
    const city = activeCity || savedDestinations[0]?.city;
    if(city){
      if(!plannerState.preferences) plannerState.preferences = {};
      plannerState.preferences.preferDayTrip = true;
      chatMsg(`🧭 Consideraré una <strong>excursión de 1 día</strong> cerca de <strong>${city}</strong> si aporta valor.`, 'ai');
      await rebalanceWholeCity(city);
      return;
    }
  }

  // Preferencia de auroras
  if(intent.type === 'prefer_aurora'){
    const city = intent.city || activeCity || savedDestinations[0]?.city;
    if(city){
      if(!plannerState.preferences) plannerState.preferences = {};
      plannerState.preferences.preferAurora = true;
      chatMsg(`🌌 Priorizaré <strong>noches de auroras</strong> en <strong>${city}</strong> cuando sea plausible.`, 'ai');
      await rebalanceWholeCity(city);
      return;
    }
  }

  // Normalizar "un día más"
  if(intent && intent.type==='add_days'){
    const t = text.toLowerCase();
    const isOneMoreDay = /\b(me\s+quedo|quedarme)\s+un\s+d[ií]a\s+m[aá]s\b|\bun\s+d[ií]a\s+m[aá]s\b/.test(t);
    const tripMatch = t.match(/para\s+ir\s+a\s+([a-záéíóúüñ\s]+)$/i);
    if(isOneMoreDay || tripMatch){
      intent.type = 'add_day_end';
      intent.city = intent.city || activeCity;
      if(tripMatch) intent.dayTripTo = (tripMatch[1]||'').trim();
    }
  }

  /* ---------- Agregar varios días N>0 ---------- */
  if(intent.type==='add_days' && intent.city && intent.extraDays>0){
    const city = intent.city;
    showWOW(true,'Agregando días y reoptimizando…');

    ensureDays(city);

    // total ANTES de agregar (último día ORIGINAL)
    const byDayPre  = itineraries[city].byDay || {};
    const prevTotal = Object.keys(byDayPre).length || 0;

    // Marcar explícitamente el "último original" (histórico)
    itineraries[city].lastOriginalDay = prevTotal;

    // Forzar replan en rango y añadir días
    if (!plannerState.forceReplan) plannerState.forceReplan = {};
    plannerState.forceReplan[city] = true;

    addMultipleDaysToCity(city, intent.extraDays);

    // Ventanas seguras para todos los días nuevos
    if (!cityMeta[city]) cityMeta[city] = { perDay: [] };
    cityMeta[city].perDay = cityMeta[city].perDay || [];
    const ensureWindow = (d)=>{
      let pd = cityMeta[city].perDay.find(x=>x.day===d);
      if(!pd){ pd = {day:d, start:DEFAULT_START, end:DEFAULT_END}; cityMeta[city].perDay.push(pd); }
      if(!pd.start) pd.start = DEFAULT_START;
      if(!pd.end)   pd.end   = DEFAULT_END;
    };
    const total = Object.keys(itineraries[city].byDay||{}).length;
    for(let d=prevTotal+1; d<=total; d++) ensureWindow(d);

    // Día suave en el nuevo último día
    if(!plannerState.lightDayTarget) plannerState.lightDayTarget = {};
    plannerState.lightDayTarget[city] = total;

    // Reequilibrar rango completo (usa optimizeDay → INFO→PLANNER)
    await rebalanceWholeCity(city, { start: Math.max(1, prevTotal), end: total, dayTripTo: intent.dayTripTo||'' });

    // Garantía de completitud del último día
    if ((itineraries[city].byDay?.[total]||[]).length < 3) {
      await optimizeDay(city, total);
    }

    showWOW(false);
    chatMsg(`✅ Agregué ${intent.extraDays} día(s) a ${city}. Reoptimicé de D${prevTotal} a D${total} y marqué D${total} como "ligero pero COMPLETO".`, 'ai');
    return;
  }

  /* ---------- Agregar exactamente 1 día al final ---------- */
  if (intent.type === 'add_day_end' && intent.city) {
    const city = intent.city;
    showWOW(true, 'Insertando día y optimizando…');

    ensureDays(city);
    const byDay = itineraries[city].byDay || {};
    const days  = Object.keys(byDay).map(n => +n).sort((a,b)=>a-b);

    // total ANTES de insertar (último día ORIGINAL)
    const prevTotal = days.length || 0;
    itineraries[city].lastOriginalDay = prevTotal;

    // Forzar replan del rango
    if (!plannerState.forceReplan) plannerState.forceReplan = {};
    plannerState.forceReplan[city] = true;

    const numericPos = prevTotal + 1;
    insertDayAt(city, numericPos);

    // Ventanas seguras para {numericPos}
    if (!cityMeta[city]) cityMeta[city] = { perDay: [] };
    cityMeta[city].perDay = cityMeta[city].perDay || [];
    const ensureWindow = (d)=>{
      let pd = cityMeta[city].perDay.find(x=>x.day===d);
      if(!pd){ pd = {day:d, start:DEFAULT_START, end:DEFAULT_END}; cityMeta[city].perDay.push(pd); }
      if(!pd.start) pd.start = DEFAULT_START;
      if(!pd.end)   pd.end   = DEFAULT_END;
    };
    ensureWindow(numericPos);

    // Semilla opcional si el usuario pidió "para ir a X" — usa __addMinutesSafe__
    if (intent.dayTripTo) {
      const destTrip  = intent.dayTripTo;
      const baseStart = cityMeta[city]?.perDay?.find(x => x.day === numericPos)?.start || DEFAULT_START;
      pushRows(city, [{
        day: numericPos,
        start: baseStart,
        end: __addMinutesSafe__(baseStart, 60),
        activity: `Traslado a ${destTrip}`,
        from: `Hotel (${city})`,
        to: destTrip,
        transport: 'Tren/Bus',
        duration: '≈ 1h',
        notes: `Inicio del day trip desde el hotel en ${city} hacia ${destTrip}.`
      }], false);
    }

    const total = Object.keys(itineraries[city].byDay||{}).length;

    // Día suave en el nuevo último día
    if(!plannerState.lightDayTarget) plannerState.lightDayTarget = {};
    plannerState.lightDayTarget[city] = total;

    // Rebalancear desde el último día original hasta el final (optimizeDay nuevo)
    await rebalanceWholeCity(city, { start: Math.max(1, prevTotal), end: total });

    // Garantía de completitud del nuevo día
    if ((itineraries[city].byDay?.[total]||[]).length < 3) {
      await optimizeDay(city, total);
    }

    renderCityTabs();
    setActiveCity(city);
    renderCityItinerary(city);
    showWOW(false);
    chatMsg('✅ Día agregado y plan reoptimizado (primeros días intactos; el nuevo último día queda "ligero pero COMPLETO").', 'ai');
    return;
  }

  // Quitar día
  if(intent.type==='remove_day' && intent.city && Number.isInteger(intent.day)){
    showWOW(true,'Eliminando día…');
    removeDayAt(intent.city, intent.day);
    const totalDays = Object.keys(itineraries[intent.city].byDay||{}).length;
    for(let d=intent.day; d<=totalDays; d++) await optimizeDay(intent.city, d);
    renderCityTabs(); setActiveCity(intent.city); renderCityItinerary(intent.city);
    showWOW(false);
    chatMsg('✅ Día eliminado y plan reequilibrado.','ai');
    return;
  }

  // Intercambiar días
  if(intent.type==='swap_day' && intent.city){
    showWOW(true,'Intercambiando días…');
    swapDays(intent.city, intent.from, intent.to);
    await Promise.all([
      optimizeDay(intent.city, intent.from),
      optimizeDay(intent.city, intent.to)
    ]);
    renderCityTabs(); setActiveCity(intent.city); renderCityItinerary(intent.city);
    showWOW(false);
    chatMsg('✅ Intercambié el orden y optimicé ambos días.','ai');
    return;
  }

  // Mover actividad
  if(intent.type==='move_activity' && intent.city){
    showWOW(true,'Moviendo actividad…');
    moveActivities(intent.city, intent.fromDay, intent.toDay, intent.query||'');
    await Promise.all([
      optimizeDay(intent.city, intent.fromDay),
      optimizeDay(intent.city, intent.toDay)
    ]);
    renderCityTabs();
    setActiveCity(intent.city);
    // 🔧 FIX quirúrgico: antes usaba `renderCityItinerary(city)` con `city` indefinido
    renderCityItinerary(intent.city);
    showWOW(false);
    chatMsg('✅ Moví la actividad y optimicé los días implicados.','ai');
    return;
  }

  // Sustituir/Eliminar actividad
  if(intent.type==='swap_activity' && intent.city){
    const city = intent.city;
    const day  = itineraries[city]?.currentDay || 1;
    showWOW(true,'Ajustando actividades…');
    const q = intent.target ? intent.target.toLowerCase() : '';
    if(q){
      const before = itineraries[city].byDay[day]||[];
      itineraries[city].byDay[day] = before.filter(r => !String(r.activity||'').toLowerCase().includes(q));
    }
    await optimizeDay(city, day);
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    showWOW(false);
    chatMsg('✅ Sustituí la actividad y reoptimicé el día.','ai');
    return;
  }

  // Cambiar horas
  if(intent.type==='change_hours' && intent.city){
    showWOW(true,'Ajustando horarios…');
    const city = intent.city;
    const day = itineraries[city]?.currentDay || 1;
    if(!cityMeta[city]) cityMeta[city]={perDay:[]};
    let pd = cityMeta[city].perDay.find(x=>x.day===day);
    if(!pd){ pd = {day, start:DEFAULT_START, end:DEFAULT_END}; cityMeta[city].perDay.push(pd); }
    if(intent.range.start) pd.start = intent.range.start;
    if(intent.range.end)   pd.end   = intent.range.end;
    await optimizeDay(city, day);
    renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
    showWOW(false);
    chatMsg('✅ Ajusté los horarios y reoptimicé tu día.','ai');
    return;
  }

  // Agregar ciudad
  if(intent.type==='add_city' && intent.city){
    const name = intent.city.trim().replace(/\s+/g,' ').replace(/^./,c=>c.toUpperCase());
    const days = intent.days || 2;
    addCityRow({city:name, days:'', baseDate:intent.baseDate||''});
    const lastRow = $cityList.lastElementChild;
    const sel = lastRow?.querySelector('.days');
    if(sel){ sel.value = String(days); sel.dispatchEvent(new Event('change')); }
    saveDestinations();
    chatMsg(
      `✅ Añadí <strong>${name}</strong>. Dime tu <strong>hotel/zona</strong> (nombre, zona, dirección o link) y el <strong>medio de transporte</strong> (alquiler, público, taxi/uber, combinado o “recomiéndame”).`,
      'ai'
    );
    return;
  }

  // Eliminar ciudad
  if(intent.type==='remove_city' && intent.city){
    const name = intent.city.trim();
    savedDestinations = savedDestinations.filter(x=>x.city!==name);
    delete itineraries[name];
    delete cityMeta[name];
    renderCityTabs();
    chatMsg(`🗑️ Eliminé <strong>${name}</strong> de tu itinerario.`, 'ai');
    return;
  }

  // Preguntas informativas → usa Info Agent (independiente del plan) — ahora vía API v43
  if(intent.type==='info_query'){
    try{
      setChatBusy(true);
      const ans = await callInfoAgent(text);
      chatMsg(ans || '¿Algo más que quieras saber?','ai');
    } finally {
      setChatBusy(false);
    }
    return;
  }

  // Edición libre
  if(intent.type==='free_edit'){
    const city = activeCity || savedDestinations[0]?.city;
    if(!city){ chatMsg('Aún no hay itinerario en pantalla. Inicia la planificación primero.','ai'); return; }
    const day = itineraries[city]?.currentDay || 1;
    showWOW(true,'Aplicando tu cambio…');

    const data = itineraries[city];
    const dayRows = (data?.byDay?.[day]||[]).map(r=>`• ${r.start||''}-${r.end||''} ${r.activity}`).join('\n') || '(vacío)';
    const perDay = (cityMeta[city]?.perDay||[]).map(pd=>({day:pd.day, start:pd.start||DEFAULT_START, end:pd.end||DEFAULT_END}));

    const prompt = `
${FORMAT}
**Contexto (reducido si es posible):**
${buildIntakeLite(city)}

**Ciudad a editar:** ${city}
**Día visible:** ${day}
**Actividades del día:**
${dayRows}

**Ventanas por día:** ${JSON.stringify(perDay)}
**Instrucción del usuario (libre):** ${text}

🕒 Horarios:
- Base 08:30–19:00 si no hay ventana.
- Se puede extender por cenas/tours/auroras.
- Evita huecos > 60–75 min sin descanso/almuerzo/traslado.
- Buffers ≥15 min entre actividades.

- Integra lo pedido SIN borrar lo existente (fusión).
- Si no se especifica un día concreto, reacomoda toda la ciudad evitando duplicados.
- Devuelve formato B {"destination":"${city}","rows":[...],"replace": false}.
`.trim();

    // Conservamos callAgent/parseJSON/normalizeRow si existen (compatibilidad);
    // si no existen, hacemos fallback suave a reoptimización del día actual.
    let usedFallback = false;
    try {
      if (typeof callAgent === 'function' && typeof parseJSON === 'function') {
        const ans = await callAgent(prompt, true);
        const parsed = parseJSON(ans);

        if(parsed && (parsed.rows || parsed.destinations || parsed.itineraries)){
          let rows = [];
          if(parsed.rows) rows = parsed.rows.map(r=>normalizeRow(r));
          else if(parsed.destination===city && parsed.rows) rows = parsed.rows.map(r=>normalizeRow(r));
          else if(Array.isArray(parsed.destinations)){
            const dd = parsed.destinations.find(d=> (d.name||d.destination)===city);
            rows = (dd?.rows||[]).map(r=>normalizeRow(r));
          }else if(Array.isArray(parsed.itineraries)){
            const ii = parsed.itineraries.find(x=> (x.city||x.name||x.destination)===city);
            rows = (ii?.rows||[]).map(r=>normalizeRow(r));
          }
          const baseDate = data.baseDate || cityMeta[city]?.baseDate || '';
          const val = await validateRowsWithAgent(city, rows, baseDate);
          pushRows(city, val.allowed, false);

          const daysChanged = new Set(rows.map(r=>r.day).filter(Boolean));
          await Promise.all([...daysChanged].map(d=>optimizeDay(city, d)));

          renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
          showWOW(false);
          chatMsg('✅ Apliqué el cambio y reoptimicé los días implicados.','ai');
          return;
        } else {
          usedFallback = true;
        }
      } else {
        usedFallback = true;
      }
    } catch {
      usedFallback = true;
    }

    if (usedFallback) {
      await optimizeDay(city, day);
      renderCityTabs(); setActiveCity(city); renderCityItinerary(city);
      showWOW(false);
      chatMsg('⚠️ No pude aplicar la edición libre con el agente actual. Reoptimicé el día visible para mantener coherencia.', 'ai');
    }
    return;
  }
}

/* ==============================
   SECCIÓN 20 · Orden de ciudades + Eventos — RESTAURADA (patrón viejo + hook tardío)
   Restauración quirúrgica:
   - Volvemos a envolver addCityRow (como en el código viejo).
   - Hook de asignación tardía: si otra sección redefine addCityRow después,
     lo volvemos a envolver automáticamente.
   - Inyectamos controles de reorden en la fila recién creada.
   - Garantizamos la creación de la PRIMERA FILA si #city-list está vacío,
     con reintentos suaves durante la hidratación.
================================= */
function addRowReorderControls(row){
  if (!row || row.__reorderBound__) return; // evita duplicados
  row.__reorderBound__ = true;

  const ctrlWrap = document.createElement('div');
  ctrlWrap.style.display = 'flex';
  ctrlWrap.style.gap = '.35rem';
  ctrlWrap.style.alignItems = 'center';

  const up = document.createElement('button');
  up.textContent = '↑';
  up.className = 'btn ghost';
  const down = document.createElement('button');
  down.textContent = '↓';
  down.className = 'btn ghost';

  ctrlWrap.appendChild(up);
  ctrlWrap.appendChild(down);
  row.appendChild(ctrlWrap);

  // 🆙 Subir ciudad
  up.addEventListener('click', ()=>{
    const list = (typeof $cityList !== 'undefined' && $cityList) ? $cityList : document.querySelector('#city-list');
    if(!list) return;
    if(row.previousElementSibling){
      list.insertBefore(row, row.previousElementSibling);
      try { saveDestinations(); } catch(_) {}
    }
  });

  // ⬇️ Bajar ciudad
  down.addEventListener('click', ()=>{
    const list = (typeof $cityList !== 'undefined' && $cityList) ? $cityList : document.querySelector('#city-list');
    if(!list) return;
    if(row.nextElementSibling){
      list.insertBefore(row.nextElementSibling, row);
      try { saveDestinations(); } catch(_) {}
    }
  });
}

/* ========= Envoltorio clásico + hook tardío de addCityRow ========= */
(function restoreAndHookAddCityRow(){
  if (window.__ITBMO_ADDROW_HOOKED__) return;

  function wrap(fn){
    if (typeof fn !== 'function') return fn;
    if (fn.__wrapped_by_itbmo20__) return fn;

    function wrapped(){
      const res = fn.apply(this, arguments);
      try {
        const list = (typeof $cityList !== 'undefined' && $cityList) ? $cityList : document.querySelector('#city-list');
        if (list) {
          const newRow = list.querySelector('.city-row:last-of-type');
          if (newRow) addRowReorderControls(newRow);
        }
      } catch(_) {}
      return res;
    }
    wrapped.__wrapped_by_itbmo20__ = true;
    return wrapped;
  }

  // 1) Si ya existe, envolver ahora mismo
  if (typeof window.addCityRow === 'function') {
    window.addCityRow = wrap(window.addCityRow);
  }

  // 2) Hook: si otra sección asigna/reemplaza addCityRow luego, lo envolvemos automáticamente
  try {
    let _latest = (typeof window.addCityRow === 'function') ? window.addCityRow : null;
    Object.defineProperty(window, 'addCityRow', {
      configurable: true,
      enumerable: true,
      get(){ return _latest; },
      set(v){
        _latest = wrap(v);
      }
    });
  } catch(_){
    // Si el defineProperty falla (propiedad no configurable), haremos reintentos periódicos:
    const maxTries = 40, interval = 100;
    let tries = 0, t = setInterval(()=>{
      if (typeof window.addCityRow === 'function') {
        window.addCityRow = wrap(window.addCityRow);
        clearInterval(t);
      } else if (++tries >= maxTries) {
        clearInterval(t);
      }
    }, interval);
  }

  window.__ITBMO_ADDROW_HOOKED__ = true;
})();

/* ========= Garantizar PRIMERA FILA si #city-list está vacío (patrón viejo) ========= */
(function ensureFirstRowIfEmpty(){
  const MAX_TRIES = 30;  // ~3s a 100ms
  const INTERVAL  = 100;
  let tries = 0;

  function attempt(){
    const list = (typeof $cityList !== 'undefined' && $cityList) ? $cityList : document.querySelector('#city-list');
    if (!list) return false;

    const hasRow = !!list.querySelector('.city-row');
    if (!hasRow && typeof window.addCityRow === 'function') {
      window.addCityRow();
      const newRow = list.querySelector('.city-row:last-of-type');
      if (newRow) addRowReorderControls(newRow);
    }
    return true;
  }

  if (attempt()) return;

  const t = setInterval(()=>{
    if (attempt() || (++tries >= MAX_TRIES)) {
      clearInterval(t);
    }
  }, INTERVAL);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ()=>{ attempt(); }, { once:true });
  }
})();

/* ==============================
   SECCIÓN 21 · INIT y listeners — RESTAURADA (bootstrap legado 1ª fila)
   Mantiene v55.1 + FIX previos y añade bootstrap robusto
   que replica el comportamiento del código viejo:
   - Asegura $cityList/$start/$save si no existen.
   - Crea la PRIMERA FILA en frío si no hay ninguna,
     esperando a que addCityRow esté disponible.
   - No rompe la lógica de "Guardar destinos" → habilitar "Iniciar".
================================= */
$addCity?.addEventListener('click', ()=>addCityRow());

/* --- Helpers de fecha (tripleta -> DD/MM/AAAA) --- */
function __pad2__(n){ n=Number(n)||0; return String(n).padStart(2,'0'); }
function __year4__(y){ y=String(y||'').trim(); if(/^\d{2}$/.test(y)) return '20'+y; return /^\d{4}$/.test(y)? y : ''; }

function getTripletDateDMYFromRow(row){
  if(!row) return '';
  const d = (row.querySelector('.baseDay')   || {}).value;
  const m = (row.querySelector('.baseMonth') || {}).value;
  const y = (row.querySelector('.baseYear')  || {}).value;
  const dd = __pad2__(d), mm = __pad2__(m), yyyy = __year4__(y);
  if(!dd || !mm || !yyyy) return '';
  return `${dd}/${mm}/${yyyy}`;
}

function ensureHiddenBaseDateInRow(row){
  if(!row) return '';
  let base = (row.querySelector('.baseDate')||null);
  if(!base){
    base = document.createElement('input');
    base.type = 'text';
    base.className = 'baseDate';
    base.style.display = 'none'; // oculto, solo para compatibilidad con lógica existente
    row.appendChild(base);
  }
  const dmy = getTripletDateDMYFromRow(row);
  if(dmy) base.value = dmy;
  return base.value || '';
}

function syncAllRowsHiddenBaseDate(){
  const list = (typeof $cityList !== 'undefined' && $cityList) ? $cityList : document.querySelector('#city-list');
  const rows = list ? (list.querySelectorAll('.city-row') || []) : [];
  rows.forEach(r=> ensureHiddenBaseDateInRow(r));
}

/* --- Validaciones compatibles (tripleta o .baseDate) --- */
function validateBaseDatesDMY(){
  const list = (typeof $cityList !== 'undefined' && $cityList) ? $cityList : document.querySelector('#city-list');
  const rows = list ? (list.querySelectorAll('.city-row') || []) : [];
  let firstInvalid = null;

  for(const r of rows){
    const dmyTriplet = getTripletDateDMYFromRow(r);
    let value = dmyTriplet || (r.querySelector('.baseDate')?.value||'').trim();
    if(!value || !/^(\d{2})\/(\d{2})\/(\d{4})$/.test(value) || !parseDMY(value)){
      firstInvalid = r.querySelector('.baseYear') || r.querySelector('.baseMonth') || r.querySelector('.baseDay') || r.querySelector('.baseDate');
      if(firstInvalid){
        firstInvalid.classList?.add('shake-highlight');
        setTimeout(()=>firstInvalid?.classList?.remove('shake-highlight'), 800);
      }
      break;
    }
  }

  if(firstInvalid){
    const tooltip = document.createElement('div');
    tooltip.className = 'date-tooltip';
    tooltip.textContent = 'Por favor ingresa la fecha de inicio (DD/MM/AAAA) para cada ciudad 🗓️';
    document.body.appendChild(tooltip);
    const rect = firstInvalid.getBoundingClientRect();
    tooltip.style.left = rect.left + window.scrollX + 'px';
    tooltip.style.top  = rect.bottom + window.scrollY + 6 + 'px';
    setTimeout(() => tooltip.classList.add('visible'), 20);
    setTimeout(() => {
      tooltip.classList.remove('visible');
      setTimeout(() => tooltip.remove(), 300);
    }, 3500);
    firstInvalid.focus?.();
    return false;
  }
  return true;
}

/* --- Sincronización live tripleta -> .baseDate --- */
function bindDateTripletSync(){
  const list = (typeof $cityList !== 'undefined' && $cityList) ? $cityList : document.querySelector('#city-list');
  const container = list || document;
  container.addEventListener('input', (e)=>{
    const el = e.target;
    if(!el || !el.classList) return;
    if(el.classList.contains('baseDay') || el.classList.contains('baseMonth') || el.classList.contains('baseYear')){
      const row = el.closest('.city-row');
      if(row){
        const dmy = getTripletDateDMYFromRow(row);
        const base = row.querySelector('.baseDate');
        if(base){ base.value = dmy || ''; } else { ensureHiddenBaseDateInRow(row); }
        if($start && !formHasBasics()) $start.disabled = true;
      }
    }
  });
}

/* ===== Bootstrap legado: asegurar $cityList/$start/$save y PRIMERA FILA ===== */
(function legacyBootstrapFirstRow(){
  // Garantizar referencias globales como hacía el código viejo
  try {
    if (typeof window.$cityList === 'undefined' || !window.$cityList) {
      window.$cityList = document.querySelector('#city-list') || null;
    }
    if (typeof window.$start === 'undefined' || !window.$start) {
      window.$start = document.querySelector('#start-planning') || document.querySelector('#start') || null;
    }
    if (typeof window.$save === 'undefined' || !window.$save) {
      window.$save = document.querySelector('#save-destinations') || document.querySelector('#save') || null;
    }
  } catch(_) {}

  const MAX_TRIES = 40; // ~4s
  const INTERVAL  = 100;
  let tries = 0;

  function attempt(){
    // Revalidar punteros por si el DOM hidrata tarde
    if (!window.$cityList) window.$cityList = document.querySelector('#city-list') || null;

    const list = window.$cityList || document.querySelector('#city-list');
    if (!list) return false;

    const hasRow = !!list.querySelector('.city-row');
    if (!hasRow) {
      if (typeof window.addCityRow === 'function') {
        window.addCityRow();
        const newRow = list.querySelector('.city-row:last-of-type');
        if (newRow && typeof addRowReorderControls === 'function') addRowReorderControls(newRow);
        return true; // ya creamos la primera fila
      }
      return false; // aún no existe addCityRow; reintentar
    }
    return true; // ya había fila
  }

  // Intento inmediato
  if (attempt()) return;

  // Reintentos suaves
  const t = setInterval(()=>{
    if (attempt() || (++tries >= MAX_TRIES)) {
      clearInterval(t);
    }
  }, INTERVAL);

  // Fallback adicional al cargar DOM si aún no
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ()=>{ attempt(); }, { once:true });
  }
})();

/* ===== Guardar destinos: sólo aquí se evalúa habilitar “Iniciar planificación” ===== */
$save?.addEventListener('click', ()=>{
  try {
    syncAllRowsHiddenBaseDate();
    saveDestinations();
  } catch(_) {}

  const basicsOK = formHasBasics();
  const datesOK  = validateBaseDatesDMY();
  if (basicsOK && datesOK) {
    hasSavedOnce = true;
    if ($start) $start.disabled = false;
    try {
      document.dispatchEvent(new CustomEvent('itbmo:destinationsSaved', {
        detail: { savedDestinations: (typeof savedDestinations!=='undefined'? savedDestinations : []) }
      }));
    } catch(_) {}
  } else {
    if ($start) $start.disabled = true;
  }
});

/* --- Reglas de “form basics” compatibles con tripleta --- */
function formHasBasics(){
  const list = (typeof $cityList !== 'undefined' && $cityList) ? $cityList : document.querySelector('#city-list');
  const row = list ? list.querySelector('.city-row') : null;
  if(!row) return false;

  const city    = (row.querySelector('.city')?.value||'').trim();
  const country = (row.querySelector('.country')?.value||'').trim();
  const daysVal = (row.querySelector('.days')?.value||'0');
  const days    = parseInt(daysVal, 10);

  const dmyTriplet = getTripletDateDMYFromRow(row);
  let base = dmyTriplet || (row.querySelector('.baseDate')?.value||'').trim();

  if(dmyTriplet && !row.querySelector('.baseDate')){
    ensureHiddenBaseDateInRow(row);
  }

  return !!(city && country && days>0 && /^(\d{2})\/(\d{2})\/(\d{4})$/.test(base));
}

// Deshabilita start si rompen el formulario
document.addEventListener('input', (e)=>{
  if(!$start) return;
  const cl = e.target?.classList || {};
  if(cl.contains('city') || cl.contains('country') || cl.contains('days') ||
     cl.contains('baseDate') || cl.contains('baseDay') || cl.contains('baseMonth') || cl.contains('baseYear')){
    if(!formHasBasics()) $start.disabled = true;
  }
});

/* ===== Recuperación/inyector del botón Reset si no existe ===== */
function ensureResetButton(){
  let btn = document.getElementById('reset-planner');
  if(!btn){
    const bar = document.querySelector('#actions-bar') || document.body;
    btn = document.createElement('button');
    btn.id = 'reset-planner';
    btn.className = 'btn warn';
    btn.textContent = 'Reiniciar planificación';
    btn.setAttribute('type','button');
    (bar || document.body).appendChild(btn);
  }
  return btn;
}

// ⛔ Reset con confirmación modal (mantiene patrón viejo + reinsertar primera fila)
function bindReset(){
  const $btn = ensureResetButton();
  $btn.removeAttribute('disabled');

  $btn.addEventListener('click', ()=>{
    const overlay = document.createElement('div');
    overlay.className = 'reset-overlay';

    const modal = document.createElement('div');
    modal.className = 'reset-modal';
    modal.innerHTML = `
      <h3>¿Reiniciar planificación? 🧭</h3>
      <p>Esto eliminará todos los destinos, itinerarios y datos actuales.<br><strong>No se podrá deshacer.</strong></p>
      <div class="reset-actions">
        <button id="confirm-reset" class="btn warn">Sí, reiniciar</button>
        <button id="cancel-reset" class="btn ghost">Cancelar</button>
      </div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    setTimeout(()=>overlay.classList.add('active'), 10);

    const confirmReset = overlay.querySelector('#confirm-reset');
    const cancelReset  = overlay.querySelector('#cancel-reset');

    confirmReset.addEventListener('click', ()=>{
      const list = (typeof $cityList !== 'undefined' && $cityList) ? $cityList : document.querySelector('#city-list');

      if (list) list.innerHTML='';
      savedDestinations=[]; itineraries={}; cityMeta={};
      try { addCityRow(); } catch(_){ /* si aún no existe, lo hará el bootstrap */ }

      if ($start) $start.disabled = true;
      if (typeof $tabs!=='undefined') $tabs.innerHTML='';
      if (typeof $itWrap!=='undefined') $itWrap.innerHTML='';
      if (typeof $chatBox!=='undefined') $chatBox.style.display='none';
      if (typeof $chatM!=='undefined') $chatM.innerHTML='';

      session = []; hasSavedOnce=false; pendingChange=null;
      planningStarted = false;
      metaProgressIndex = 0;
      collectingHotels = false;
      isItineraryLocked = false;
      activeCity = null;

      try { $overlayWOW && ($overlayWOW.style.display = 'none'); } catch(_) {}
      document.querySelectorAll('.date-tooltip').forEach(t => t.remove());

      const setVal = (sel,val)=>{ const el=document.querySelector(sel); if(el) el.value=val; };
      setVal('#special-conditions','');
      setVal('#p-adults','1'); setVal('#p-young','0'); setVal('#p-children','0');
      setVal('#p-infants','0'); setVal('#p-seniors','0'); setVal('#budget',''); setVal('#currency','USD');

      if (typeof plannerState !== 'undefined') {
        plannerState.destinations = [];
        plannerState.specialConditions = '';
        plannerState.travelers = { adults:1, young:0, children:0, infants:0, seniors:0 };
        plannerState.budget = '';
        plannerState.currency = 'USD';
        plannerState.forceReplan = {};
        plannerState.preferences = {};
        plannerState.dayTripPending = {};
        plannerState.existingActs = {};
      }

      overlay.classList.remove('active');
      setTimeout(()=>overlay.remove(), 300);

      if (typeof $sidebar!=='undefined') $sidebar.classList.remove('disabled');
      const $infoFloating = document.querySelector('#info-chat-floating');
      if ($infoFloating){
        $infoFloating.style.pointerEvents = 'auto';
        $infoFloating.style.opacity = '1';
        $infoFloating.disabled = false;
      }
      if (typeof $resetBtn!=='undefined') $resetBtn.setAttribute('disabled','true');

      const firstCity = document.querySelector('.city-row .city');
      if (firstCity) firstCity.focus();

      try { document.dispatchEvent(new CustomEvent('itbmo:plannerReset')); } catch(_) {}
    });

    cancelReset.addEventListener('click', ()=>{
      overlay.classList.remove('active');
      setTimeout(()=>overlay.remove(), 300);
    });

    document.addEventListener('keydown', function escHandler(e){
      if(e.key === 'Escape'){
        overlay.classList.remove('active');
        setTimeout(()=>overlay.remove(), 300);
        document.removeEventListener('keydown', escHandler);
      }
    });
  });
}

// ▶️ Start: valida y ejecuta
$start?.addEventListener('click', ()=>{
  if(!$start) return;
  if(!hasSavedOnce){
    chatMsg('Primero pulsa “Guardar destinos” para continuar.','ai');
    return;
  }
  syncAllRowsHiddenBaseDate();
  if(!validateBaseDatesDMY()) return;

  try {
    document.dispatchEvent(new CustomEvent('itbmo:startPlanning', {
      detail: { destinations: (typeof savedDestinations!=='undefined'? savedDestinations : []) }
    }));
  } catch(_) {}

  startPlanning();
});
$send?.addEventListener('click', onSend);

// Chat: Enter envía (sin Shift)
$chatI?.addEventListener('keydown', e=>{
  if(e.key==='Enter' && !e.shiftKey){
    e.preventDefault();
    onSend();
  }
});

// CTA y upsell
$confirmCTA?.addEventListener('click', ()=>{ 
  isItineraryLocked = true;
  const upsell = document.querySelector('#monetization-upsell');
  if (upsell) upsell.style.display = 'flex';
});
$upsellClose?.addEventListener('click', ()=>{
  const upsell = document.querySelector('#monetization-upsell');
  if (upsell) upsell.style.display = 'none';
});

/* 🆕 Listener: Rebalanceo inteligente al agregar días (para integraciones internas) */
document.addEventListener('itbmo:addDays', e=>{
  const { city, extraDays, dayTripTo } = e.detail || {};
  if(!city || !extraDays) return;
  addMultipleDaysToCity(city, extraDays);
  const start = itineraries[city]?.originalDays || 1;
  const end   = (itineraries[city]?.originalDays || 0) + extraDays;
  rebalanceWholeCity(city, { start, end, dayTripTo });
});

/* ====== Info Chat (EXTERNO, totalmente independiente) ====== */
/* 🔒 SHIM QUIRÚRGICO: define cliente público PROPIO (no toca callInfoAgent del planner) */
function __ensureInfoAgentClient__(){
  window.__ITBMO_API_BASE     = window.__ITBMO_API_BASE     || "https://itravelbymyown-api.vercel.app";
  window.__ITBMO_INFO_PUBLIC  = window.__ITBMO_INFO_PUBLIC  || "/api/info-public";

  const mustCreate = (fn)=>{
    if(typeof fn !== 'function') return true;
    if(fn.__source !== 'external-public-v1') return true;
    if(fn.__usesContext__ !== false) return true;
    return false;
  };

  if (mustCreate(window.callInfoAgentPublic)) {
    const simpleInfoPublic = async function(userText){
      const url = `${window.__ITBMO_API_BASE}${window.__ITBMO_INFO_PUBLIC}`;
      let resp;
      try{
        resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type":"application/json", "Accept":"application/json" },
          body: JSON.stringify({ input: String(userText || "") })
        });
      }catch(_){
        return "No pude traer la respuesta del Info Chat correctamente. Verifica tu API en Vercel o intenta de nuevo.";
      }
      try{
        const data = await resp.json();
        let txt = (typeof data?.text === 'string') ? data.text : '';
        if(!txt || /^\s*\{/.test(txt)) {
          try {
            const j = JSON.parse(txt);
            if(j && (j.rationale || j.summary)) return String(j.rationale || j.summary);
            if(j && j.destination) return `Información de ${j.destination} lista. Pregúntame algo concreto.`;
            txt = "He obtenido datos estructurados. Dime qué deseas saber y te lo explico en simple.";
          } catch { txt = "He obtenido datos. Dime qué deseas saber y te lo explico en simple."; }
        }
        return txt;
      }catch{
        try { return await resp.text(); } catch { return "⚠️ No se obtuvo respuesta del asistente."; }
      }
    };
    simpleInfoPublic.__usesContext__ = false;
    simpleInfoPublic.__source = 'external-public-v1';
    window.callInfoAgentPublic = simpleInfoPublic;
  }
}

function openInfoModal(){ const m=document.querySelector('#info-chat-modal'); if(!m) return; m.style.display='flex'; m.classList.add('active'); }
function closeInfoModal(){ const m=document.querySelector('#info-chat-modal'); if(!m) return; m.classList.remove('active'); m.style.display='none'; }

/* === Typing indicator (tres puntitos) — minimal JS, sin depender de CSS especial === */
function __infoTypingOn__(){
  const box = document.querySelector('#info-chat-messages') || document.querySelector('#info-chat-modal .messages') || document.querySelector('#info-chat-body');
  if(!box) return;
  if(document.getElementById('info-typing')) return;
  const b = document.createElement('div');
  b.id = 'info-typing';
  b.className = 'bubble ai typing';
  b.setAttribute('aria-live','polite');
  b.textContent = '...';
  box.appendChild(b);
  let i = 0;
  b.__timer = setInterval(()=>{
    i = (i+1)%3;
    b.textContent = '.'.repeat(i+1);
  }, 400);
  box.scrollTop = box.scrollHeight;
}
function __infoTypingOff__(){
  const b = document.getElementById('info-typing');
  if(!b) return;
  if(b.__timer) clearInterval(b.__timer);
  b.remove();
}

async function sendInfoMessage(){
  const input = document.querySelector('#info-chat-input'); const btn = document.querySelector('#info-chat-send');
  if(!input || !btn) return; const txt = (input.value||'').trim(); if(!txt) return;
  infoChatMsg(txt,'user'); input.value=''; input.style.height='auto';

  __infoTypingOn__();
  try{
    const ans = await (window.callInfoAgentPublic ? window.callInfoAgentPublic(txt) : Promise.resolve('No hay cliente público configurado.'));
    let out = ans;
    if(typeof ans === 'object') out = ans.text || JSON.stringify(ans);
    if(typeof out === 'string' && /^\s*\{/.test(out)){
      try{
        const j = JSON.parse(out);
        out = j.rationale || j.summary || 'Tengo la información. Pregúntame en lenguaje natural y te respondo fácil.';
      }catch{}
    }
    __infoTypingOff__();
    infoChatMsg(out || 'No tengo la respuesta exacta. Reformula la pregunta y lo vuelvo a intentar.');
  }catch(_){
    __infoTypingOff__();
    infoChatMsg('No pude obtener respuesta del asistente ahora mismo. Intenta de nuevo.', 'ai');
  }
}

function bindInfoChatListeners(){
  const toggleTop = document.querySelector('#info-chat-toggle');
  const toggleFloating = document.querySelector('#info-chat-floating');
  const close  = document.querySelector('#info-chat-close');
  const send   = document.querySelector('#info-chat-send');
  const input  = document.querySelector('#info-chat-input');

  toggleTop?.replaceWith(toggleTop?.cloneNode?.(true) || toggleTop);
  toggleFloating?.replaceWith(toggleFloating?.cloneNode?.(true) || toggleFloating);
  close?.replaceWith(close?.cloneNode?.(true) || close);
  send?.replaceWith(send?.cloneNode?.(true) || send);

  const tTop = document.querySelector('#info-chat-toggle');
  const tFloat = document.querySelector('#info-chat-floating');
  const c2 = document.querySelector('#info-chat-close');
  const s2 = document.querySelector('#info-chat-send');
  const i2 = document.querySelector('#info-chat-input');

  [tTop, tFloat].forEach(btn=>{
    btn?.addEventListener('click', (e)=>{ e.preventDefault(); openInfoModal(); });
  });
  c2?.addEventListener('click', (e)=>{ e.preventDefault(); closeInfoModal(); });
  s2?.addEventListener('click', (e)=>{ e.preventDefault(); sendInfoMessage(); });

  i2?.addEventListener('keydown', (e)=>{
    if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendInfoMessage(); }
  });

  if(i2){
    i2.setAttribute('rows','1');
    i2.style.overflowY = 'hidden';
    const maxRows = 10;
    i2.addEventListener('input', ()=>{
      i2.style.height = 'auto';
      const lh = parseFloat(window.getComputedStyle(i2).lineHeight) || 20;
      const lines = Math.min(i2.value.split('\n').length, maxRows);
      i2.style.height = `${lh * lines + 8}px`;
      i2.scrollTop = i2.scrollHeight;
    });
  }

  document.addEventListener('click', (e)=>{
    const el = e.target.closest('#info-chat-toggle, #info-chat-floating');
    if(el){ e.preventDefault(); openInfoModal(); }
  });
}

// Inicialización (guard anti-doble init)
document.addEventListener('DOMContentLoaded', ()=>{
  if(window.__ITBMO_SECTION21_READY__) return;
  window.__ITBMO_SECTION21_READY__ = true;

  // (LEGACY) asegurar referencias y primera fila por si llegamos aquí sin ella
  try {
    if (!window.$cityList) window.$cityList = document.querySelector('#city-list') || null;
  } catch(_) {}
  (function ensureFirstRowDOMReady(){
    const list = window.$cityList || document.querySelector('#city-list');
    if (!list) return;
    if (!list.querySelector('.city-row') && typeof window.addCityRow === 'function') {
      window.addCityRow();
    }
  })();

  if(!document.querySelector('#city-list .city-row')) {
    // si no se logró aún, el bootstrap de la Sección 20 seguirá reintentando
  }

  // Vincula sincronización tripleta -> .baseDate
  bindDateTripletSync();
  // Primera sincronización por si ya hay valores precargados
  syncAllRowsHiddenBaseDate();

  // Aísla Info Chat externo antes de listeners SIN sobrescribir callInfoAgent del planner
  __ensureInfoAgentClient__();

  bindInfoChatListeners();
  bindReset();
  if ($start) $start.disabled = !hasSavedOnce;
});

