/* =========================================================
   ITBMO · HOME V4.1 JS
   - Stable planner auto-height (no feedback loop / no vibration)
   - FAQ
   - Affiliate preview/config
   - AdSense preview/config
   - Gentle reveal motion
   ========================================================= */

(() => {
  'use strict';

  /* =========================================================
     CONFIG · HOME MONETIZATION
     previewMode:true = show all planned partner surfaces while building.
     For public launch before approvals:
       previewMode:false
       every partner enabled:false
       ad slots enabled:false
  ========================================================= */
  const ITBMO_HOME_CONFIG = {
    previewMode: true,

    partners: {
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
     To inspect them visually, temporarily set the relevant enabled:true.
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
    if (!iframe) return;

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
    window.addEventListener('resize', schedulePlannerMeasure, { passive:true });
  }

  /*
    Cross-origin-safe channel.
    We treat planner message as a trigger/value, but in same-origin preview
    the flow measurement remains the preferred source.
  */
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'ITBMO_PLANNER_HEIGHT') return;

    const h = Number(data.height);
    if (!Number.isFinite(h) || h < 300) return;

    pendingMessageHeight = h;
    schedulePlannerMeasure();
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
      '.how-card,.info-instructions,.promise-hero,.itinerary-preview,.partner-card,.utility-strip,.verify-panel,.faq-item'
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

})();
