/* ITBMO V297.6 · Commercial, resources and destination shell
   One code path for Home + product pages, inside Webflow or standalone. */
(() => {
  'use strict';

  document.documentElement.classList.add('js');

  const lang=(document.documentElement.lang||'es').toLowerCase().startsWith('en')?'en':'es';
  const page=String(document.body?.dataset?.page||'home');
  const rawRoutes={
    home:{es:'/',en:'/english'},
    how:{es:'/como-funciona',en:'/how-it-works'},
    sample:{es:'/ejemplo-itinerario',en:'/sample-itinerary'},
    pricing:{es:'/precios',en:'/pricing'},
    about:{es:'/acerca-de-itbmo',en:'/about-itbmo'},
    destinations:{es:'/destinos',en:'/destinations'},
    resources:{es:'/recursos',en:'/resources'},
    collaborate:{es:'/colabora',en:'/partner-with-itbmo'},
    support:{es:'/support-contact.html',en:'/support-contact-en.html'},
    privacy:{es:'/privacy-cookies.html',en:'/privacy-cookies-en.html'},
    terms:{es:'/terms.html',en:'/terms-en.html'},
    affiliates:{es:'/ads-affiliates.html',en:'/ads-affiliates-en.html'}
  };
  const webflowRoutes={
    home:{es:'/',en:'/english'},
    how:{es:'/como-funciona',en:'/how-it-works'},
    sample:{es:'/ejemplo-itinerario',en:'/sample-itinerary'},
    pricing:{es:'/precios',en:'/pricing'},
    about:{es:'/acerca-de-itbmo',en:'/about-itbmo'},
    destinations:{es:'/destinos',en:'/destinations'},
    resources:{es:'/recursos',en:'/resources'},
    collaborate:{es:'/colabora',en:'/partner-with-itbmo'},
    support:{es:'/soporte-contacto',en:'/support-contact'},
    privacy:{es:'/privacidad-cookies',en:'/privacy-cookies'},
    terms:{es:'/terminos',en:'/terms'},
    affiliates:{es:'/publicidad-afiliados',en:'/advertising-affiliates'}
  };

  const webflowOrigin=()=>{
    try{
      const u=new URL(document.referrer);
      const host=u.hostname.toLowerCase();
      if(host==='itravelbymyown.com'||host==='www.itravelbymyown.com'||host.endsWith('.webflow.io'))return u.origin;
    }catch(_){ }
    return '';
  };
  const rawKey=(pathname)=>{
    const name=String(pathname||'').split('/').pop()||'';
    if(/como-funciona|how-it-works/.test(name))return'how';
    if(/ejemplo-itinerario|sample-itinerary/.test(name))return'sample';
    if(/precios|pricing/.test(name))return'pricing';
    if(/acerca-de-itbmo|about-itbmo/.test(name))return'about';
    if(/^(?:destinos|destinations)(?:\.html)?$/.test(name))return'destinations';
    if(/recursos|resources/.test(name))return'resources';
    if(/colabora|partner-with-itbmo/.test(name))return'collaborate';
    if(/support-contact/.test(name))return'support';
    if(/privacy-cookies/.test(name))return'privacy';
    if(/terms/.test(name))return'terms';
    if(/ads-affiliates/.test(name))return'affiliates';
    return'home';
  };

  function marketingTarget(key,targetLang=lang){
    const parent=webflowOrigin();
    return parent?`${parent}${webflowRoutes[key]?.[targetLang]||webflowRoutes.home[targetLang]}`:(rawRoutes[key]?.[targetLang]||rawRoutes.home[targetLang]);
  }

  /* One calm, predictable navigation system on every V297 surface.  Static
     page content remains indexable; this only normalizes the interactive UI. */
  function normalizeChrome(){
    const labels=lang==='es'?{
      home:'Inicio',how:'Cómo funciona',sample:'Ejemplo real',destinations:'Destinos',resources:'Recursos',pricing:'Precios',login:'Ingresar',plan:'Crear itinerario',tagline:'Tu viaje. Tu estilo. Una ruta diseñada para ti.',discover:'EXPLORA',company:'ITBMO',help:'AYUDA',start:'EMPIEZA',about:'Acerca de',collaborate:'Colabora',support:'Soporte',privacy:'Privacidad',terms:'Términos',affiliates:'Afiliados y publicidad',rights:'Todos los derechos reservados.',world:'Diseñado para viajeros de todo el mundo.'
    }:{
      home:'Home',how:'How it works',sample:'Real example',destinations:'Destinations',resources:'Resources',pricing:'Pricing',login:'Sign in',plan:'Create itinerary',tagline:'Your trip. Your style. A route designed for you.',discover:'EXPLORE',company:'ITBMO',help:'HELP',start:'START',about:'About',collaborate:'Partner with us',support:'Support',privacy:'Privacy',terms:'Terms',affiliates:'Affiliates & advertising',rights:'All rights reserved.',world:'Designed for travelers worldwide.'
    };
    const header=document.querySelector('.g-header');
    if(header){
      header.innerHTML=`<div class="g-header__inner"><a class="g-brand" href="${marketingTarget('home')}" data-route="home" aria-label="ITBMO · ${labels.home}"><picture><source srcset="/assets/img/itbmo-logo-premium.webp" type="image/webp"><img src="/assets/img/itbmo-logo-premium.jpg" alt="I Travel By My Own" width="154" height="59"></picture></a><nav class="g-nav" aria-label="${lang==='es'?'Navegación principal':'Main navigation'}"><a href="${marketingTarget('home')}" data-route="home">${labels.home}</a><a href="${marketingTarget('how')}" data-route="how">${labels.how}</a><a href="${marketingTarget('sample')}" data-route="sample">${labels.sample}</a><a href="${marketingTarget('destinations')}" data-route="destinations">${labels.destinations}</a><a href="${marketingTarget('resources')}" data-route="resources">${labels.resources}</a><a href="${marketingTarget('pricing')}" data-route="pricing">${labels.pricing}</a></nav><div class="g-header__actions"><a class="g-login" href="/planner.html?lang=${lang}&mode=access" target="_blank" rel="noopener" data-login-open data-placement="navbar_login">${labels.login}</a><a class="g-button g-button--primary g-button--compact" href="/planner.html?lang=${lang}&mode=new" target="_blank" rel="noopener" data-planner-open data-placement="navbar">${labels.plan}</a></div><div class="g-lang"><button class="${lang==='es'?'is-active':''}" type="button" data-site-lang="es">ES</button><button class="${lang==='en'?'is-active':''}" type="button" data-site-lang="en">EN</button></div><button class="g-menu-toggle" type="button" aria-expanded="false" aria-controls="g-mobile-nav" data-menu-toggle aria-label="${lang==='es'?'Abrir menú':'Open menu'}"><span></span><span></span><span></span></button></div>`;
    }
    let mobile=document.querySelector('[data-mobile-nav]');
    if(!mobile&&header){mobile=document.createElement('nav');mobile.className='g-mobile-nav';mobile.id='g-mobile-nav';mobile.dataset.mobileNav='';mobile.hidden=true;header.insertAdjacentElement('afterend',mobile);}
    if(mobile)mobile.innerHTML=`<a href="${marketingTarget('home')}" data-route="home">${labels.home}<span>→</span></a><a href="${marketingTarget('how')}" data-route="how">${labels.how}<span>→</span></a><a href="${marketingTarget('sample')}" data-route="sample">${labels.sample}<span>→</span></a><a href="${marketingTarget('destinations')}" data-route="destinations">${labels.destinations}<span>→</span></a><a href="${marketingTarget('resources')}" data-route="resources">${labels.resources}<span>→</span></a><a href="${marketingTarget('pricing')}" data-route="pricing">${labels.pricing}<span>→</span></a><a href="/planner.html?lang=${lang}&mode=access" target="_blank" rel="noopener" data-login-open data-placement="mobile_login">${labels.login}<span>→</span></a><a class="g-button g-button--primary" href="/planner.html?lang=${lang}&mode=new" target="_blank" rel="noopener" data-planner-open data-placement="mobile_menu">${labels.plan}</a>`;
    const footer=document.querySelector('.g-footer');
    if(footer)footer.innerHTML=`<div class="g-shell"><div class="g-footer__grid"><div class="g-footer__brand"><strong>ITBMO</strong><p>${labels.tagline}</p><div class="g-footer__social" data-itbmo-social-links></div></div><div class="g-footer__column"><strong>${labels.discover}</strong><a href="${marketingTarget('how')}" data-route="how">${labels.how}</a><a href="${marketingTarget('sample')}" data-route="sample">${labels.sample}</a><a href="${marketingTarget('destinations')}" data-route="destinations">${labels.destinations}</a><a href="${marketingTarget('resources')}" data-route="resources">${labels.resources}</a></div><div class="g-footer__column"><strong>${labels.company}</strong><a href="${marketingTarget('about')}" data-route="about">${labels.about}</a><a href="${marketingTarget('collaborate')}" data-route="collaborate">${labels.collaborate}</a><a href="${marketingTarget('pricing')}" data-route="pricing">${labels.pricing}</a></div><div class="g-footer__column"><strong>${labels.help}</strong><a href="${marketingTarget('support')}" data-route="support">${labels.support}</a><a href="${marketingTarget('privacy')}" data-route="privacy">${labels.privacy}</a><a href="${marketingTarget('terms')}" data-route="terms">${labels.terms}</a><a href="${marketingTarget('affiliates')}" data-route="affiliates">${labels.affiliates}</a></div><div class="g-footer__column"><strong>${labels.start}</strong><a href="/planner.html?lang=${lang}&mode=access" target="_blank" rel="noopener" data-login-open data-placement="footer_login">${labels.login}</a><a href="/planner.html?lang=${lang}&mode=new" target="_blank" rel="noopener" data-planner-open data-placement="footer">${labels.plan}</a></div></div><div class="g-footer__bottom"><span>© 2026 I Travel By My Own. ${labels.rights}</span><span>${labels.world}</span></div></div>`;
    const activePage=page==='destination-detail'?'destinations':page;
    document.querySelectorAll('[data-route]').forEach(link=>{const key=String(link.dataset.route||'home');link.href=marketingTarget(key,lang);if(key===activePage)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');});
  }
  normalizeChrome();

  document.querySelectorAll('[data-route]').forEach(link=>{
    const key=String(link.dataset.route||'home');
    link.href=marketingTarget(key,lang);
  });

  document.addEventListener('click',event=>{
    if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    const link=event.target.closest('a[data-route]');
    if(!link)return;
    const parent=webflowOrigin();
    if(!parent)return;
    event.preventDefault();
    window.top.location.href=marketingTarget(String(link.dataset.route||'home'),lang);
  });

  document.querySelectorAll('[data-site-lang]').forEach(button=>{
    button.addEventListener('click',()=>{
      const targetLang=String(button.dataset.siteLang||'').toLowerCase()==='en'?'en':'es';
      if(targetLang===lang)return;
      try{localStorage.setItem('itbmo_site_language',targetLang);}catch(_){ }
      const explicit=String(button.dataset.langRoute||'').trim();
      if(explicit){
        const parent=webflowOrigin();
        const target=parent?`${parent}${explicit.startsWith('/')?'':'/'}${explicit}`:explicit;
        try{window.top.location.href=target;}catch(_){location.href=target;}
        return;
      }
      if(page==='destination-detail'){
        const esToEn={roma:'rome',egipto:'egypt',estambul:'istanbul',islandia:'iceland',paris:'paris',santorini:'santorini',patagonia:'patagonia',bariloche:'bariloche','rio-de-janeiro':'rio-de-janeiro',tromso:'tromso'};
        const enToEs=Object.fromEntries(Object.entries(esToEn).map(([es,en])=>[en,es]));
        const file=(location.pathname.split('/').pop()||'').replace(/\.html$/,'').replace(/^destino-|^destination-/,'');
        const slug=targetLang==='en'?(esToEn[file]||file):(enToEs[file]||file);
        const path=`/${targetLang==='en'?'destinations':'destinos'}/${slug}`;
        const parent=webflowOrigin();
        try{window.top.location.href=parent?`${parent}${path}`:path;}catch(_){location.href=path;}
        return;
      }
      const key=rawKey(location.pathname);
      const target=marketingTarget(key,targetLang);
      try{window.top.location.href=target;}catch(_){location.href=target;}
    });
  });

  const menuButton=document.querySelector('[data-menu-toggle]');
  const mobileNav=document.querySelector('[data-mobile-nav]');
  function setMenu(open){
    if(!menuButton||!mobileNav)return;
    menuButton.setAttribute('aria-expanded',String(open));
    mobileNav.hidden=!open;
    document.body.classList.toggle('g-menu-open',open);
  }
  menuButton?.addEventListener('click',()=>setMenu(menuButton.getAttribute('aria-expanded')!=='true'));
  mobileNav?.addEventListener('click',event=>{if(event.target.closest('a'))setMenu(false);});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')setMenu(false);});

  const plannerUrl=(mode='new')=>`/planner.html?lang=${lang}&mode=${mode}`;
  function openPlanner(trigger,mode='new'){
    const placement=String(trigger?.dataset?.placement||'unknown');
    window.ITBMOFoundation?.track('planner_open',{placement,language:lang});
    const url=plannerUrl(mode);
    if(trigger?.tagName==='A'){
      trigger.href=url;trigger.target='_blank';trigger.rel='noopener';return;
    }
    const opened=window.open(url,'_blank','noopener');
    if(opened)opened.focus();
  }
  document.querySelectorAll('[data-planner-open]').forEach(trigger=>trigger.addEventListener('click',event=>{
    if(trigger.tagName!=='A')event.preventDefault();
    openPlanner(trigger,'new');
  }));
  document.querySelectorAll('[data-login-open]').forEach(trigger=>trigger.addEventListener('click',event=>{
    if(trigger.tagName!=='A')event.preventDefault();
    openPlanner(trigger,'access');
  }));

  /* Build-aware Planner warmup. Never hard-code a Planner asset version again. */
  let warmPromise=null;
  async function discoverPlannerAssets(){
    const response=await fetch(plannerUrl('new'),{credentials:'same-origin',cache:'force-cache'});
    if(!response.ok)throw new Error(`PLANNER_WARMUP_${response.status}`);
    const html=await response.text();
    const doc=new DOMParser().parseFromString(html,'text/html');
    return [...doc.querySelectorAll('link[rel="stylesheet"][href],script[src]')]
      .map(node=>node.getAttribute('href')||node.getAttribute('src'))
      .filter(Boolean)
      .filter(src=>!/^https?:/i.test(src))
      .filter(src=>/planner\.(?:css|js)|itbmo-(?:foundation|platform)\.js|travel-model-v2\.js/i.test(src));
  }
  function warmPlanner({full=true}={}){
    if(warmPromise)return warmPromise;
    warmPromise=discoverPlannerAssets().then(urls=>Promise.allSettled((full?urls:urls.filter(url=>/\.css/i.test(url))).map(url=>fetch(url,{credentials:'same-origin',cache:'force-cache'})))).catch(()=>null);
    return warmPromise;
  }
  document.querySelectorAll('[data-planner-open],[data-login-open]').forEach(trigger=>{
    trigger.addEventListener('pointerenter',()=>warmPlanner({full:true}),{once:true,passive:true});
    trigger.addEventListener('focus',()=>warmPlanner({full:true}),{once:true});
    trigger.addEventListener('touchstart',()=>warmPlanner({full:true}),{once:true,passive:true});
  });
  const connection=navigator.connection||navigator.mozConnection||navigator.webkitConnection;
  const fastEnough=!connection?.saveData&&(!connection?.effectiveType||connection.effectiveType==='4g');
  if(fastEnough){
    const idle=()=>warmPlanner({full:true});
    if('requestIdleCallback'in window)requestIdleCallback(idle,{timeout:6500});
    else setTimeout(idle,5200);
  }

  document.querySelectorAll('.g-faq-item button').forEach(button=>button.addEventListener('click',()=>{
    const answer=document.getElementById(button.getAttribute('aria-controls'));
    const open=button.getAttribute('aria-expanded')==='true';
    document.querySelectorAll('.g-faq-item button[aria-expanded="true"]').forEach(other=>{
      if(other===button)return;
      other.setAttribute('aria-expanded','false');
      const otherAnswer=document.getElementById(other.getAttribute('aria-controls'));
      if(otherAnswer)otherAnswer.hidden=true;
      const mark=other.querySelector('span');if(mark)mark.textContent='＋';
    });
    button.setAttribute('aria-expanded',String(!open));
    if(answer)answer.hidden=open;
    const mark=button.querySelector('span');if(mark)mark.textContent=open?'＋':'−';
  }));

  const partnerForm=document.querySelector('[data-partner-form]');
  if(partnerForm){
    const status=partnerForm.querySelector('[data-form-status]');
    partnerForm.addEventListener('submit',async event=>{
      event.preventDefault();
      const button=partnerForm.querySelector('button[type="submit"]');
      const data=Object.fromEntries(new FormData(partnerForm).entries());
      if(data.website_field)return;
      button.disabled=true;
      if(status){status.className='g-form-status';status.textContent=lang==='es'?'Enviando…':'Sending…';}
      try{
        const response=await fetch('/api/email',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({action:'partner_interest',lang,...data})});
        const result=await response.json().catch(()=>({}));
        if(!response.ok||!result.ok)throw new Error(result.code||'SEND_FAILED');
        partnerForm.reset();
        if(status){status.className='g-form-status is-success';status.textContent=lang==='es'?'Gracias. Recibimos tu propuesta y la revisaremos personalmente.':'Thank you. We received your proposal and will review it personally.';}
        window.ITBMOFoundation?.track('partner_interest_submit',{placement:'collaboration_page',language:lang});
      }catch(_){
        if(status){status.className='g-form-status is-error';status.innerHTML=lang==='es'?'No pudimos enviarlo. Escríbenos a <a href="mailto:affiliates@itravelbymyown.com">affiliates@itravelbymyown.com</a>.':'We could not send it. Email us at <a href="mailto:affiliates@itravelbymyown.com">affiliates@itravelbymyown.com</a>.';}
      }finally{button.disabled=false;}
    });
  }

  const reveals=[...document.querySelectorAll('.g-reveal')];
  if('IntersectionObserver'in window&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
    const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{
      if(entry.isIntersecting){entry.target.classList.add('is-visible');observer.unobserve(entry.target);}
    }),{rootMargin:'0px 0px -8% 0px',threshold:.08});
    reveals.forEach(node=>observer.observe(node));
  }else reveals.forEach(node=>node.classList.add('is-visible'));

  const sticky=document.querySelector('[data-sticky-cta]');
  const hero=document.querySelector('.g-hero,.g-page-hero');
  if(sticky&&hero&&'IntersectionObserver'in window){
    new IntersectionObserver(([entry])=>sticky.classList.toggle('is-visible',!entry.isIntersecting),{threshold:.05}).observe(hero);
  }

  /* Home carousel: real photographs, uninterrupted motion and accessible controls. */
  const carousel=document.querySelector('[data-hero-carousel]');
  if(carousel){
    const slides=[...carousel.querySelectorAll('[data-slide]')];
    const dots=[...carousel.querySelectorAll('[data-carousel-dot]')];
    const media=carousel.querySelector('.hc-hero__media');
    const controls=carousel.querySelector('.hc-carousel-controls');
    if(media&&controls)media.appendChild(controls);
    let current=0,timer=null,showToken=0;
    slides.forEach(slide=>{
      const caption=slide.querySelector('figcaption');
      if(!caption)return;
      const parts=caption.textContent.split(/\s·\s(?=(?:Foto|Photo):)/i);
      if(parts.length<2)return;
      caption.textContent='';
      const place=document.createElement('strong');place.textContent=parts[0];
      const credit=document.createElement('span');credit.textContent=parts.slice(1).join(' · ');
      caption.append(place,credit);
    });
    let captionFrame=0;
    const keepCaptionInsidePhoto=()=>{
      captionFrame=0;
      const caption=slides[current]?.querySelector('figcaption');
      if(!media||!caption)return;
      const photo=media.getBoundingClientRect();
      const topGap=16;
      const bottomGap=16;
      const header=document.querySelector('.g-header');
      const headerBottom=Math.max(0,Number(header?.getBoundingClientRect?.().bottom || 0));
      const desired=Math.max(0,headerBottom-photo.top+topGap);
      const limit=Math.max(0,photo.height-caption.offsetHeight-topGap-bottomGap);
      caption.style.setProperty('--caption-travel',`${Math.min(desired,limit)}px`);
    };
    const scheduleCaption=()=>{
      if(captionFrame)return;
      captionFrame=requestAnimationFrame(keepCaptionInsidePhoto);
    };
    const load=index=>{
      const slide=slides[(index+slides.length)%slides.length],image=slide?.querySelector('img');
      if(!image)return Promise.resolve();
      if(image.dataset.src&&!image.getAttribute('src')){image.src=image.dataset.src;delete image.dataset.src;}
      if(image.complete&&image.naturalWidth)return Promise.resolve();
      return new Promise(resolve=>{image.addEventListener('load',resolve,{once:true});image.addEventListener('error',resolve,{once:true});});
    };
    const show=async index=>{
      const next=(index+slides.length)%slides.length,token=++showToken;
      await load(next);if(token!==showToken)return;
      current=next;
      slides.forEach((slide,i)=>slide.classList.toggle('is-active',i===current));
      dots.forEach((dot,i)=>{dot.classList.toggle('is-active',i===current);dot.setAttribute('aria-current',i===current?'true':'false');});
      requestAnimationFrame(keepCaptionInsidePhoto);
      void load(current+1);
    };
    const stop=()=>{if(timer)clearInterval(timer);timer=null;};
    const start=()=>{stop();if(!document.hidden&&!matchMedia('(prefers-reduced-motion: reduce)').matches)timer=setInterval(()=>show(current+1),1500);};
    carousel.querySelector('[data-carousel-prev]')?.addEventListener('click',()=>{show(current-1);start();});
    carousel.querySelector('[data-carousel-next]')?.addEventListener('click',()=>{show(current+1);start();});
    dots.forEach(dot=>dot.addEventListener('click',()=>{show(Number(dot.dataset.carouselDot||0));start();}));
    carousel.addEventListener('focusin',stop);carousel.addEventListener('focusout',start);document.addEventListener('visibilitychange',()=>document.hidden?stop():start());window.addEventListener('scroll',scheduleCaption,{passive:true});window.addEventListener('resize',scheduleCaption,{passive:true});void load(1);show(0);start();
  }

  /* Faithful product walkthrough: one clear workspace state at a time. */
  const workspaceMarkup=lang==='es'?`
    <div class="hc-workspace__journey"><span>RECORRIDO REAL EN ITBMO</span><strong data-workspace-step>1 de 5 · Mis viajes</strong></div>
    <div class="hc-workspace__rail" role="tablist" aria-label="Recorrido de un viaje generado">
      <button class="is-active" type="button" role="tab" aria-selected="true" data-workspace-tab="trips">1 · Mis viajes</button>
      <button type="button" role="tab" aria-selected="false" data-workspace-tab="cities">2 · Todas las ciudades</button>
      <button type="button" role="tab" aria-selected="false" data-workspace-tab="city">3 · Madrid</button>
      <button type="button" role="tab" aria-selected="false" data-workspace-tab="route">4 · Rutas del día</button>
      <button type="button" role="tab" aria-selected="false" data-workspace-tab="prepare">5 · Para tu viaje</button>
    </div>
    <div class="hc-workspace__screen">
      <div class="hc-ws-panel is-active" data-workspace-panel="trips">
        <div class="hc-ws-head"><small>TU HISTORIAL</small><h3>Mis viajes</h3><p>Elige una tarjeta para volver al recorrido que ya generaste.</p></div>
        <article class="hc-trip-card"><div class="hc-trip-card__number">01</div><span class="hc-status">✓ Listo para explorar</span><h4>Madrid · Segovia · Toledo · Barcelona · Montserrat · Girona</h4><p>1 may 2027 – 10 may 2027 · 6 ciudades · 10 días</p><button type="button" data-workspace-jump="cities">Abrir viaje →</button></article>
        <p class="hc-demo-note">Este ejemplo muestra un solo viaje para explicar el recorrido con claridad.</p>
      </div>
      <div class="hc-ws-panel" data-workspace-panel="cities">
        <div class="hc-ws-head"><small>TU VIAJE ITBMO</small><h3>¿Por dónde quieres empezar?</h3><p>Elige una ciudad para explorarla día a día y preparar lo que realmente necesitas.</p></div>
        <div class="hc-city-grid"><article><small>01 · 5 DÍAS</small><strong>Madrid</strong><button type="button" data-workspace-jump="city">Explorar →</button></article><article><small>02 · 1 DÍA</small><strong>Segovia</strong><span>Explorar →</span></article><article><small>03 · 1 DÍA</small><strong>Toledo</strong><span>Explorar →</span></article><article><small>04 · 5 DÍAS</small><strong>Barcelona</strong><span>Explorar →</span></article><article><small>05 · 1 DÍA</small><strong>Montserrat</strong><span>Explorar →</span></article><article><small>06 · 1 DÍA</small><strong>Girona</strong><span>Explorar →</span></article></div>
        <div class="hc-global-help"><div><small>PARA TODO TU VIAJE</small><strong>Lo esencial viaja contigo.</strong><span>Recomendaciones generales de conectividad y protección.</span></div><article><b>◎ Conectividad</b><span>eSIM para mantenerte conectado.</span></article><article><b>◇ Seguro de viaje</b><span>Protección para el recorrido completo.</span></article></div>
      </div>
      <div class="hc-ws-panel" data-workspace-panel="city">
        <div class="hc-city-toolbar"><button type="button" data-workspace-jump="cities">← Todas las ciudades</button><div><small>TU CIUDAD</small><h3>Madrid</h3><span>1 may 2027 – 5 may 2027</span></div><div class="hc-city-mode"><b>⌁ Itinerario</b><button type="button" data-workspace-jump="prepare">✦ Para tu viaje</button></div></div>
        <div class="hc-day-chips"><b>Día 1 · 1 may 2027</b><span>Día 2 · 2 may</span><span>Día 3 · 3 may</span><span>Día 4 · 4 may</span><span>Día 5 · 5 may</span></div>
        <div class="hc-city-route-callout"><div><small>RUTAS DEL DÍA</small><strong>Muévete con tu itinerario</strong><span>Abre una ruta sólo cuando la necesites.</span></div><button type="button" data-workspace-jump="route">Preparar ruta →</button></div>
        <div class="hc-timeline"><article><time>13:00</time><div><strong>Acceso local al Palacio Real</strong><span>A pie · aproximadamente 20–25 min</span></div></article><article><time>13:25</time><div><strong>Visita del Palacio Real de Madrid</strong><span>Actividad · 2 h</span></div></article><article><time>15:25</time><div><strong>Almuerzo y pausa en el entorno de Ópera</strong><span>Actividad · 45 min</span></div></article><article><time>16:10</time><div><strong>Visita de la Catedral de la Almudena</strong><span>Actividad · 45 min</span></div></article></div>
      </div>
      <div class="hc-ws-panel" data-workspace-panel="route">
        <div class="hc-city-toolbar hc-city-toolbar--compact"><button type="button" data-workspace-jump="city">← Itinerario</button><div><small>MADRID · DÍA 1</small><h3>Muévete con tu itinerario</h3><span>Google Maps y Waze cuando los necesitas.</span></div></div>
        <div class="hc-route-box"><label>Desde<strong>Palacio Real de Madrid</strong></label><label>Hasta<strong>Plaza de Oriente</strong></label><div class="hc-route-points"><span><b>13:00</b> Palacio Real</span><span><b>15:25</b> Plaza de Oriente</span><span><b>16:10</b> Almudena</span><span><b>16:55</b> Plaza Mayor</span></div><div class="hc-route-actions"><button>◉ Usar mi ubicación</button><button class="is-primary">Preparar ruta</button><button>Google Maps ↗</button><button>Waze ↗</button></div><p>La ubicación se solicita sólo cuando la usas y no se guarda en ITBMO.</p></div>
      </div>
      <div class="hc-ws-panel" data-workspace-panel="prepare">
        <div class="hc-city-toolbar"><button type="button" data-workspace-jump="city">← Itinerario</button><div><small>TU CIUDAD</small><h3>Madrid</h3><span>Tu itinerario es sólo el comienzo.</span></div><div class="hc-city-mode"><button type="button" data-workspace-jump="city">⌁ Itinerario</button><b>✦ Para tu viaje</b></div></div>
        <div class="hc-prepare-tabs"><b>Entradas y reservas</b><span>Tours y experiencias</span><span>Cómo moverte</span></div>
        <div class="hc-entry-grid"><article><small>DÍA 1 · ENTRADA NECESARIA</small><strong>Palacio Real de Madrid</strong><p>Consulta acceso y horarios para la fecha de tu itinerario.</p><div><span>GetYourGuide</span><button>Ver opciones →</button></div><div><span>Viator</span><button>Ver opciones →</button></div></article><article><small>DÍA 3 · ENTRADA NECESARIA</small><strong>Museo del Prado</strong><p>Prepara la entrada que corresponda a tu recorrido.</p><div><span>GetYourGuide</span><button>Ver opciones →</button></div><div><span>Viator</span><button>Ver opciones →</button></div></article><article class="hc-entry-grid__wide"><small>CÓMO MOVERTE · MADRID – SEGOVIA</small><strong>Compara la conexión que encaja con tu ruta</strong><p>Opciones de tren, bus y traslado relacionadas con el itinerario.</p><div class="hc-provider-row"><span>Omio</span><span>12Go</span><span>Bookaway</span></div></article></div>
      </div>
    </div>`:`
    <div class="hc-workspace__journey"><span>THE REAL ITBMO JOURNEY</span><strong data-workspace-step>1 of 5 · My trips</strong></div>
    <div class="hc-workspace__rail" role="tablist" aria-label="Generated trip journey"><button class="is-active" type="button" role="tab" aria-selected="true" data-workspace-tab="trips">1 · My trips</button><button type="button" role="tab" aria-selected="false" data-workspace-tab="cities">2 · All cities</button><button type="button" role="tab" aria-selected="false" data-workspace-tab="city">3 · Madrid</button><button type="button" role="tab" aria-selected="false" data-workspace-tab="route">4 · Day routes</button><button type="button" role="tab" aria-selected="false" data-workspace-tab="prepare">5 · For your trip</button></div>
    <div class="hc-workspace__screen">
      <div class="hc-ws-panel is-active" data-workspace-panel="trips"><div class="hc-ws-head"><small>YOUR HISTORY</small><h3>My trips</h3><p>Choose a card to return to a trip you already generated.</p></div><article class="hc-trip-card"><div class="hc-trip-card__number">01</div><span class="hc-status">✓ Ready to explore</span><h4>Madrid · Segovia · Toledo · Barcelona · Montserrat · Girona</h4><p>May 1, 2027 – May 10, 2027 · 6 cities · 10 days</p><button type="button" data-workspace-jump="cities">Open trip →</button></article><p class="hc-demo-note">This example shows one trip so the journey stays easy to understand.</p></div>
      <div class="hc-ws-panel" data-workspace-panel="cities"><div class="hc-ws-head"><small>YOUR ITBMO TRIP</small><h3>Where do you want to start?</h3><p>Choose a city to explore it day by day and prepare what you really need.</p></div><div class="hc-city-grid"><article><small>01 · 5 DAYS</small><strong>Madrid</strong><button type="button" data-workspace-jump="city">Explore →</button></article><article><small>02 · 1 DAY</small><strong>Segovia</strong><span>Explore →</span></article><article><small>03 · 1 DAY</small><strong>Toledo</strong><span>Explore →</span></article><article><small>04 · 5 DAYS</small><strong>Barcelona</strong><span>Explore →</span></article><article><small>05 · 1 DAY</small><strong>Montserrat</strong><span>Explore →</span></article><article><small>06 · 1 DAY</small><strong>Girona</strong><span>Explore →</span></article></div><div class="hc-global-help"><div><small>FOR YOUR WHOLE TRIP</small><strong>The essentials travel with you.</strong><span>General connectivity and protection recommendations.</span></div><article><b>◎ Connectivity</b><span>eSIM options for your trip.</span></article><article><b>◇ Travel protection</b><span>Protection for the full journey.</span></article></div></div>
      <div class="hc-ws-panel" data-workspace-panel="city"><div class="hc-city-toolbar"><button type="button" data-workspace-jump="cities">← All cities</button><div><small>YOUR CITY</small><h3>Madrid</h3><span>May 1, 2027 – May 5, 2027</span></div><div class="hc-city-mode"><b>⌁ Itinerary</b><button type="button" data-workspace-jump="prepare">✦ For your trip</button></div></div><div class="hc-day-chips"><b>Day 1 · May 1</b><span>Day 2 · May 2</span><span>Day 3 · May 3</span><span>Day 4 · May 4</span><span>Day 5 · May 5</span></div><div class="hc-city-route-callout"><div><small>DAY ROUTES</small><strong>Move with your itinerary</strong><span>Open a route only when you need it.</span></div><button type="button" data-workspace-jump="route">Prepare route →</button></div><div class="hc-timeline"><article><time>13:00</time><div><strong>Local access to the Royal Palace</strong><span>Walk · approximately 20–25 min</span></div></article><article><time>13:25</time><div><strong>Royal Palace of Madrid</strong><span>Activity · 2 h</span></div></article><article><time>15:25</time><div><strong>Lunch break near Ópera</strong><span>Activity · 45 min</span></div></article><article><time>16:10</time><div><strong>Almudena Cathedral</strong><span>Activity · 45 min</span></div></article></div></div>
      <div class="hc-ws-panel" data-workspace-panel="route"><div class="hc-city-toolbar hc-city-toolbar--compact"><button type="button" data-workspace-jump="city">← Itinerary</button><div><small>MADRID · DAY 1</small><h3>Move with your itinerary</h3><span>Google Maps and Waze whenever you need them.</span></div></div><div class="hc-route-box"><label>From<strong>Royal Palace of Madrid</strong></label><label>To<strong>Plaza de Oriente</strong></label><div class="hc-route-points"><span><b>13:00</b> Royal Palace</span><span><b>15:25</b> Plaza de Oriente</span><span><b>16:10</b> Almudena</span><span><b>16:55</b> Plaza Mayor</span></div><div class="hc-route-actions"><button>◉ Use my location</button><button class="is-primary">Prepare route</button><button>Google Maps ↗</button><button>Waze ↗</button></div><p>Your location is requested only when used and is never stored by ITBMO.</p></div></div>
      <div class="hc-ws-panel" data-workspace-panel="prepare"><div class="hc-city-toolbar"><button type="button" data-workspace-jump="city">← Itinerary</button><div><small>YOUR CITY</small><h3>Madrid</h3><span>Your itinerary is only the beginning.</span></div><div class="hc-city-mode"><button type="button" data-workspace-jump="city">⌁ Itinerary</button><b>✦ For your trip</b></div></div><div class="hc-prepare-tabs"><b>Tickets and reservations</b><span>Tours and experiences</span><span>How to move</span></div><div class="hc-entry-grid"><article><small>DAY 1 · TICKET NEEDED</small><strong>Royal Palace of Madrid</strong><p>Check access and schedules for your itinerary date.</p><div><span>GetYourGuide</span><button>View options →</button></div><div><span>Viator</span><button>View options →</button></div></article><article><small>DAY 3 · TICKET NEEDED</small><strong>Prado Museum</strong><p>Prepare the right ticket for your route.</p><div><span>GetYourGuide</span><button>View options →</button></div><div><span>Viator</span><button>View options →</button></div></article><article class="hc-entry-grid__wide"><small>HOW TO MOVE · MADRID – SEGOVIA</small><strong>Compare the connection that fits your route</strong><p>Train, bus and transfer options connected to the itinerary.</p><div class="hc-provider-row"><span>Omio</span><span>12Go</span><span>Bookaway</span></div></article></div></div>
    </div>`;
  document.querySelectorAll('[data-workspace-demo]').forEach(demo=>{
    demo.innerHTML=workspaceMarkup;
    const tabs=[...demo.querySelectorAll('[data-workspace-tab]')];
    const panels=[...demo.querySelectorAll('[data-workspace-panel]')];
    const labels=lang==='es'?{trips:'Mis viajes',cities:'Todas las ciudades',city:'Madrid',route:'Rutas del día',prepare:'Para tu viaje'}:{trips:'My trips',cities:'All cities',city:'Madrid',route:'Day routes',prepare:'For your trip'};
    const open=key=>{
      panels.forEach(panel=>panel.classList.toggle('is-active',panel.dataset.workspacePanel===key));
      const activeTab=tabs.find(item=>item.dataset.workspaceTab===key);
      tabs.forEach(item=>{const active=item===activeTab;item.classList.toggle('is-active',active);item.setAttribute('aria-selected',String(active));});
      const step=demo.querySelector('[data-workspace-step]'),index=tabs.indexOf(activeTab)+1;
      if(step)step.textContent=`${index} ${lang==='es'?'de':'of'} ${tabs.length} · ${labels[key]||''}`;
      window.ITBMOFoundation?.track('workspace_preview_opened',{section:key,language:lang});
    };
    tabs.forEach(tab=>tab.addEventListener('click',()=>open(tab.dataset.workspaceTab)));
    demo.addEventListener('click',event=>{const trigger=event.target.closest('[data-workspace-jump]');if(trigger)open(trigger.dataset.workspaceJump);});
  });

  /* A faithful Reykjavik PDF, explored day by day instead of a wall of pages. */
  document.querySelectorAll('.sample-pdf-pages').forEach(container=>{
    const images=[...container.querySelectorAll('img')].map(image=>({src:image.currentSrc||image.src,alt:image.alt}));
    if(images.length<7)return;
    const days=[[0],[1],[2,3],[4,5],[6],[7,8],[9]];
    const titles=lang==='es'?['Reikiavik y costa urbana','Círculo Dorado','Costa Sur hasta Vík','Península de Snæfellsnes','Reykjanes y geología costera','Cultura, termalismo y auroras','Hvalfjörður y cierre del viaje']:['Reykjavik and the urban coast','Golden Circle','South Coast to Vík','Snæfellsnes Peninsula','Reykjanes coastal geology','Culture, geothermal time and auroras','Hvalfjörður and trip finale'];
    let day=0,page=0;
    container.classList.add('sample-day-explorer');
    container.innerHTML=`<div class="sample-day-tabs" role="tablist" aria-label="${lang==='es'?'Días del itinerario':'Itinerary days'}">${days.map((_,index)=>`<button type="button" role="tab" data-sample-day="${index}" aria-selected="${index===0}">${lang==='es'?'Día':'Day'} ${index+1}</button>`).join('')}</div><div class="sample-viewer"><div class="sample-viewer__toolbar"><div><small data-sample-counter></small><strong data-sample-title></strong></div><div class="sample-viewer__pages"><button type="button" data-sample-prev aria-label="${lang==='es'?'Página anterior':'Previous page'}">←</button><span data-sample-page></span><button type="button" data-sample-next aria-label="${lang==='es'?'Página siguiente':'Next page'}">→</button></div></div><div class="sample-viewer__frame"><img data-sample-image alt=""></div><p class="sample-viewer__truth">${lang==='es'?'Página exacta del PDF generado por ITBMO. El contenido no fue resumido ni recreado.':'Exact page from the PDF generated by ITBMO. The content has not been summarized or recreated.'}</p></div>`;
    const dayButtons=[...container.querySelectorAll('[data-sample-day]')],image=container.querySelector('[data-sample-image]'),title=container.querySelector('[data-sample-title]'),counter=container.querySelector('[data-sample-counter]'),pageLabel=container.querySelector('[data-sample-page]'),prev=container.querySelector('[data-sample-prev]'),next=container.querySelector('[data-sample-next]');
    const render=()=>{
      const indexes=days[day],source=images[indexes[page]];
      image.src=source.src;image.alt=source.alt;
      title.textContent=titles[day];counter.textContent=`${lang==='es'?'Día':'Day'} ${day+1} ${lang==='es'?'de':'of'} 7`;
      pageLabel.textContent=indexes.length>1?`${lang==='es'?'Página':'Page'} ${page+1} ${lang==='es'?'de':'of'} ${indexes.length}`:`${lang==='es'?'Página':'Page'} ${indexes[0]+1} ${lang==='es'?'del PDF':'of the PDF'}`;
      prev.disabled=page===0;next.disabled=page===indexes.length-1;
      dayButtons.forEach((button,index)=>{const active=index===day;button.classList.toggle('is-active',active);button.setAttribute('aria-selected',String(active));});
    };
    dayButtons.forEach(button=>button.addEventListener('click',()=>{day=Number(button.dataset.sampleDay);page=0;render();}));
    prev.addEventListener('click',()=>{if(page>0){page--;render();}});next.addEventListener('click',()=>{if(page<days[day].length-1){page++;render();}});render();
  });

  const conversionCopy=document.querySelector('.hc-conversion>.g-shell>div:first-child>p');
  if(conversionCopy&&(page==='home'||page==='sample'))conversionCopy.textContent=lang==='es'?'Completa los datos de tu viaje, revisa el precio y genera sólo cuando estés listo.':'Complete your trip details, review the price and generate only when you are ready.';

  window.ITBMOFoundation?.track('view_home',{placement:page,language:lang});
})();

