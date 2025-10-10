/* ============================================================
   ITravelByMyOwn Planner — Webflow ↔️ Vercel (final, estable)
   Archivo: /public/planner-chat.js
   - Sin HTML dentro del JS (evita "Unexpected token <")
   - Carga después de Webflow (usa defer en el tag)
   - Inicializa fila de "Cities & Days" y enlaza todos los botones
   ============================================================ */

(function () {
  'use strict';

  // ==== Utilidad DOM ====
  const qs  = (s, ctx = document) => ctx.querySelector(s);
  const qsa = (s, ctx = document) => Array.from(ctx.querySelectorAll(s));

  // ==== Espera DOM listo de forma robusta ====
  function domReady() {
    return new Promise((resolve) => {
      if (document.readyState === 'complete' || document.readyState === 'interactive') {
        resolve();
      } else {
        document.addEventListener('DOMContentLoaded', resolve, { once: true });
      }
    });
  }

  // ==== Estado global (en RAM) ====
  const API_URL = 'https://itravelbymyown-api.vercel.app/api/chat';
  const travelerIds = ['p-adults', 'p-young', 'p-children', 'p-infants', 'p-seniors'];

  let savedDestinations = []; // [{city, days, order}]
  let itineraries = {};       // itineraries[city] = { byDay:{1:[rows],...}, currentDay:1, baseDate:'DD/MM/YYYY' }
  let cityMeta = {};          // cityMeta[city] = { baseDate, start, end, hotel }
  let session = [];           // historial para el backend
  let activeCity = null;

  // Control de conversación
  let planningStarted = false;
  let metaProgressIndex = 0;
  let collectingMeta = false;
  let awaitingMetaReply = false;
  let batchGenerating = false;
  let globalReviewAsked = false;

  // Hints
  let lastMenuHintTs = 0;

  function hintMenuOnce() {
    const now = Date.now();
    if (now - lastMenuHintTs > 180000) { // 3 min
      msg(tone.menuHint);
      lastMenuHintTs = now;
    }
  }

  // ==== Idioma / tono ====
  function detectLang() {
    const n = (navigator.language || 'en').toLowerCase();
    if (n.startsWith('es')) return 'es';
    if (n.startsWith('pt')) return 'pt';
    if (n.startsWith('fr')) return 'fr';
    return 'en';
  }

  const tone = {
    es: {
      hi: '¡Bienvenido! 👋 Soy tu concierge de viajes personal.',
      startMeta: (city) =>
        `Comencemos por **${city}**. Indícame en un solo texto: fecha del primer día (DD/MM/AAAA), horas de inicio y fin para CADA día (pueden ser iguales) y hotel o zona.`,
      contMeta: (city) =>
        `Continuemos con **${city}**. En un único texto: fecha del primer día (DD/MM/AAAA), horas de inicio y fin diarias y hotel o zona donde te alojas.`,
      focus: () => ``,
      review: (city) => `Listo, aquí tienes el itinerario para **${city}**. ¿Quieres que haga algún ajuste o lo dejamos así?`,
      nextAsk: (city) =>
        `Perfecto. Pasemos a **${city}**. ¿Me compartes la fecha del primer día, horas de inicio/fin y hotel/zona?`,
      menuHint:
        'Para info más detallada (clima, transporte, restaurantes, etc.) usa los botones del menú inferior 👇',
      welcomeFlow:
        'Te guiaré ciudad por ciudad. Si aún no tienes datos de hotel/horarios, propongo el mejor plan y luego lo ajustamos.'
    },
    en: {
      hi: "Welcome! 👋 I’m your personal travel concierge.",
      startMeta: (city) =>
        `Let’s start with **${city}**. In one message: day-1 date (DD/MM/YYYY), daily start/end times (they can match), and your hotel/area.`,
      contMeta: (city) =>
        `Let’s continue with **${city}**. In one message: day-1 date (DD/MM/YYYY), daily start/end times, and hotel/area.`,
      focus: () => ``,
      review: (city) => `Here’s **${city}**. Any changes or keep it as is?`,
      nextAsk: (city) =>
        `Great. Let’s move to **${city}**. Share day-1 date, daily start/end times, and hotel/area.`,
      menuHint:
        'For more detail (weather, transport, restaurants,…) use the bottom toolbar 👇',
      welcomeFlow:
        'I’ll guide you city-by-city. If you don’t have hotel/times yet, I’ll propose and adjust later.'
    },
    fr: {
      hi: 'Bienvenue ! 👋 Je suis votre concierge de voyage.',
      startMeta: (city) =>
        `Commençons par **${city}** : date du 1er jour (JJ/MM/AAAA), heures de début/fin par jour, hôtel/quartier.`,
      contMeta: (city) =>
        `Continuons avec **${city}** : date du 1er jour, heures quotidiennes début/fin et hôtel/quartier.`,
      focus: () => ``,
      review: (city) => `Voici **${city}**. Des modifications à faire ?`,
      nextAsk: (city) =>
        `Parfait. Passons à **${city}** : date du 1er jour, heures début/fin quotidiennes et hôtel/quartier.`,
      menuHint:
        'Pour plus de détails (météo, transports, restaurants…), utilisez la barre en bas 👇',
      welcomeFlow:
        'Je vous guide ville par ville. Sans infos, je propose puis j’ajuste.'
    },
    pt: {
      hi: 'Bem-vindo! 👋 Sou o seu concierge de viagens.',
      startMeta: (city) =>
        `Vamos começar por **${city}**. Em uma mensagem: data do 1º dia (DD/MM/AAAA), horários diários de início/fim e hotel/bairro.`,
      contMeta: (city) =>
        `Vamos continuar com **${city}**. Em uma mensagem: data do 1º dia, horários diários e hotel/bairro.`,
      focus: () => ``,
      review: (city) => `Aqui está **${city}**. Deseja alguma alteração?`,
      nextAsk: (city) =>
        `Perfeito. Vamos para **${city}**. Informe data do 1º dia, horários início/fim e hotel/bairro.`,
      menuHint:
        'Para mais detalhes (clima, transporte, restaurantes etc.), use a barra inferior 👇',
      welcomeFlow:
        'Vou guiá-lo cidade a cidade. Se não tiver os dados, proponho e ajusto.'
    }
  }[detectLang()];

  // ==== Selectores (se crean tras DOM listo) ====
  let $cities, $addCity, $save, $start, $chatC, $chatM, $intake, $send, $tabs, $itineraryWrap, $intro;

  // ==== Mensajería Chat ====
  function msg(text, who = 'ai') {
    if (!$chatM) return;
    if (!text) return;
    const div = document.createElement('div');
    div.className = 'chat-message ' + (who === 'user' ? 'user' : 'ai');

    // Ocultar JSON/estructura
    if (/\"(activity|destination|byDay|start|end)\"/.test(text) || text.trim().startsWith('{')) {
      text = '✅ Itinerario actualizado en la interfaz.';
    }
    if (text.length > 1200) text = text.slice(0, 1200) + '…';

    div.innerHTML = text
      .replace(/\n/g, '<br>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    $chatM.appendChild(div);
    $chatM.scrollTop = $chatM.scrollHeight;
  }

  // ==== Backend (robusto a distintos “shapes”) ====
  async function callAgent(inputText) {
    const context = {
      itinerary: getItineraryContext(),
      meta: getCityMetaContext()
    };

    const attempts = [
      { body: { message: inputText, context } },
      { body: { messages: [{ role: 'user', content: inputText }], context } },
      { body: { input: inputText, context } }
    ];

    for (let i = 0; i < attempts.length; i++) {
      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(attempts[i].body)
        });
        if (!res.ok) continue;

        const ctype = (res.headers.get('content-type') || '').toLowerCase();
        const payload = ctype.includes('application/json') ? await res.json() : await res.text();
        const raw = extractReplyAsText(payload);

        if (raw) {
          if (/^\s*\{[\s\S]*\}\s*$/.test(raw) || /```json/.test(raw) || /<json>/.test(raw)) {
            return raw;
          }
          if (/itinerario|día|actividades/i.test(raw) && raw.length > 120) {
            return '{"followup":"He actualizado el itinerario correctamente."}';
          }
          return raw;
        }
      } catch (_) {
        // intenta siguiente shape
      }
    }
    return '{"followup":"⚠️ No se pudo contactar el asistente."}';
  }

  function extractReplyAsText(payload) {
    try {
      if (payload == null) return '';
      if (typeof payload === 'string') return payload;

      if (typeof payload.reply === 'string') return payload.reply;
      if (typeof payload.text === 'string') return payload.text;
      if (typeof payload.message === 'string') return payload.message;

      if (Array.isArray(payload.choices) && payload.choices.length) {
        const c = payload.choices[0];
        if (c?.message?.content) return String(c.message.content);
        if (typeof c?.text === 'string') return c.text;
      }

      if (payload.data) {
        if (typeof payload.data === 'string') return payload.data;
        if (typeof payload.data.content === 'string') return payload.data.content;
      }
      return JSON.stringify(payload);
    } catch {
      return '';
    }
  }

  function parseJSON(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {}
    const m1 = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```([\s\S]*?)```/i);
    if (m1 && m1[1]) {
      try {
        return JSON.parse(m1[1]);
      } catch {}
    }
    const m2 = text.match(/<json>\s*([\s\S]*?)\s*<\/json>/i);
    if (m2 && m2[1]) {
      try {
        return JSON.parse(m2[1]);
      } catch {}
    }
    try {
      const cleaned = text.replace(/^[^\{]+/, '').replace(/[^\}]+$/, '');
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }

  // ==== Fechas ====
  function parseDMY(str) {
    if (!str) return null;
    const mFull = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    const mShort = str.match(/^(\d{1,2})[\/\-](\d{1,2})(?![\/\-]\d{4})$/);

    let day, month, year;
    const now = new Date();
    const currentYear = now.getFullYear();

    if (mFull) {
      day = Number(mFull[1]);
      month = Number(mFull[2]) - 1;
      year = Number(mFull[3]);
    } else if (mShort) {
      day = Number(mShort[1]);
      month = Number(mShort[2]) - 1;
      year = currentYear;
      const temp = new Date(year, month, day);
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (temp < today) year = currentYear + 1;
    } else {
      return null;
    }

    const date = new Date(year, month, day);
    if (date.getMonth() !== month || date.getDate() !== day) return null;
    return date;
  }

  function formatDMY(d) {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = d.getFullYear();
    return `${dd}/${mm}/${yy}`;
  }

  function addDays(d, n) {
    const x = new Date(d.getTime());
    x.setDate(x.getDate() + n);
    return x;
  }

  // ==== UI — Cities & Days ====
  function rebuildOrderOptions() {
    const rows = qsa('.city-row', $cities);
    const total = rows.length;
    rows.forEach((row, idx) => {
      const sel = qs('.city-order', row);
      const cur = sel.value || idx + 1;
      sel.innerHTML = '';
      for (let i = 1; i <= total; i++) {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = `${i}º`;
        sel.appendChild(opt);
      }
      sel.value = Math.min(cur, total);
    });
  }

  function addCityRow(data = { city: '', days: '', order: null }) {
    const row = document.createElement('div');
    row.className = 'city-row';
    row.innerHTML = `
      <div>
        <label>City</label>
        <input class="city-name" type="text" placeholder="City or Country" value="${data.city || ''}">
      </div>
      <div>
        <label>Days</label>
        <input class="city-days" type="number" min="1" placeholder="e.g. 3" value="${data.days || ''}">
      </div>
      <div>
        <label>Visit order</label>
        <select class="city-order"></select>
      </div>
      <div style="align-self:end;">
        <button class="remove" type="button" title="Remove">✖</button>
      </div>
    `.trim();

    qs('.remove', row).addEventListener('click', () => {
      row.remove();
      rebuildOrderOptions();
      validateSave();
    });

    $cities.appendChild(row);
    rebuildOrderOptions();
    if (data.order) qs('.city-order', row).value = String(data.order);
  }

  function validateSave() {
    const rows = qsa('.city-row', $cities);
    const ok =
      rows.length > 0 &&
      rows.every((r) => {
        const name = qs('.city-name', r).value.trim();
        const days = parseInt(qs('.city-days', r).value, 10);
        return name && days > 0;
      });
    if ($save) $save.disabled = !ok;
    if ($start) $start.disabled = savedDestinations.length === 0;
  }

  // ==== Guardar destinos / sincronizar estado ====
  function saveDestinations() {
    const rows = qsa('.city-row', $cities);
    const list = rows
      .map((r) => ({
        city: qs('.city-name', r).value.trim(),
        days: Math.max(1, parseInt(qs('.city-days', r).value, 10) || 0),
        order: parseInt(qs('.city-order', r).value, 10)
      }))
      .filter((x) => x.city);

    list.sort((a, b) => a.order - b.order);
    savedDestinations = list;

    savedDestinations.forEach(({ city, days }) => {
      if (!itineraries[city]) itineraries[city] = { byDay: {}, currentDay: 1, baseDate: null };
      if (!cityMeta[city]) cityMeta[city] = { baseDate: null, start: null, end: null, hotel: '' };
      const existingDays = Object.keys(itineraries[city].byDay).length;
      if (existingDays < days) {
        for (let d = existingDays + 1; d <= days; d++) {
          itineraries[city].byDay[d] = itineraries[city].byDay[d] || [];
        }
      } else if (existingDays > days) {
        const trimmed = {};
        for (let d = 1; d <= days; d++) trimmed[d] = itineraries[city].byDay[d] || [];
        itineraries[city].byDay = trimmed;
        if (itineraries[city].currentDay > days) itineraries[city].currentDay = days;
      }
    });

    Object.keys(itineraries).forEach((c) => {
      if (!savedDestinations.find((x) => x.city === c)) delete itineraries[c];
    });
    Object.keys(cityMeta).forEach((c) => {
      if (!savedDestinations.find((x) => x.city === c)) delete cityMeta[c];
    });

    renderCityTabs();
    msg('🟪 Saved your cities & days. Click "Start Planning" when you are ready.');
    if ($start) $start.disabled = savedDestinations.length === 0;
  }

  // ==== Tabs + Render Itinerary ====
  function setActiveCity(name) {
    if (!name) return;
    activeCity = name;
    qsa('.city-tab', $tabs).forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.city === name);
    });
  }

  function renderCityTabs() {
    const prev = activeCity;
    $tabs.innerHTML = '';
    savedDestinations.forEach(({ city }) => {
      const b = document.createElement('button');
      b.className = 'city-tab' + (city === prev ? ' active' : '');
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
      const validCity =
        prev && savedDestinations.some((x) => x.city === prev) ? prev : savedDestinations[0].city;
      setActiveCity(validCity);
      renderCityItinerary(validCity);
    } else {
      $intro.style.display = '';
      $itineraryWrap.innerHTML = '';
      activeCity = null;
    }
  }

  function renderCityItinerary(city) {
    if (!city || !itineraries[city]) return;
    const data = itineraries[city];
    const days = Object.keys(data.byDay || {})
      .map((d) => parseInt(d, 10))
      .sort((a, b) => a - b);

    $itineraryWrap.innerHTML = '';
    if (!days.length) {
      $itineraryWrap.innerHTML = '<p>No activities yet. The assistant will fill them in.</p>';
      return;
    }

    const base = parseDMY(data.baseDate || (cityMeta[city]?.baseDate || ''));
    const sections = [];

    days.forEach((dayNum) => {
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
        </table>
      `.trim();

      const tb = qs('tbody', sec);
      (data.byDay[dayNum] || []).forEach((r) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${r.start || ''}</td><td>${r.end || ''}</td><td>${r.activity || ''}</td>
          <td>${r.from || ''}</td><td>${r.to || ''}</td><td>${r.transport || ''}</td>
          <td>${r.duration || ''}</td><td>${r.notes || ''}</td>
        `.trim();
        tb.appendChild(tr);
      });

      $itineraryWrap.appendChild(sec);
      sections.push(sec);
    });

    const pager = document.createElement('div');
    pager.className = 'pager';
    const prevBtn = document.createElement('button');
    prevBtn.textContent = '«';
    const nextBtn = document.createElement('button');
    nextBtn.textContent = '»';
    pager.appendChild(prevBtn);
    days.forEach((d) => {
      const b = document.createElement('button');
      b.textContent = d;
      b.dataset.day = d;
      pager.appendChild(b);
    });
    pager.appendChild(nextBtn);
    $itineraryWrap.appendChild(pager);

    function show(n) {
      sections.forEach((sec, i) => (sec.style.display = days[i] === n ? 'block' : 'none'));
      qsa('button', pager).forEach((x) => x.classList.remove('active'));
      const btn = qsa('button', pager).find((x) => x.dataset.day == String(n));
      if (btn) btn.classList.add('active');
      prevBtn.classList.toggle('ghost', n === days[0]);
      nextBtn.classList.toggle('ghost', n === days[days.length - 1]);
      if (itineraries[city]) itineraries[city].currentDay = n;
    }

    pager.addEventListener('click', (ev) => {
      const t = ev.target;
      if (t === prevBtn) {
        show(Math.max(days[0], (itineraries[city]?.currentDay || days[0]) - 1));
      } else if (t === nextBtn) {
        show(Math.min(days.at(-1), (itineraries[city]?.currentDay || days[0]) + 1));
      } else if (t.dataset.day) {
        show(Number(t.dataset.day));
      }
    });

    show(itineraries[city]?.currentDay || days[0]);
  }

  // ==== Serialización para el agente ====
  function getItineraryContext() {
    const snapshot = Object.fromEntries(
      Object.entries(itineraries).map(([city, data]) => {
        const days = Object.fromEntries(
          Object.entries(data.byDay).map(([d, rows]) => [
            d,
            rows.map((r) => ({
              day: Number(d),
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
        return [city, { days, baseDate: data.baseDate || null }];
      })
    );
    return JSON.stringify(snapshot);
  }

  function getCityMetaContext() {
    return JSON.stringify(cityMeta);
  }

  // ==== Intake / formato JSON deseado ====
  function buildIntake() {
    const list = savedDestinations
      .map((x) => `${x.city} (${x.days} days, order ${x.order})`)
      .join(' | ');
    const pax = travelerIds.map((id) => `${id.replace('p-', '')}:${qs('#' + id).value || 0}`).join(', ');
    const stay = (qs('#stay-name').value || '').trim();
    const address = (qs('#stay-address').value || '').trim();
    const budget = Number(qs('#budget').value || 0);
    const currency = qs('#currency').value || 'USD';
    return [
      `Destinations (order): ${list}`,
      `Travelers: ${pax}`,
      `Accommodation: ${stay ? stay + ' - ' : ''}${address}`,
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

  // ==== Generación por ciudad ====
  async function generateCityItinerary(city) {
    const conf = cityMeta[city] || {};
    const days = savedDestinations.find((x) => x.city === city)?.days || 1;
    const baseDate = conf.baseDate || '';
    const start = conf.start || '09:00';
    const end = conf.end || '17:00';
    const hotel = conf.hotel || '';

    const instructions = `
${FORMAT}
Eres un planificador experto, cálido y empático (concierge premium). Genera el itinerario SOLO para "${city}" con ${days} días.
- Prioriza IMPERDIBLES de la ciudad.
- Si hay tiempo, sugiere excursiones cercanas con transporte recomendado.
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
        const hadRowsBefore = Object.values(itineraries[city]?.byDay || {}).some((a) => a.length > 0);
        applyParsedToState(parsed, !hadRowsBefore);

        if (itineraries[city] && baseDate) itineraries[city].baseDate = baseDate;

        setActiveCity(city);
        renderCityItinerary(city);

        if (parsed.followup && !collectingMeta && !batchGenerating) {
          msg(parsed.followup.replace(/\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)\b/g, city), 'ai');
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
    batchGenerating = true;
    for (const { city } of savedDestinations) {
      const m = cityMeta[city];
      const hasRows = Object.values(itineraries[city]?.byDay || {}).some((a) => a.length > 0);
      if (metaIsComplete(m) && !hasRows) {
        await generateCityItinerary(city);
      }
    }
    batchGenerating = false;

    if (!globalReviewAsked) {
      globalReviewAsked = true;
      msg('✨ Todos los itinerarios fueron generados. ¿Deseas revisarlos o ajustar alguno?', 'ai');
    }
  }

  // ==== Merge helpers ====
  function dedupeInto(arr, row) {
    const key = (o) =>
      [o.day, o.start || '', o.end || '', (o.activity || '').trim().toLowerCase()].join('|');
    const has = arr.find((x) => key(x) === key(row));
    if (!has) arr.push(row);
  }

  function ensureDays(city) {
    const byDay = itineraries[city].byDay || {};
    const presentDays = Object.keys(byDay).map((n) => parseInt(n, 10));
    const maxPresent = presentDays.length ? Math.max(...presentDays) : 0;
    const saved = savedDestinations.find((x) => x.city === city)?.days || 0;
    const want = Math.max(saved, maxPresent);
    const have = presentDays.length;

    if (have < want) {
      for (let d = have + 1; d <= want; d++) itineraries[city].byDay[d] = itineraries[city].byDay[d] || [];
    }
    if (have > want) {
      const trimmed = {};
      for (let d = 1; d <= want; d++) trimmed[d] = byDay[d] || [];
      itineraries[city].byDay = trimmed;
    }
  }

  function pushRows(city, rows, replace = false) {
    if (!itineraries[city]) itineraries[city] = { byDay: {}, currentDay: 1, baseDate: null };
    if (replace) itineraries[city].byDay = {};
    rows.forEach((r) => {
      const d = Math.max(1, parseInt(r.day || 1, 10));
      if (!itineraries[city].byDay[d]) itineraries[city].byDay[d] = [];
      const row = {
        day: d,
        start: r.start || '',
        end: r.end || '',
        activity: r.activity || '',
        from: r.from || '',
        to: r.to || '',
        transport: r.transport || '',
        duration: r.duration || '',
        notes: r.notes || ''
      };
      dedupeInto(itineraries[city].byDay[d], row);
    });
    ensureDays(city);
  }

  function upsertCityMeta(meta) {
    const name =
      meta.city ||
      activeCity ||
      savedDestinations[metaProgressIndex]?.city ||
      savedDestinations[0]?.city;
    if (!name) return;
    if (!cityMeta[name]) cityMeta[name] = { baseDate: null, start: null, end: null, hotel: '' };
    if (meta.baseDate) cityMeta[name].baseDate = meta.baseDate;
    if (meta.start) cityMeta[name].start = meta.start;
    if (meta.end) cityMeta[name].end = meta.end;
    if (typeof meta.hotel === 'string') cityMeta[name].hotel = meta.hotel;
    if (itineraries[name] && meta.baseDate) {
      itineraries[name].baseDate = meta.baseDate;
    }
  }

  function applyParsedToState(parsed, forceReplaceAll = false) {
    const rootReplace = Boolean(parsed.replace) || forceReplaceAll;

    if (parsed.meta && parsed.meta.city) {
      upsertCityMeta(parsed.meta);
    }

    if (Array.isArray(parsed.destinations)) {
      parsed.destinations.forEach((d) => {
        if (d.meta && d.meta.city) upsertCityMeta(d.meta);
        const name = d.name || d.meta?.city || activeCity || savedDestinations[0]?.city || 'General';
        const destReplace = rootReplace || Boolean(d.replace);
        pushRows(name, d.rows || [], destReplace);
      });
      return;
    }

    if (parsed.destination && Array.isArray(parsed.rows)) {
      const name = parsed.destination || activeCity || savedDestinations[0]?.city || 'General';
      pushRows(name, parsed.rows, rootReplace);
      return;
    }

    if (Array.isArray(parsed.rows)) {
      const fallback = activeCity || savedDestinations[0]?.city || 'General';
      pushRows(fallback, parsed.rows, rootReplace);
    }
  }

  // ==== Utilidades de edición / NL ====
  function normalize(t) {
    return t
      .toLowerCase()
      .replaceAll('á', 'a')
      .replaceAll('é', 'e')
      .replaceAll('í', 'i')
      .replaceAll('ó', 'o')
      .replaceAll('ú', 'u');
  }

  function extractInt(str) {
    const m = str.match(/\b(\d{1,2})\b/);
    if (m) return Math.max(1, parseInt(m[1], 10));
    if (/\bun\b|\buno\b|\buna\b/.test(str)) return 1;
    return 1;
  }

  function parseTimesFromText(text) {
    const times = [];
    let tnorm = text
      .toLowerCase()
      .replace(/\s+de\s+la\s+manana/g, 'am')
      .replace(/\s+de\s+la\s+tarde/g, 'pm')
      .replace(/\s+de\s+la\s+noche/g, 'pm')
      .replace(/\s*y\s+media/g, ':30')
      .replace(/\s*y\s+cuarto/g, ':15')
      .replace(/\s*y\s+45/g, ':45')
      .replace(/(\d)\shoras?/g, '$1h')
      .replace(/(\d)\s*h/g, '$1h')
      .replace(/(\d{3,4})\s*(am|pm)?/g, (_, num, ap) => {
        if (num.length === 3) return num[0] + ':' + num.slice(1) + (ap || '');
        if (num.length === 4) return num.slice(0, 2) + ':' + num.slice(2) + (ap || '');
        return _;
      });

    const re = /(\b\d{1,2}(:\d{2})?\s*(am|pm|h)?\b)/gi;
    let m;
    while ((m = re.exec(tnorm)) !== null) {
      let t = m[1].trim().toLowerCase();
      let ampm = /(am|pm)$/.exec(t)?.[1];
      t = t.replace(/(am|pm|h)$/, '');
      if (!t.includes(':')) t = t + ':00';
      let [h, mi] = t.split(':').map((x) => parseInt(x, 10));
      if (ampm === 'pm' && h < 12) h += 12;
      if (ampm === 'am' && h === 12) h = 0;
      const HH = String(Math.max(0, Math.min(23, h))).padStart(2, '0');
      const MM = String(Math.max(0, Math.min(59, mi || 0))).padStart(2, '0');
      times.push(`${HH}:${MM}`);
    }
    return times;
  }

  function updateSavedDays(city, newDays) {
    const idx = savedDestinations.findIndex((x) => x.city === city);
    if (idx >= 0) {
      savedDestinations[idx] = { ...savedDestinations[idx], days: Math.max(1, newDays) };
    }
  }

  // ==== Chat principal ====
  function userWantsReplace(text) {
    const t = (text || '').toLowerCase();
    return /(sustituye|reemplaza|cambia todo|replace|overwrite|desde cero|todo nuevo)/i.test(t);
  }

  function isAcceptance(text) {
    const t = (text || '').toLowerCase().trim();
    return /(^|\b)(ok|listo|esta bien|perfecto|de acuerdo|vale|sounds good|looks good|c’est bon|tout bon|beleza|ta bom)\b/.test(
      t
    );
  }

  async function askForNextCityMeta() {
    if (awaitingMetaReply) return;

    if (metaProgressIndex >= savedDestinations.length) {
      collectingMeta = false;
      msg('Perfecto 🎉 Ya tengo toda la información. Generando itinerarios...');
      await maybeGenerateAllCities();
      return;
    }

    const city = savedDestinations[metaProgressIndex].city;
    activeCity = city;
    const isFirst = metaProgressIndex === 0;
    awaitingMetaReply = true;

    msg(isFirst ? tone.startMeta(city) : tone.contMeta(city));
  }

  async function generateInitial() {
    if (savedDestinations.length === 0) {
      alert('Por favor agrega las ciudades primero y guarda los destinos.');
      return;
    }
    $chatC.style.display = 'flex';
    planningStarted = true;
    metaProgressIndex = 0;
    collectingMeta = true;
    awaitingMetaReply = false;
    batchGenerating = false;
    globalReviewAsked = false;

    session = [
      {
        role: 'system',
        content:
          'Eres un planificador/concierge de viajes internacional: cálido, empático y culturalmente adaptable. Devuelves itinerarios en JSON limpio con el formato solicitado.'
      },
      { role: 'user', content: buildIntake() }
    ];

    msg(`${tone.hi} ${tone.welcomeFlow}`);
    await askForNextCityMeta();
  }

  async function sendChat() {
    const text = ($intake.value || '').trim();
    if (!text) return;
    msg(text, 'user');
    $intake.value = '';

    // Fase meta secuencial
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
          msg('Perfecto 🎉 Ya tengo toda la información. Generando itinerarios...');
          await maybeGenerateAllCities();
        }
      } else {
        msg('No logré entender. ¿Podrías repetir la fecha del primer día, horarios y hotel/zona?');
      }
      return;
    }

    // Conversación normal
    const tNorm = normalize(text);
    let handled = false;

    // a) Agregar días (+posible actividad)
    if (
      /\b(agrega|añade|sumar?|add)\b.*\bd[ií]a/.test(tNorm) ||
      /\b(un dia mas|1 dia mas)\b/.test(tNorm)
    ) {
      const addN = extractInt(tNorm);
      const hasActivity = /\b(tour|excursion|visita|museo|paseo|segovia|toledo|montserrat|catedral|parque|mercado|playa|ruta)\b/i.test(
        text
      );
      const activityDesc = hasActivity ? text : null;

      if (activeCity) {
        const current =
          savedDestinations.find((x) => x.city === activeCity)?.days ||
          Object.keys(itineraries[activeCity]?.byDay || {}).length ||
          1;
        const newDays = current + addN;
        updateSavedDays(activeCity, newDays);
        ensureDays(activeCity);

        if (hasActivity) {
          const prompt = `
${FORMAT}
Edita el itinerario de "${activeCity}" agregando ${addN} día${addN > 1 ? 's' : ''}.
Incluye como actividad principal: "${activityDesc}" en el/los día(s) nuevo(s) y completa con otras actividades no repetidas.
No elimines días previos.
Devuelve SOLO JSON con "destination":"${activeCity}".`.trim();
          const ans = await callAgent(prompt);
          const parsed = parseJSON(ans);
          if (parsed) {
            applyParsedToState(parsed, false);
          }
        } else {
          await generateCityItinerary(activeCity);
        }

        renderCityTabs();
        setActiveCity(activeCity);
        renderCityItinerary(activeCity);
        msg(`He añadido ${addN} día${addN > 1 ? 's' : ''} en ${activeCity}.`);
      }
      handled = true;
    }

    // b) Quitar días
    if (!handled && (/\b(quita|elimina|remueve|remove)\b.*\bd[ií]a/.test(tNorm) || /\b(ultimo|último)\s+d[ií]a\b/i.test(tNorm))) {
      const remN = /\b\d+\b/.test(tNorm) ? extractInt(tNorm) : 1;
      const targetCity = activeCity;
      if (targetCity) {
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
        msg(`He quitado ${remN} día${remN > 1 ? 's' : ''} en ${targetCity}.`);
      }
      handled = true;
    }

    // c) Ajuste de horas naturales
    if (!handled && /\b(hora|horario|inicio|fin|empieza|termina|ajusta|cambia)\b/.test(tNorm)) {
      const times = parseTimesFromText(text);
      const targetCity = activeCity;
      if (targetCity && times.length) {
        cityMeta[targetCity] = cityMeta[targetCity] || {
          baseDate: null,
          start: null,
          end: null,
          hotel: ''
        };
        if (times.length === 1) {
          if (/\b(hasta|termina|fin)\b/.test(tNorm)) cityMeta[targetCity].end = times[0];
          else cityMeta[targetCity].start = times[0];
        } else {
          cityMeta[targetCity].start = times[0];
          cityMeta[targetCity].end = times[times.length - 1];
        }
        await generateCityItinerary(targetCity);
        renderCityTabs();
        setActiveCity(targetCity);
        renderCityItinerary(targetCity);
        msg(`He ajustado las horas en ${targetCity}.`);
      }
      handled = true;
    }

    // d) Recalcular
    if (!handled && /\b(recalcula|replanifica|recompute|replan|recalculate|actualiza|regen|optimiza)\b/.test(tNorm)) {
      const targetCity = activeCity;
      if (targetCity) {
        await generateCityItinerary(targetCity);
        renderCityTabs();
        setActiveCity(targetCity);
        renderCityItinerary(targetCity);
        msg(`He recalculado el itinerario de ${targetCity}.`);
      }
      handled = true;
    }

    if (handled) {
      await checkAndGenerateMissing();
      return;
    }

    // e) Edición libre (fallback)
    session.push({ role: 'user', content: text });
    const cityHint = activeCity ? `Active city: ${activeCity}` : '';
    const prompt = `
${FORMAT}
Edit the current plan. ${cityHint}
Scope: Modifica SOLO la ciudad activa o la mencionada por el usuario; no toques otras ciudades.
Existing plan (keep & adjust): ${getItineraryContext()}
Existing meta (per city): ${getCityMetaContext()}
Si el usuario pide añadir/ajustar actividades o destinos, responde con B/C/A. No envíes texto plano.
Solicitud: ${text}`.trim();

    try {
      const ans = await callAgent(prompt);
      const parsed = parseJSON(ans);
      if (parsed) {
        applyParsedToState(parsed, false);
        renderCityTabs();
        setActiveCity(activeCity);
        renderCityItinerary(activeCity);
        msg(parsed.followup || '¿Deseas otro ajuste?', 'ai');
      } else {
        msg(ans || 'Listo. ¿Otra cosa?', 'ai');
      }
      await checkAndGenerateMissing();
    } catch (e) {
      console.error(e);
      msg('❌ Error de conexión.', 'ai');
    }
  }

  async function checkAndGenerateMissing() {
    for (const { city } of savedDestinations) {
      const m = cityMeta[city];
      const hasRows = Object.values(itineraries[city]?.byDay || {}).some((a) => a.length > 0);
      if (typeof metaIsComplete === 'function' && metaIsComplete(m) && !hasRows) {
        await generateCityItinerary(city);
      }
    }
  }

  // ==== Arranque ====
  domReady().then(() => {
    // Vincula referencias del DOM
    $cities = qs('#cities-container');
    $addCity = qs('#add-city');
    $save = qs('#save-destinations');
    $start = qs('#start-planning');
    $chatC = qs('#chat-container');
    $chatM = qs('#chat-messages');
    $intake = qs('#intake');
    $send = qs('#send-btn');
    $tabs = qs('#city-tabs');
    $itineraryWrap = qs('#itinerary-container');
    $intro = qs('#itinerary-intro');

    // Validación de presencia mínima
    if (
      !$cities ||
      !$addCity ||
      !$save ||
      !$start ||
      !$tabs ||
      !$itineraryWrap ||
      !$intro
    ) {
      console.error('Planner: faltan nodos requeridos en el DOM.');
      return;
    }

    // Estado inicial UI
    if ($chatC) $chatC.style.display = 'none';
    if ($start) $start.disabled = true;

    // Eventos
    $addCity.addEventListener('click', () => {
      addCityRow();
      validateSave();
    });

    $cities.addEventListener('input', validateSave);
    $save.addEventListener('click', saveDestinations);

    // Fila inicial (clave para que veas inmediatamente la estructura)
    addCityRow();
    validateSave();

    if ($start) $start.addEventListener('click', generateInitial);
    if ($send) $send.addEventListener('click', sendChat);
    if ($intake) {
      $intake.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          sendChat();
        }
      });
    }

    // UX guard para botón "Start Planning"
    $start.addEventListener(
      'click',
      (ev) => {
        if (savedDestinations.length === 0) {
          ev.preventDefault();
          alert('Please add cities & days and press "Save Destinations" first.');
        }
      },
      { capture: true }
    );

    console.log('🟢 Planner JS cargado y listo.');
  });
})();
