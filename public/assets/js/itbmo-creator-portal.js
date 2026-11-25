(() => {
  const languageKey = 'itbmo_site_language';
  const requestedLanguage = new URLSearchParams(location.search).get('lang');
  let savedLanguage;
  try { savedLanguage = localStorage.getItem(languageKey); } catch {}
  const lang = ['es', 'en'].includes(requestedLanguage)
    ? requestedLanguage
    : savedLanguage === 'en' ? 'en' : 'es';
  const en = lang === 'en';
  const t = (es, english) => en ? english : es;
  const el = id => document.getElementById(id);
  const money = new Intl.NumberFormat(lang, { style: 'currency', currency: 'USD' });
  const usd = cents => money.format(Number(cents || 0) / 100);
  const date = value => new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value));
  const storageKey = 'itbmo_creator_session_token';
  let token = sessionStorage.getItem(storageKey) || localStorage.getItem('itbmo_session_token');

  document.documentElement.lang = lang;
  document.title = t('I Travel By My Own · Colaboradores', 'I Travel By My Own · Creator portal');
  el('language').setAttribute('aria-label', t('Idioma', 'Language'));
  for (const button of el('language').querySelectorAll('[data-site-lang]')) {
    const targetLanguage = button.dataset.siteLang;
    const active = targetLanguage === lang;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
    button.addEventListener('click', () => {
      try { localStorage.setItem(languageKey, targetLanguage); } catch {}
      if (active) return;
      const url = new URL(location.href);
      url.searchParams.set('lang', targetLanguage);
      location.assign(url.href);
    });
  }
  if (en) {
    el('title').firstChild.textContent = 'Inspire their ';
    el('title').querySelector('span').textContent = 'next trip.';
    el('home').href = '/english';
    el('home-button').href = '/english';
    el('home-button').textContent = 'Home';
    el('intro').textContent = 'Your audience gets a discount on their itinerary. You earn a commission when someone buys with your code.';
    el('register').textContent = 'Create my ITBMO account';
    el('register').href = '/planner.html?lang=en&mode=register';
    el('enroll-title').textContent = 'Activate your creator code';
    el('enroll-offer').textContent = 'Test offer: your audience gets 10% off the current price and you earn USD 0.30 per eligible purchase.';
    el('enroll-name').textContent = 'Display name';
    el('enroll-email').textContent = 'PayPal Sandbox email';
    el('enroll').textContent = 'Generate my code';
    el('access-title').textContent = 'Creator portal';
    el('access-description').textContent = 'Sign in with your ITBMO account to get your code and track your commissions.';
    el('access-preview').textContent = 'Portal preview. Sandbox sign-in will open once the test environment is connected.';
    el('destination').textContent = 'Torres del Paine, Patagonia';
    el('steps').setAttribute('aria-label', 'How it works');
    el('step-code').textContent = 'Get your code';
    el('step-code-description').textContent = 'Generated once and linked to your account.';
    el('step-share').textContent = 'Share your link';
    el('step-share-description').textContent = 'Your audience opens it with the discount ready to apply.';
    el('step-results').textContent = 'Track your earnings';
    el('step-results-description').textContent = 'See purchases, generated itineraries, and payouts in your dashboard.';
    el('dashboard').setAttribute('aria-label', 'Account statement');
    el('email-label').textContent = 'Email';
    el('password-label').textContent = 'Password';
    el('signin').textContent = 'Sign in';
  }

  async function request(action, data = {}) {
    const response = await fetch('/api/payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, action, session_token: token })
    });
    return response.json();
  }

  function section(title) {
    const node = document.createElement('section');
    node.className = 'card';
    const heading = document.createElement('h2');
    heading.textContent = title;
    node.append(heading);
    el('dashboard').append(node);
    return node;
  }

  function table(container, labels, rows) {
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    const tableNode = document.createElement('table');
    const header = tableNode.createTHead().insertRow();
    for (const label of labels) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = label;
      header.append(cell);
    }
    const body = tableNode.createTBody();
    for (const values of rows) {
      const row = body.insertRow();
      for (const value of values) {
        const cell = row.insertCell();
        if (value instanceof Node) cell.append(value);
        else cell.textContent = value;
      }
    }
    if (!rows.length) {
      const cell = body.insertRow().insertCell();
      cell.colSpan = labels.length;
      cell.textContent = t('Aún no hay registros.', 'No records yet.');
    }
    wrap.append(tableNode);
    container.append(wrap);
  }

  function creatorLink(code) {
    const url = new URL('/planner.html', location.origin);
    url.search = new URLSearchParams({ lang, promo: code });
    const link = document.createElement('a');
    link.href = url;
    link.textContent = t('Abrir enlace', 'Open link');
    return link;
  }

  function render(summary) {
    el('dashboard').replaceChildren();
    el('dashboard').hidden = false;
    const balance = section(summary.name);
    const stats = document.createElement('div');
    stats.className = 'stats';
    for (const [label, value] of [
      [t('Comisión acumulada', 'Total commission'), summary.total_commission_cents],
      [t('Pendiente', 'Pending'), summary.pending_cents],
      [t('Disponible', 'Available'), summary.available_cents],
      [t('Pagado', 'Paid'), summary.paid_cents]
    ]) {
      const item = document.createElement('div');
      const amount = document.createElement('strong');
      amount.textContent = usd(value);
      item.append(label, amount);
      stats.append(item);
    }
    balance.append(stats);

    table(section(t('Códigos', 'Codes')), [
      t('Código', 'Code'), t('Descuento', 'Discount'), t('Estado', 'Status'),
      t('Visitas registradas', 'Tracked visits'), t('Compras', 'Purchases'), t('Itinerarios generados', 'Generated itineraries'), t('Enlace', 'Link')
    ], summary.codes.map(code => [
      code.code, code.type === 'percentage' ? code.discount + '%' : usd(Number(code.discount) * 100),
      code.active ? t('Activo', 'Active') : t('Inactivo', 'Inactive'),
      code.visits, code.sales, code.generated, creatorLink(code.code)
    ]));

    table(section(t('Últimas 100 ventas con comisión', 'Latest 100 commissionable sales')), [
      t('Fecha', 'Date'), t('Código', 'Code'), t('Venta', 'Sale'), t('Comisión', 'Commission'),
      t('Ajuste', 'Adjustment'), t('Elegible desde', 'Eligible from')
    ], summary.sales.map(sale => [
      date(sale.created_at), sale.code, usd(sale.sale_cents), usd(sale.commission_cents),
      usd(-sale.reversed_cents), date(sale.eligible_at)
    ]));

    const labels = {
      prepared: t('Preparado', 'Prepared'), submitting: t('Enviando', 'Submitting'),
      processing: t('Procesando', 'Processing'), paid: t('Pagado', 'Paid'),
      failed: t('Fallido', 'Failed'), returned: t('Devuelto', 'Returned'), review: t('En revisión', 'Under review')
    };
    table(section(t('Últimas 24 liquidaciones', 'Latest 24 payouts')), [
      t('Período', 'Period'), t('Importe', 'Amount'), t('Estado', 'Status'), t('Referencia PayPal', 'PayPal reference')
    ], summary.payouts.map(payout => [
      payout.period.slice(0, 7), usd(payout.amount_cents), labels[payout.state], payout.provider_batch_id || '—'
    ]));
  }

  const errors = {
    CREATOR_ENROLLMENT_UNAVAILABLE: t('Para generar tu código, necesitas una cuenta activa y verificada de ITBMO.', 'You need an active, verified ITBMO account to generate a code.'),
    REGISTERED_SESSION_REQUIRED: t('Inicia sesión con tu cuenta registrada de ITBMO.', 'Sign in with your registered ITBMO account.'),
    CREATOR_ACCESS_REQUIRED: t('Esta cuenta todavía no tiene acceso al programa.', 'This account does not have access to the program yet.'),
    CREATOR_PORTAL_UNAVAILABLE: t('El portal aún no está habilitado en este entorno.', 'The portal is not enabled in this environment yet.'),
    CREATOR_OR_CODE_EXISTS: t('El colaborador o el código ya existe.', 'The creator or code already exists.'),
    VERIFIED_PROFILE_OR_MARGIN_REQUIRED: t('Verifica que la cuenta esté registrada y que la comisión sea menor que el precio con descuento.', 'Check that the account is verified and the commission is below the discounted price.'),
    INVALID_CREATOR_AGREEMENT: t('Revisa los datos del colaborador.', 'Check the creator details.')
  };
  const unavailable = t('No pudimos cargar el portal.', 'We could not load the portal.');

  async function init() {
    try {
      const data = await request('creator_summary');
      const preview = data.code === 'CREATOR_PORTAL_UNAVAILABLE';
      el('access-preview').hidden = !preview;
      el('login-form').hidden = preview;
      el('notice').textContent = preview ? '' : data.ok
        ? t('Entorno de pruebas PayPal Sandbox', 'PayPal Sandbox test environment')
        : errors[data.code] || unavailable;
      el('access').hidden = data.ok || data.code === 'CREATOR_ACCESS_REQUIRED';
      el('login-fields').disabled = data.code !== 'REGISTERED_SESSION_REQUIRED';
      el('register').hidden = data.code !== 'REGISTERED_SESSION_REQUIRED';
      el('enrollment').hidden = !data.ok || Boolean(data.summary) || Boolean(data.is_admin);
      el('entry').hidden = data.ok && Boolean(data.summary || data.is_admin);
      el('steps').hidden = el('entry').hidden;
      if (data.summary) render(data.summary);
      if (data.is_admin) el('admin').hidden = false;
    } catch {
      el('notice').textContent = unavailable;
    }
  }

  el('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    el('signin').disabled = true;
    el('notice').textContent = t('Iniciando sesión…', 'Signing in…');
    try {
      const response = await fetch('/api/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...Object.fromEntries(new FormData(form)), action: 'creator_sign_in' })
      });
      const data = await response.json();
      if (response.ok && data.ok && data.session_token) {
        form.reset();
        token = data.session_token;
        sessionStorage.setItem(storageKey, token);
        await init();
      } else {
        el('notice').textContent = errors[data.code] || (response.status === 401
          ? t('Revisa tu correo y contraseña.', 'Check your email and password.')
          : unavailable);
      }
    } catch {
      el('notice').textContent = unavailable;
    } finally {
      el('signin').disabled = false;
    }
  });

  if (en) {
    for (const [key, label] of Object.entries({
      name: 'Display name', code: 'Code', email: 'Verified ITBMO account email',
      payout_email: 'Creator PayPal Sandbox email', discount: 'Discount (%)', commission: 'Fixed commission (USD cents)'
    })) document.querySelector('[data-field="' + key + '"]').textContent = label;
    el('save').textContent = el('admin-title').textContent = 'Create creator';
  }

  el('enroll-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    el('enroll').disabled = true;
    try {
      const result = await request('creator_enroll', Object.fromEntries(new FormData(form)));
      if (result.ok) {
        form.reset();
        await init();
      } else {
        el('notice').textContent = errors[result.code] || unavailable;
      }
    } catch {
      el('notice').textContent = unavailable;
    } finally {
      el('enroll').disabled = false;
    }
  });

  el('creator-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    el('save').disabled = true;
    try {
      const result = await request('creator_create', Object.fromEntries(new FormData(form)));
      el('admin-result').textContent = result.ok
        ? t('Colaborador creado. Código ', 'Creator created. Code ') + result.code
        : errors[result.code] || unavailable;
      if (result.ok) form.reset();
    } catch {
      el('admin-result').textContent = unavailable;
    } finally {
      el('save').disabled = false;
    }
  });
  void init();
})();
