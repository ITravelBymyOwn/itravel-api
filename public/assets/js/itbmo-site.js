/* =========================================================
ITBMO · HOME V4.5 JS

Stable planner auto-height (no feedback loop / no vibration)
FAQ
Affiliate preview/config
AdSense preview/config
Gentle reveal motion
========================================================= */

(() => {
'use strict';

/* =========================================================
CONFIG · HOME MONETIZATION
previewMode = show all planned partner surfaces while building.
For public launch before approvals:
previewMode
every partner enabled
ad slots enabled
========================================================= */
const ITBMO_HOME_CONFIG = {
previewMode: true,

partners: {
  kayak:        { enabled:false, url:'', previewUrl:'https://www.kayak.com/flights' },
  skyscanner:   { enabled:false, url:'', previewUrl:'https://www.skyscanner.com/' },
  booking:      { enabled:false, url:'', previewUrl:'https://www.booking.com/' },
  getyourguide: { enabled:false, url:'', previewUrl:'https://www.getyourguide.com/' },
  viator:       { enabled:false, url:'', previewUrl:'https://www.viator.com/' },
  omio:         { enabled:false, url:'', previewUrl:'https://www.omio.com/' },
  airalo:       { enabled:false, url:'', previewUrl:'https://www.airalo.com/' },
  holafly:      { enabled:false, url:'', previewUrl:'https://esim.holafly.com/' }
},

ads: {
  home01: { enabled:false },
  home02: { enabled:false }
},

infoChatPolicy: {
  enabledAfterPayment: true,
  maxUserMessages: 10,
  maxOutputTokensPerReply: 700,
  maxTotalOutputTokens: 6000,
  restrictToPlannerCities: true
}

};

/* =========================================================
FAQ
========================================================= */
document.querySelectorAll('.faq-item > button').forEach((button) => {
button.addEventListener('click', () => {
const item = button.closest('.faq-item');
const isOpen = button.getAttribute('aria-expanded') === 'true';

  document.querySelectorAll('.faq-item.is-open').forEach((openItem) => {
    if (openItem === item) return;
    openItem.classList.remove('is-open');
    openItem.querySelector('button')?.setAttribute('aria-expanded', 'false');
  });

  button.setAttribute('aria-expanded', String(!isOpen));
  item.classList.toggle('is-open', !isOpen);
});

});

/* =========================================================
PLACEHOLDER / UTILITY LINKS
========================================================= */
document.querySelectorAll('[data-placeholder-link],[data-utility-link]').forEach((link) => {
link.addEventListener('click', (event) => event.preventDefault());
});

/* =========================================================
HOME / SCROLL TO TOP
Always returns to the top even if #top is already in the URL.
========================================================= */
document.querySelectorAll('[data-scroll-top]').forEach((link) => {
link.addEventListener('click', (event) => {
event.preventDefault();

  window.scrollTo({
    top: 0,
    behavior: 'smooth'
  });

  if (window.location.hash) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
});

});

/* =========================================================
PAGE LANGUAGE SELECTOR
---------------------------------------------------------
ES is the active page today. EN remains a real, clickable
selector without sending the user to a 404 while the English
page is not published yet.
========================================================= */
const ITBMO_LANGUAGE_PAGES = {
es: './preview-home.html',
en: ''
};

function showLanguageAvailability(message) {
document.querySelector('.itbmo-language-toast')?.remove();
const toast = document.createElement('div');
toast.className = 'itbmo-language-toast';
toast.setAttribute('role', 'status');
toast.textContent = message;
document.body.appendChild(toast);
requestAnimationFrame(() => toast.classList.add('is-visible'));
window.setTimeout(() => {
toast.classList.remove('is-visible');
window.setTimeout(() => toast.remove(), 220);
}, 2600);
}

document.querySelectorAll('[data-site-lang]').forEach((button) => {
button.addEventListener('click', () => {
const lang = String(button.dataset.siteLang || '').toLowerCase();
if (!lang) return;
try { localStorage.setItem('itbmo_site_language', lang); } catch (_) {}

  if (lang === 'es') return;
  const target = ITBMO_LANGUAGE_PAGES[lang];
  if (target) {
    window.location.href = target;
    return;
  }

  showLanguageAvailability('La versión en inglés estará disponible muy pronto.');
});

});

/* =========================================================
MOBILE / TABLET NAVIGATION
The desktop nav stays untouched. This drawer only appears where the
existing responsive CSS hides .site-nav.
========================================================= */
const mobileMenuToggle = document.querySelector('[data-mobile-menu-toggle]');
const mobileNav = document.getElementById('mobile-navigation');
const mobileNavBackdrop = document.querySelector('[data-mobile-menu-backdrop]');
let mobileMenuOpen = false;
let mobileMenuTimer = 0;

function setMobileMenu(open) {
if (!mobileMenuToggle || !mobileNav || !mobileNavBackdrop) return;
if (mobileMenuOpen === open) return;

mobileMenuOpen = open;
window.clearTimeout(mobileMenuTimer);

mobileMenuToggle.classList.toggle('is-open', open);
mobileMenuToggle.setAttribute('aria-expanded', String(open));
mobileMenuToggle.setAttribute('aria-label', open ? 'Cerrar menú' : 'Abrir menú');
document.documentElement.classList.toggle('mobile-menu-open', open);
document.body.classList.toggle('mobile-menu-open', open);

if (open) {
  mobileNav.hidden = false;
  mobileNavBackdrop.hidden = false;
  mobileNav.setAttribute('aria-hidden', 'false');

  requestAnimationFrame(() => {
    mobileNav.classList.add('is-open');
    mobileNavBackdrop.classList.add('is-visible');
  });
} else {
  mobileNav.classList.remove('is-open');
  mobileNavBackdrop.classList.remove('is-visible');
  mobileNav.setAttribute('aria-hidden', 'true');

  mobileMenuTimer = window.setTimeout(() => {
    if (mobileMenuOpen) return;
    mobileNav.hidden = true;
    mobileNavBackdrop.hidden = true;
  }, 280);
}

}

mobileMenuToggle?.addEventListener('click', () => setMobileMenu(!mobileMenuOpen));
mobileNavBackdrop?.addEventListener('click', () => setMobileMenu(false));

mobileNav?.querySelectorAll('a').forEach((link) => {
link.addEventListener('click', () => setMobileMenu(false));
});

window.addEventListener('resize', () => {
if (window.innerWidth > 1180 && mobileMenuOpen) setMobileMenu(false);
}, { passive });

/* =========================================================
AFFILIATES
========================================================= */
document.querySelectorAll('[data-partner]').forEach((card) => {
const key = card.getAttribute('data-partner');
const config = ITBMO_HOME_CONFIG.partners[key];
if (!config) {
card.hidden = true;
return;
}

const visible = ITBMO_HOME_CONFIG.previewMode || config.enabled;
card.hidden = !visible;
if (!visible) return;

const state = card.querySelector('.partner-card__state');
const link = card.querySelector(`[data-partner-link="${key}"]`);
const url = ITBMO_HOME_CONFIG.previewMode ? config.previewUrl : config.url;

if (state) {
  state.textContent = ITBMO_HOME_CONFIG.previewMode ? 'Preview' : 'Partner';
  state.hidden = !ITBMO_HOME_CONFIG.previewMode;
}

if (link) {
  if (url) {
    link.href = url;
    link.target = '_blank';
    link.rel = 'sponsored noopener noreferrer';
  } else {
    link.href = '#';
    link.addEventListener('click', (event) => event.preventDefault());
  }
}

});

/* =========================================================
ADSENSE SURFACES
In previewMode we keep them hidden by default to preserve premium feel.
To inspect them visually, temporarily set the relevant enabled.
========================================================= */
const adMap = {
'home-01': ITBMO_HOME_CONFIG.ads.home01,
'home-02': ITBMO_HOME_CONFIG.ads.home02
};

document.querySelectorAll('[data-ad-slot]').forEach((slot) => {
const cfg = adMap[slot.getAttribute('data-ad-slot')];

/*
  Development preview:
  - previewMode:true  => show the reserved AdSense surfaces
  - production       => only show a slot when enabled:true
*/
const visible = Boolean(
  cfg && (ITBMO_HOME_CONFIG.previewMode || cfg.enabled)
);

slot.hidden = !visible;

if (visible) {
  slot.classList.toggle('is-preview', ITBMO_HOME_CONFIG.previewMode && !cfg.enabled);
}

});

/* =========================================================
STABLE PLANNER AUTO-HEIGHT
---------------------------------------------------------
IMPORTANT:
The previous implementation measured iframe clientHeight /
html.clientHeight. Because planner body uses min-height:100vh,
changing iframe height changed the measured height again, causing:
- gradual self-scrolling
- vibration
- huge blank space
V4 keeps the stable flow-only measurement and does not modify planner.html.

 In Vercel preview (same origin), we calculate only actual FLOW content:
   topbar + planner-grid + footer + other non-fixed body children.
 For final Webflow cross-origin integration, planner.html also emits a
 corrected ITBMO_PLANNER_HEIGHT message (provided in the companion file).

========================================================= */
const iframe = document.getElementById('itbmo-planner');

/* =========================================================
PLANNER FOCUS MODE
---------------------------------------------------------
Same iframe. Same DOM. Same session. No reload and no duplicate Planner.
The frame is temporarily lifted into a fixed immersive layer and returns
to the exact Home scroll position when the user taps "Volver a ITBMO".
========================================================= */
const plannerFrame = iframe?.closest('[data-planner-focus-frame]') || iframe?.closest('.planner-frame');
const plannerFocusBackdrop = document.querySelector('[data-planner-focus-backdrop]');
const plannerFocusBack = plannerFrame?.querySelector('[data-planner-focus-back]');

let plannerFocusActive = false;
let plannerFocusReturnY = 0;
let plannerFocusCloseTimer = 0;

function setPlannerFocusRect(rect) {
if (!plannerFrame || !rect) return;
plannerFrame.style.setProperty('--planner-focus-from-top', ${rect.top}px);
plannerFrame.style.setProperty('--planner-focus-from-left', ${rect.left}px);
plannerFrame.style.setProperty('--planner-focus-from-width', ${rect.width}px);
plannerFrame.style.setProperty('--planner-focus-from-height', ${rect.height}px);
}

function enterPlannerFocus({ immediate=false, sourceRect=null } = {}) {
if (!iframe || !plannerFrame || plannerFocusActive) return;

/* Never leave the mobile navigation floating above the Planner. */
if (typeof setMobileMenu === 'function') setMobileMenu(false);

plannerFocusActive = true;
plannerFocusReturnY = window.scrollY || window.pageYOffset || 0;
window.clearTimeout(plannerFocusCloseTimer);

const rect = sourceRect || plannerFrame.getBoundingClientRect();
setPlannerFocusRect(rect);

plannerFrame.classList.add('planner-frame--focus-layer');
plannerFrame.setAttribute('role', 'dialog');
plannerFrame.setAttribute('aria-modal', 'true');

if (plannerFocusBackdrop) {
  plannerFocusBackdrop.hidden = false;
}

document.documentElement.classList.add('planner-focus-open');
document.body.classList.add('planner-focus-open');

/* Lock its first fixed frame at the exact on-page rectangle before expansion. */
plannerFrame.getBoundingClientRect();

const expand = () => {
  plannerFrame.classList.add('is-focus-mode');
  plannerFocusBackdrop?.classList.add('is-visible');

  /* The viewport is now finite; Planner scroll belongs inside its same iframe. */
  iframe.setAttribute('scrolling', 'auto');
  iframe.style.height = '100%';
};

if (immediate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  expand();
} else {
  requestAnimationFrame(() => requestAnimationFrame(expand));
}

}

function exitPlannerFocus({ immediate=false } = {}) {
if (!iframe || !plannerFrame || !plannerFocusActive) return;

plannerFocusActive = false;
window.clearTimeout(plannerFocusCloseTimer);

plannerFrame.classList.remove('is-focus-mode');
plannerFocusBackdrop?.classList.remove('is-visible');

const finish = () => {
  plannerFrame.classList.remove('planner-frame--focus-layer');
  plannerFrame.removeAttribute('role');
  plannerFrame.removeAttribute('aria-modal');

  plannerFrame.style.removeProperty('--planner-focus-from-top');
  plannerFrame.style.removeProperty('--planner-focus-from-left');
  plannerFrame.style.removeProperty('--planner-focus-from-width');
  plannerFrame.style.removeProperty('--planner-focus-from-height');

  document.documentElement.classList.remove('planner-focus-open');
  document.body.classList.remove('planner-focus-open');

  if (plannerFocusBackdrop) plannerFocusBackdrop.hidden = true;

  /*
    Restore auto-height on the very same iframe. Resetting lastAppliedHeight
    forces a fresh measurement even when the numerical height happens to match.
  */
  iframe.style.height = '';
  lastAppliedHeight = 0;

  window.scrollTo({ top:plannerFocusReturnY, behavior:'auto' });
  schedulePlannerMeasure();
  setTimeout(schedulePlannerMeasure, 120);
};

if (immediate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  finish();
} else {
  plannerFocusCloseTimer = window.setTimeout(finish, 470);
}

}

plannerFocusBack?.addEventListener('click', () => exitPlannerFocus());

/* =========================================================
PRODUCT LAUNCH ACTIONS
Navbar, Hero, final CTA and footer all open the SAME Planner iframe.
========================================================= */
function getLauncherRect(trigger) {
if (!trigger?.getBoundingClientRect) return null;
const r = trigger.getBoundingClientRect();
const minWidth = Math.min(420, Math.max(260, window.innerWidth - 32));
const width = Math.max(r.width, minWidth);
const height = Math.max(r.height, 150);
const centerX = r.left + (r.width / 2);
const centerY = r.top + (r.height / 2);
const margin = 12;
const left = Math.min(
Math.max(margin, centerX - (width / 2)),
Math.max(margin, window.innerWidth - width - margin)
);
const top = Math.min(
Math.max(margin, centerY - (height / 2)),
Math.max(margin, window.innerHeight - height - margin)
);
return { top, left, width, height };
}

document.querySelectorAll('[data-planner-open]').forEach((trigger) => {
trigger.addEventListener('click', (event) => {
event.preventDefault();
if (typeof setMobileMenu === 'function') setMobileMenu(false);
enterPlannerFocus({ sourceRect(trigger) });
});
});

/* =========================================================
EXAMPLE FOCUS MODE
The existing one-day sample is not duplicated; it simply leaves the
document flow and becomes an immersive on-demand preview.
========================================================= */
const exampleFocus = document.querySelector('[data-example-focus]');
const exampleFocusBack = exampleFocus?.querySelector('[data-example-focus-back]');
const exampleFocusClose = exampleFocus?.querySelector('[data-example-focus-close]');
const exampleFocusBackdrop = document.querySelector('[data-example-focus-backdrop]');

let exampleFocusActive = false;
let exampleFocusReturnY = 0;
let exampleFocusTimer = 0;

function enterExampleFocus() {
if (!exampleFocus || exampleFocusActive) return;
if (typeof setMobileMenu === 'function') setMobileMenu(false);

exampleFocusActive = true;
exampleFocusReturnY = window.scrollY || window.pageYOffset || 0;
window.clearTimeout(exampleFocusTimer);

exampleFocus.setAttribute('aria-hidden', 'false');
if (exampleFocusBackdrop) exampleFocusBackdrop.hidden = false;

document.documentElement.classList.add('example-focus-open');
document.body.classList.add('example-focus-open');

requestAnimationFrame(() => {
  exampleFocus.classList.add('is-open');
  exampleFocusBackdrop?.classList.add('is-visible');
  exampleFocus.scrollTop = 0;
});

}

function exitExampleFocus({ immediate=false, restoreScroll=true } = {}) {
if (!exampleFocus || !exampleFocusActive) return;

exampleFocusActive = false;
window.clearTimeout(exampleFocusTimer);
exampleFocus.classList.remove('is-open');
exampleFocusBackdrop?.classList.remove('is-visible');

const finish = () => {
  exampleFocus.setAttribute('aria-hidden', 'true');
  document.documentElement.classList.remove('example-focus-open');
  document.body.classList.remove('example-focus-open');
  if (exampleFocusBackdrop) exampleFocusBackdrop.hidden = true;
  if (restoreScroll) window.scrollTo({ top:exampleFocusReturnY, behavior:'auto' });
};

if (immediate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  finish();
} else {
  exampleFocusTimer = window.setTimeout(finish, 340);
}

}

document.querySelectorAll('[data-example-open]').forEach((trigger) => {
trigger.addEventListener('click', (event) => {
event.preventDefault();
enterExampleFocus();
});
});

exampleFocusBack?.addEventListener('click', () => exitExampleFocus());
exampleFocusClose?.addEventListener('click', () => exitExampleFocus());
exampleFocusBackdrop?.addEventListener('click', () => exitExampleFocus());

document.querySelectorAll('[data-example-to-planner]').forEach((trigger) => {
trigger.addEventListener('click', (event) => {
event.preventDefault();
exitExampleFocus({ immediate, restoreScroll });
requestAnimationFrame(() => {
enterPlannerFocus({ sourceRect(trigger) });
});
});
});

let plannerResizeObserver = null;
let plannerMutationObserver = null;
let rafId = 0;
let lastAppliedHeight = 0;
let pendingMessageHeight = 0;

function getPlannerFlowHeight() {
if (!iframe) return 0;

try {
  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!doc || !doc.body) return 0;

  let maxBottom = 0;
  const win = doc.defaultView;

  Array.from(doc.body.children).forEach((el) => {
    const style = win.getComputedStyle(el);

    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.position === 'fixed' ||
      style.position === 'absolute'
    ) return;

    const rect = el.getBoundingClientRect();
    const bottom = rect.bottom + (win.scrollY || 0);

    if (Number.isFinite(bottom)) maxBottom = Math.max(maxBottom, bottom);
  });

  /* Direct fallback to the actual Planner flow elements. */
  ['.topbar', '#planner-grid', '.footer'].forEach((selector) => {
    const el = doc.querySelector(selector);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const bottom = rect.bottom + (win.scrollY || 0);
    if (Number.isFinite(bottom)) maxBottom = Math.max(maxBottom, bottom);
  });

  return Math.ceil(maxBottom + 8);
} catch (_) {
  return 0;
}

}

function applyPlannerHeight(nextHeight) {
if (!iframe || plannerFocusActive) return;

const h = Math.max(720, Math.ceil(Number(nextHeight) || 0));
if (!h) return;

/* Hysteresis avoids 1–2 px ResizeObserver oscillation. */
if (Math.abs(h - lastAppliedHeight) < 4) return;

lastAppliedHeight = h;
iframe.style.height = `${h}px`;

}

function measureAndApplyPlannerHeight() {
rafId = 0;

const sameOriginHeight = getPlannerFlowHeight();

/*
  Prefer same-origin flow measurement while previewing in Vercel.
  In Webflow this returns 0 and the postMessage value becomes source of truth.
*/
if (sameOriginHeight > 0) {
  applyPlannerHeight(sameOriginHeight);
  return;
}

if (pendingMessageHeight > 0) {
  applyPlannerHeight(pendingMessageHeight);
}

}

function schedulePlannerMeasure() {
if (rafId) return;
rafId = requestAnimationFrame(measureAndApplyPlannerHeight);
}

function attachPlannerObservers() {
if (!iframe) return;

try {
  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!doc?.body) return;

  plannerResizeObserver?.disconnect();
  plannerMutationObserver?.disconnect();

  plannerResizeObserver = new ResizeObserver(schedulePlannerMeasure);

  const flowTargets = [
    doc.querySelector('.topbar'),
    doc.querySelector('#planner-grid'),
    doc.querySelector('.footer')
  ].filter(Boolean);

  flowTargets.forEach((target) => plannerResizeObserver.observe(target));

  plannerMutationObserver = new MutationObserver(schedulePlannerMeasure);
  plannerMutationObserver.observe(doc.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden']
  });

  doc.addEventListener('click', schedulePlannerMeasure, true);
  doc.addEventListener('input', schedulePlannerMeasure, true);
  doc.addEventListener('change', schedulePlannerMeasure, true);

  schedulePlannerMeasure();
  setTimeout(schedulePlannerMeasure, 250);
  setTimeout(schedulePlannerMeasure, 900);
} catch (_) {
  /* Cross-origin in Webflow: postMessage listener below handles sizing. */
}

}

if (iframe) {
iframe.addEventListener('load', attachPlannerObservers);
window.addEventListener('resize', schedulePlannerMeasure, { passive });
}

/*
Cross-origin-safe channel.
We treat planner message as a trigger/value, but in same-origin preview
the flow measurement remains the preferred source.
*/
window.addEventListener('message', (event) => {
const data = event.data;
if (!data || !iframe || event.source !== iframe.contentWindow) return;

/*
  First real Planner interaction requests Focus Mode.
  Critical checkout/loading/notices also request it, so generation remains
  immersive even if the user had returned to the Home beforehand.
*/
if (
  data.type === 'ITBMO_REQUEST_PLANNER_FOCUS' ||
  data.type === 'ITBMO_FOCUS_PLANNER_MODAL'
) {
  enterPlannerFocus({ immediate:Boolean(data.immediate) });
  return;
}

if (data.type !== 'ITBMO_PLANNER_HEIGHT') return;

const h = Number(data.height);
if (!Number.isFinite(h) || h < 300) return;

pendingMessageHeight = h;
if (!plannerFocusActive) schedulePlannerMeasure();

});

/* =========================================================
BRAND LOGO · ROBUST JPG/JPEG LOADER
The fallback text seen in the navbar means the image request failed;
it is not a space/layout problem.

 We try the common JPG/JPEG case variants automatically so a Windows
 filename-extension mismatch does not hide the brand.

========================================================= */
document.querySelectorAll('[data-brand-logo]').forEach((img) => {
const brand = img.closest('.brand--logo');
if (!brand) return;

const base = img.getAttribute('data-logo-base') || './assets/img/itbmo-logo-premium';
const candidates = [
  `${base}.jpg?v=43`,
  `${base}.jpeg?v=43`,
  `${base}.JPG?v=43`,
  `${base}.JPEG?v=43`
];

let index = 0;

const showFallback = () => {
  brand.classList.add('logo-missing');
};

const showLogo = () => {
  if (img.naturalWidth > 1) {
    brand.classList.remove('logo-missing');
  } else {
    tryNext();
  }
};

const tryNext = () => {
  if (index >= candidates.length) {
    showFallback();
    return;
  }

  const next = candidates[index++];
  img.onload = showLogo;
  img.onerror = tryNext;
  img.src = next;
};

brand.classList.remove('logo-missing');
tryNext();

});

/* =========================================================
IMAGE SLOTS
If an image exists, reveal it. If not, keep the premium placeholder.
This lets images be uploaded later without changing HTML/CSS.
========================================================= */
document.querySelectorAll('[data-image-slot]').forEach((slot) => {
const img = slot.querySelector('[data-image-asset]');
if (!img) return;

const markReady = () => {
  if (img.naturalWidth > 1) {
    slot.classList.add('has-image');
  }
};

const markMissing = () => {
  slot.classList.remove('has-image');
};

if (img.complete) {
  markReady();
} else {
  img.addEventListener('load', markReady, { once:true });
  img.addEventListener('error', markMissing, { once:true });
}

});

/* =========================================================
SUBTLE REVEALS
========================================================= */
const revealTargets = [
...document.querySelectorAll(
'.how-card,.info-instructions,.promise-hero,.example-entry,.partner-card,.utility-strip,.verify-panel,.faq-item'
)
];

if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
document.documentElement.classList.add('reveal-ready');

revealTargets.forEach((el) => el.setAttribute('data-reveal', ''));

const io = new IntersectionObserver((entries, observer) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add('is-visible');
    observer.unobserve(entry.target);
  });
}, { threshold:0.08, rootMargin:'0px 0px -4% 0px' });

revealTargets.forEach((el) => io.observe(el));

}

document.addEventListener('keydown', (event) => {
if (event.key !== 'Escape') return;
if (exampleFocusActive) {
exitExampleFocus();
return;
}
if (mobileMenuOpen) setMobileMenu(false);
});

})();

/* =========================================================
ITBMO · EXTERNAL FOCUS DEEP LINKS V4.9
Surgical addition: legal/support pages can reopen the existing
Planner or Example Focus Mode without duplicating either surface.
========================================================= */
(() => {
const params = new URLSearchParams(window.location.search);
const openTarget = String(params.get('open') || '').toLowerCase();
if (!openTarget) return;

const launch = () => {
if (openTarget === 'planner') {
const trigger = document.querySelector('[data-planner-open]');
if (trigger) trigger.click();
} else if (openTarget === 'example') {
const trigger = document.querySelector('[data-example-open]');
if (trigger) trigger.click();
}

params.delete('open');
const query = params.toString();
history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash);

};

if (document.readyState === 'loading') {
document.addEventListener('DOMContentLoaded', () => setTimeout(launch, 80), { once });
} else {
setTimeout(launch, 80);
}
})();
