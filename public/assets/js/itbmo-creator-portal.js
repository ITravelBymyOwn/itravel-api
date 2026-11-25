(() => {
  const params = new URLSearchParams(location.search);
  const en = params.get('lang') === 'en';
  const lang = en ? 'en' : 'es';
  const t = (es, english) => en ? english : es;
  const el = id => document.getElementById(id);
  const money = new Intl.NumberFormat(lang, { style: 'currency', currency: 'USD' });
  const usd = cents => money.format(Number(cents || 0) / 100);
  const date = value => new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value));
  const token = sessionStorage.getItem('itbmo_guest_session_token') || localStorage.getItem('itbmo_session_token');

  document.documentElement.lang = lang;
  el('title').textContent = t('Colaboradores', 'Creator partners');
  el('language').textContent = t('English', 'Español');
  el('language').href = en ? '?lang=es' : '?lang=en';
  el('login').textContent = t('Iniciar sesión en el Planner', 'Sign in to the Planner');
  el('login').href += '&lang=' + lang;

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
    el('dashboard').hidden = false;
    const balance = section(summary.name);
    const stats = document.createElement('div');
    stats.className = 'stats';
    for (const [label, value] of [
      [t('Pendiente', 'Pending'), summary.pending_cents],
      [t('Disponible', 'Available'), summary.available_cents]
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
      t('Visitas registradas', 'Tracked visits'), t('Ventas atribuidas', 'Attributed sales'), t('Enlace', 'Link')
    ], summary.codes.map(code => [
      code.code, code.type === 'percentage' ? code.discount + '%' : usd(Number(code.discount) * 100),
      code.active ? t('Activo', 'Active') : t('Inactivo', 'Inactive'),
      code.visits, code.sales, creatorLink(code.code)
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
    REGISTERED_SESSION_REQUIRED: t('Inicia sesión con tu cuenta registrada de ITBMO.', 'Sign in with your registered ITBMO account.'),
    CREATOR_ACCESS_REQUIRED: t('Esta cuenta todavía no tiene acceso al programa.', 'This account does not have access to the program yet.'),
    CREATOR_PORTAL_UNAVAILABLE: t('El portal aún no está habilitado en este entorno.', 'The portal is not enabled in this environment yet.'),
    CREATOR_OR_CODE_EXISTS: t('El colaborador o el código ya existe.', 'The creator or code already exists.'),
    VERIFIED_PROFILE_OR_MARGIN_REQUIRED: t('Verifica que la cuenta esté registrada y que la comisión sea menor que el precio con descuento.', 'Check that the account is verified and the commission is below the discounted price.'),
    INVALID_CREATOR_AGREEMENT: t('Revisa los datos del colaborador.', 'Check the creator details.')
  };
  const unavailable = t('No pudimos cargar el portal.', 'We could not load the portal.');

  async function init() {
    if (!token) {
      el('notice').textContent = errors.REGISTERED_SESSION_REQUIRED;
      el('login').hidden = false;
      return;
    }
    try {
      const data = await request('creator_summary');
      el('notice').textContent = data.ok ? t('Entorno de pruebas PayPal Sandbox', 'PayPal Sandbox test environment') : errors[data.code] || unavailable;
      el('login').hidden = data.code !== 'REGISTERED_SESSION_REQUIRED';
      if (data.summary) render(data.summary);
      if (data.is_admin) el('admin').hidden = false;
    } catch {
      el('notice').textContent = unavailable;
    }
  }

  if (en) {
    for (const [key, label] of Object.entries({
      name: 'Display name', code: 'Code', email: 'Verified ITBMO account email',
      payout_email: 'Creator PayPal Sandbox email', discount: 'Discount (%)', commission: 'Fixed commission (USD cents)'
    })) document.querySelector('[data-field="' + key + '"]').textContent = label;
    el('save').textContent = el('admin-title').textContent = 'Create creator';
  }

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
