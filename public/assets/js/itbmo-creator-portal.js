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
    el('enroll-title').textContent = 'Activate your creator code';
    el('enroll-offer').textContent = 'Test offer: your audience gets 10% off the current price and you earn USD 0.30 per eligible purchase.';
    el('enroll-name').textContent = 'Display name';
    el('enroll-email').textContent = 'PayPal Sandbox email';
    el('enroll').textContent = 'Generate my code';
    el('access-title').textContent = 'Creator portal';
    el('access-description').textContent = 'Sign in with your Preview account to get your code and track your commissions.';
    el('access-preview').textContent = 'Test access is waiting for the Preview user database to be connected.';
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
    el('resend-confirmation').textContent = 'Resend confirmation email';
    el('registration-terms').href = 'https://itravelbymyown.com/terms';
    el('registration-privacy').href = 'https://itravelbymyown.com/privacy-cookies';
    for (const [id, label] of Object.entries({
      'registration-title': 'Create your ITBMO account',
      'registration-description': 'You can also use this Preview account to sign in to the Planner in this environment.',
      'registration-name': 'Name',
      'registration-email': 'Email',
      'registration-password': 'Password',
      'registration-password-rule': 'At least 8 characters, including uppercase, lowercase and a number.',
      'registration-password-confirmation': 'Confirm password',
      'registration-consent-label': 'I accept the Terms of Use and acknowledge the Privacy Policy.',
      'registration-terms': 'Terms of Use',
      'registration-privacy': 'Privacy Policy',
      'create-account': 'Create account',
      'back-to-login': 'Back to sign in'
    })) el(id).textContent = label;
  }

  const password = el('creator-password');
  const passwordToggle = el('password-toggle');

  function setPasswordVisibility(visible) {
    const label = visible
      ? t('Ocultar contraseña', 'Hide password')
      : t('Mostrar contraseña', 'Show password');
    password.type = visible ? 'text' : 'password';
    passwordToggle.setAttribute('aria-label', label);
    passwordToggle.title = label;
    el('password-toggle-slash').toggleAttribute('hidden', !visible);
  }

  setPasswordVisibility(false);
  passwordToggle.addEventListener('click', () => setPasswordVisibility(password.type === 'password'));

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
    addTableRows(body, rows);
    if (!rows.length) {
      const cell = body.insertRow().insertCell();
      cell.colSpan = labels.length;
      cell.textContent = t('Aún no hay registros.', 'No records yet.');
    }
    wrap.append(tableNode);
    container.append(wrap);
    return body;
  }

  function addTableRows(body, rows) {
    for (const values of rows) {
      const row = body.insertRow();
      for (const value of values) {
        const cell = row.insertCell();
        if (value instanceof Node) cell.append(value);
        else cell.textContent = value;
      }
    }
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
    balance.classList.add('creator-balance');
    const stats = document.createElement('div');
    stats.className = 'stats';
    for (const [label, value] of [
      [t('Comisión acumulada', 'Total commission'), summary.total_commission_cents],
      [t('Pendiente de pago', 'Unpaid'), Math.max(0, Number(summary.total_commission_cents) - Number(summary.paid_cents))],
      [t('Pagado', 'Paid'), summary.paid_cents],
      [t('Disponible', 'Available'), summary.available_cents],
      [t('En período de espera', 'On hold'), summary.pending_cents]
    ]) {
      const item = document.createElement('div');
      const amount = document.createElement('strong');
      amount.textContent = usd(value);
      item.append(label, amount);
      stats.append(item);
    }
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'g-button g-button--ghost g-button--compact';
    reload.textContent = t('Actualizar saldo', 'Refresh balance');
    reload.addEventListener('click', async () => {
      reload.disabled = true;
      try { await init(); }
      finally { reload.disabled = false; }
    });
    balance.append(stats, reload);

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
    const payments = section(t('Historial de pagos', 'Payment history'));
    const method = { bank: t('Transferencia', 'Bank transfer'), paypal: 'PayPal', other: t('Otro', 'Other') };
    const paymentCells = payout => [
      payout.payment_date ? date(payout.payment_date) : payout.period.slice(0, 7), payout.creator_code || '—',
      usd(payout.amount_cents), labels[payout.state], method[payout.method] || '—',
      payout.reference || payout.provider_batch_id || '—'
    ];
    const history = table(payments, [
      t('Fecha o período', 'Date or period'), t('Código', 'Code'), t('Importe', 'Amount'),
      t('Estado', 'Status'), t('Medio', 'Method'), t('Referencia', 'Reference')
    ], summary.payouts.map(paymentCells));
    let cursor = summary.payouts.at(-1);
    if (summary.payouts.length === 24 && cursor?.created_at && cursor.id) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'g-button g-button--ghost g-button--compact';
      more.textContent = t('Ver pagos anteriores', 'Show earlier payments');
      const status = document.createElement('p');
      status.setAttribute('role', 'status');
      payments.append(more, status);
      more.addEventListener('click', async () => {
        more.disabled = true;
        status.textContent = '';
        try {
          const data = await request('creator_payment_history', { before: cursor.created_at, before_id: cursor.id });
          if (!data.ok) throw new Error();
          addTableRows(history, data.payments.map(paymentCells));
          cursor = data.payments.at(-1) || cursor;
          more.hidden = !data.more;
          if (!data.more) status.textContent = t('Fin del historial.', 'End of payment history.');
        } catch {
          status.textContent = t('No se pudo cargar el historial. Intenta de nuevo.', 'Could not load payment history. Try again.');
        } finally {
          more.disabled = false;
        }
      });
    }
  }

  const errors = {
    CREATOR_ENROLLMENT_UNAVAILABLE: t('Para generar tu código, necesitas una cuenta activa y verificada de ITBMO.', 'You need an active, verified ITBMO account to generate a code.'),
    REGISTERED_SESSION_REQUIRED: t('Inicia sesión con tu cuenta registrada de ITBMO.', 'Sign in with your registered ITBMO account.'),
    CREATOR_ACCESS_REQUIRED: t('Esta cuenta todavía no tiene acceso al programa.', 'This account does not have access to the program yet.'),
    CREATOR_PORTAL_UNAVAILABLE: t('El portal aún no está habilitado en este entorno.', 'The portal is not enabled in this environment yet.'),
    EMAIL_NOT_CONFIRMED: t('Verifica tu correo con el enlace que recibiste al registrarte en Preview.', 'Verify your email using the link you received when you signed up in Preview.'),
    SIGNUP_EMAIL_INVALID: t('Revisa el correo electrónico e intenta con una dirección válida.', 'Check your email address and try a valid address.'),
    SIGNUP_INVALID_FIELDS: t('Revisa el nombre, el correo y la longitud de la contraseña.', 'Check your name, email and password length.'),
    SIGNUP_TRY_LATER: t('El servicio de registro limitó los intentos. Espera unos minutos y vuelve a intentar.', 'The sign-up service is rate-limiting attempts. Wait a few minutes and try again.'),
    RESEND_RATE_LIMITED: t('Espera al menos un minuto antes de volver a solicitar el correo.', 'Wait at least one minute before requesting another email.'),
    CREATOR_OR_CODE_EXISTS: t('El colaborador o el código ya existe.', 'The creator or code already exists.'),
    VERIFIED_PROFILE_OR_MARGIN_REQUIRED: t('Verifica que la cuenta esté registrada y que la comisión sea menor que el precio con descuento.', 'Check that the account is verified and the commission is below the discounted price.'),
    CREATOR_CODE_NOT_FOUND: t('No se encontró el código del colaborador.', 'Creator code not found.'),
    ADMIN_ACCESS_REQUIRED: t('Esta cuenta no tiene acceso a convenios.', 'This account cannot manage agreements.'),
    INVALID_CREATOR_AGREEMENT: t('El descuento debe dejar un precio mayor que la comisión. Revisa también los datos del convenio.', 'The discounted price must exceed the commission. Check the agreement details.')
  };
  const unavailable = t('No pudimos cargar el portal.', 'We could not load the portal.');

  async function init() {
    try {
      const data = await request('creator_summary');
      const preview = data.code === 'CREATOR_PORTAL_UNAVAILABLE';
      el('access-preview').hidden = !preview;
      el('notice').textContent = preview || data.code === 'REGISTERED_SESSION_REQUIRED' ? '' : data.ok
        ? t('Entorno de pruebas PayPal Sandbox', 'PayPal Sandbox test environment')
        : errors[data.code] || unavailable;
      el('access').hidden = data.ok || data.code === 'CREATOR_ACCESS_REQUIRED';
      el('login-fields').disabled = data.code !== 'REGISTERED_SESSION_REQUIRED';
      el('register').hidden = data.code !== 'REGISTERED_SESSION_REQUIRED';
      el('enrollment').hidden = !data.ok || Boolean(data.summary) || Boolean(data.is_admin);
      el('entry').hidden = data.ok && Boolean(data.summary || data.is_admin);
      el('steps').hidden = el('entry').hidden;
      if (data.summary) render(data.summary);
      el('admin').hidden = !data.is_admin;
      if (data.web_offer) renderWebOffer(data.web_offer);
    } catch {
      el('notice').textContent = unavailable;
    }
  }

  function openAccountForm(registering) {
    el('registration-form').hidden = !registering;
    el('login-form').hidden = registering;
    if (registering) el('registration-title').focus();
    else el('login-form').elements.email.focus();
  }

  el('register').addEventListener('click', () => openAccountForm(true));
  el('back-to-login').addEventListener('click', () => openAccountForm(false));

  async function userRequest(action, fields) {
    const response = await fetch('/api/user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...fields, action })
    });
    return { response, data: await response.json() };
  }

  const loginEmail = el('login-form').elements.email;
  const resendConfirmation = el('resend-confirmation');
  loginEmail.addEventListener('input', () => { resendConfirmation.hidden = true; });

  resendConfirmation.addEventListener('click', async () => {
    const status = el('login-status');
    resendConfirmation.disabled = true;
    try {
      const { response, data } = await userRequest('creator_resend_confirmation', {
        email: loginEmail.value.trim(), preferred_language: lang
      });
      status.textContent = response.ok && data.ok
        ? t('Si la cuenta está pendiente de verificación, recibirás un enlace nuevo. Revisa también el correo no deseado.', 'If the account is still pending verification, you will get a new link. Check your spam folder too.')
        : errors[data.code] || unavailable;
    } catch {
      status.textContent = unavailable;
    } finally {
      resendConfirmation.disabled = false;
    }
  });

  el('registration-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const status = el('registration-status');
    const fields = Object.fromEntries(new FormData(form));
    if (!/[a-z]/.test(fields.password) || !/[A-Z]/.test(fields.password) || !/[0-9]/.test(fields.password)) {
      status.textContent = el('registration-password-rule').textContent;
      return;
    }
    if (fields.password !== fields.password_confirmation) {
      status.textContent = t('Las contraseñas deben coincidir.', 'The passwords must match.');
      return;
    }

    const submit = el('create-account');
    const back = el('back-to-login');
    const failed = t('No pudimos crear tu cuenta de Preview. Intenta de nuevo.', 'We could not create your Preview account. Please try again.');
    submit.disabled = back.disabled = true;
    status.textContent = t('Creando tu cuenta…', 'Creating your account…');
    try {
      const { consent, ...account } = fields;
      const { response, data } = await userRequest('creator_sign_up', {
        ...account, preferred_language: lang,
        terms_accepted: consent === 'on', privacy_accepted: consent === 'on'
      });
      const registered = response.ok && data.ok && data.confirmation_required;
      if (registered || response.status === 409) {
        if (registered) form.reset();
        status.textContent = '';
        loginEmail.value = account.email.trim();
        resendConfirmation.hidden = false;
        openAccountForm(false);
        el('login-status').textContent = registered
          ? t('Revisa tu correo y abre el enlace de confirmación. Después podrás iniciar sesión aquí.', 'Check your email and open the confirmation link. You can then sign in here.')
          : t('Este correo ya está en uso en Preview. Inicia sesión si ya lo verificaste o solicita un nuevo enlace.', 'This email is already in use in Preview. Sign in if you already verified it, or request a new link.');
      } else {
        status.textContent = errors[data.code] || failed;
      }
    } catch {
      status.textContent = failed;
    } finally {
      submit.disabled = back.disabled = false;
    }
  });

  el('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const status = el('login-status');
    resendConfirmation.hidden = true;
    el('signin').disabled = true;
    status.textContent = t('Iniciando sesión…', 'Signing in…');
    try {
      const { response, data } = await userRequest('creator_sign_in', Object.fromEntries(new FormData(form)));
      if (response.ok && data.ok && data.session_token) {
        form.reset();
        setPasswordVisibility(false);
        status.textContent = '';
        token = data.session_token;
        sessionStorage.setItem(storageKey, token);
        await init();
      } else {
        resendConfirmation.hidden = data.code !== 'EMAIL_NOT_CONFIRMED';
        status.textContent = errors[data.code] || (response.status === 401
          ? t('Revisa tus credenciales. Si tu cuenta solo existe en el sitio público, crea y verifica una cuenta en Preview para esta prueba.', 'Check your credentials. If your account only exists on the public site, create and verify a Preview account for this test.')
          : unavailable);
      }
    } catch {
      status.textContent = unavailable;
    } finally {
      el('signin').disabled = false;
    }
  });

  if (en) {
    for (const [key, label] of Object.entries({
      name: 'Display name', code: 'Code', email: 'Verified ITBMO account email',
      payout_email: 'Creator PayPal Sandbox email', discount: 'Discount', commission: 'Fixed commission per purchase (USD)',
      operation: 'Action', create: 'Create creator', edit: 'Update agreement by code',
      discount_mode: 'Discount type', percent: 'Percentage', fixed: 'Amount in USD'
    })) document.querySelector('[data-field="' + key + '"]').textContent = label;
    el('admin-title').textContent = 'Creator agreements';
    el('save').textContent = 'Save agreement';
  }

  if (en) {
    el('web-offer-title').textContent = 'Website offer';
    el('regular-label').textContent = 'Regular price (USD)';
    el('promotion-label').textContent = 'Promotional price (USD)';
    el('promotion-help').textContent = 'Leave the promotional price blank to remove the website offer.';
    el('save-web-offer').textContent = 'Save Preview prices';
  }
  const webOfferForm = el('web-offer-form');
  const webOfferStatus = el('web-offer-status');

  function renderWebOffer(offer) {
    webOfferForm.elements.regular.value = (offer.regular_price_cents / 100).toFixed(2);
    webOfferForm.elements.promotion.value = offer.promotion_cents == null ? '' : (offer.promotion_cents / 100).toFixed(2);
    webOfferStatus.textContent = t('Precio vigente en checkout', 'Current checkout price') + ' ' + usd(offer.base_price_cents) +
      (offer.campaign_id ? ' · ' + t('La campaña activa tiene prioridad.', 'The active campaign takes precedence.') : '');
  }

  webOfferForm.addEventListener('submit', async event => {
    event.preventDefault();
    const save = el('save-web-offer');
    save.disabled = true;
    try {
      const result = await request('creator_web_offer', Object.fromEntries(new FormData(webOfferForm)));
      if (!result.ok) {
        webOfferStatus.textContent = result.code === 'INVALID_WEB_OFFER'
          ? t('El precio promocional debe ser mayor que cero y menor que el regular.', 'The promotional price must be above zero and below the regular price.')
          : errors[result.code] || unavailable;
        return;
      }
      renderWebOffer(result.offer);
      webOfferStatus.textContent = t('Guardado.', 'Saved.') + ' ' + webOfferStatus.textContent;
    } catch {
      webOfferStatus.textContent = unavailable;
    } finally {
      save.disabled = false;
    }
  });

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

  const creatorForm = el('creator-form');
  function updateCreatorOperation() {
    const edit = creatorForm.elements.operation.value === 'edit';
    el('creator-account-fields').hidden = el('creator-account-fields').disabled = edit;
  }
  creatorForm.elements.operation.addEventListener('change', updateCreatorOperation);
  creatorForm.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    el('save').disabled = true;
    try {
      const result = await request('creator_create', Object.fromEntries(new FormData(form)));
      el('admin-result').textContent = result.ok
        ? t('Convenio guardado', 'Agreement saved') + ` · ${result.code} · ` +
          t('Precio con código', 'Code price') + ` ${usd(result.final_cents)} · ` +
          t('Comisión', 'Commission') + ` ${usd(result.commission_cents)}`
        : errors[result.code] || unavailable;
      if (result.ok) {
        form.reset();
        updateCreatorOperation();
      }
    } catch {
      el('admin-result').textContent = unavailable;
    } finally {
      el('save').disabled = false;
    }
  });
  void init();
})();
