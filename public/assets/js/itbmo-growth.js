/* ITBMO V297.4 · Commercial, resources and destination shell
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
      home:'Inicio',how:'Cómo funciona',sample:'Ejemplo real',destinations:'Destinos',resources:'Recursos',pricing:'Precios',login:'Ingresar',plan:'Crear itinerario',tagline:'Tu viaje. Tu estilo. Una ruta diseñada para ti.',discover:'EXPLORA',company:'ITBMO',help:'AYUDA',start:'EMPIEZA',about:'Acerca de',collaborate:'Colabora',support:'Soporte',privacy:'Privacidad',terms:'Términos',rights:'Todos los derechos reservados.',world:'Diseñado para viajeros de todo el mundo.'
    }:{
      home:'Home',how:'How it works',sample:'Real example',destinations:'Destinations',resources:'Resources',pricing:'Pricing',login:'Sign in',plan:'Create itinerary',tagline:'Your trip. Your style. A route designed for you.',discover:'EXPLORE',company:'ITBMO',help:'HELP',start:'START',about:'About',collaborate:'Partner with us',support:'Support',privacy:'Privacy',terms:'Terms',rights:'All rights reserved.',world:'Designed for travelers worldwide.'
    };
    const header=document.querySelector('.g-header');
    if(header){
      header.innerHTML=`<div class="g-header__inner"><a class="g-brand" href="${marketingTarget('home')}" data-route="home" aria-label="ITBMO · ${labels.home}"><picture><source srcset="/assets/img/itbmo-logo-premium.webp" type="image/webp"><img src="/assets/img/itbmo-logo-premium.jpg" alt="I Travel By My Own" width="154" height="59"></picture></a><nav class="g-nav" aria-label="${lang==='es'?'Navegación principal':'Main navigation'}"><a href="${marketingTarget('home')}" data-route="home">${labels.home}</a><a href="${marketingTarget('how')}" data-route="how">${labels.how}</a><a href="${marketingTarget('sample')}" data-route="sample">${labels.sample}</a><a href="${marketingTarget('destinations')}" data-route="destinations">${labels.destinations}</a><a href="${marketingTarget('resources')}" data-route="resources">${labels.resources}</a><a href="${marketingTarget('pricing')}" data-route="pricing">${labels.pricing}</a></nav><div class="g-header__actions"><a class="g-login" href="/planner.html?lang=${lang}&mode=access" target="_blank" rel="noopener" data-login-open data-placement="navbar_login">${labels.login}</a><a class="g-button g-button--primary g-button--compact" href="/planner.html?lang=${lang}&mode=new" target="_blank" rel="noopener" data-planner-open data-placement="navbar">${labels.plan}</a></div><div class="g-lang"><button class="${lang==='es'?'is-active':''}" type="button" data-site-lang="es">ES</button><button class="${lang==='en'?'is-active':''}" type="button" data-site-lang="en">EN</button></div><button class="g-menu-toggle" type="button" aria-expanded="false" aria-controls="g-mobile-nav" data-menu-toggle aria-label="${lang==='es'?'Abrir menú':'Open menu'}"><span></span><span></span><span></span></button></div>`;
    }
    let mobile=document.querySelector('[data-mobile-nav]');
    if(!mobile&&header){mobile=document.createElement('nav');mobile.className='g-mobile-nav';mobile.id='g-mobile-nav';mobile.dataset.mobileNav='';mobile.hidden=true;header.insertAdjacentElement('afterend',mobile);}
    if(mobile)mobile.innerHTML=`<a href="${marketingTarget('home')}" data-route="home">${labels.home}<span>→</span></a><a href="${marketingTarget('how')}" data-route="how">${labels.how}<span>→</span></a><a href="${marketingTarget('sample')}" data-route="sample">${labels.sample}<span>→</span></a><a href="${marketingTarget('destinations')}" data-route="destinations">${labels.destinations}<span>→</span></a><a href="${marketingTarget('resources')}" data-route="resources">${labels.resources}<span>→</span></a><a href="${marketingTarget('pricing')}" data-route="pricing">${labels.pricing}<span>→</span></a><a href="/planner.html?lang=${lang}&mode=access" target="_blank" rel="noopener" data-login-open data-placement="mobile_login">${labels.login}<span>→</span></a><a class="g-button g-button--primary" href="/planner.html?lang=${lang}&mode=new" target="_blank" rel="noopener" data-planner-open data-placement="mobile_menu">${labels.plan}</a>`;
    const footer=document.querySelector('.g-footer');
    if(footer)footer.innerHTML=`<div class="g-shell"><div class="g-footer__grid"><div class="g-footer__brand"><strong>ITBMO</strong><p>${labels.tagline}</p><div class="g-footer__social" data-itbmo-social-links></div></div><div class="g-footer__column"><strong>${labels.discover}</strong><a href="${marketingTarget('how')}" data-route="how">${labels.how}</a><a href="${marketingTarget('sample')}" data-route="sample">${labels.sample}</a><a href="${marketingTarget('destinations')}" data-route="destinations">${labels.destinations}</a><a href="${marketingTarget('resources')}" data-route="resources">${labels.resources}</a></div><div class="g-footer__column"><strong>${labels.company}</strong><a href="${marketingTarget('about')}" data-route="about">${labels.about}</a><a href="${marketingTarget('collaborate')}" data-route="collaborate">${labels.collaborate}</a><a href="${marketingTarget('pricing')}" data-route="pricing">${labels.pricing}</a></div><div class="g-footer__column"><strong>${labels.help}</strong><a href="${marketingTarget('support')}" data-route="support">${labels.support}</a><a href="${marketingTarget('privacy')}" data-route="privacy">${labels.privacy}</a><a href="${marketingTarget('terms')}" data-route="terms">${labels.terms}</a></div><div class="g-footer__column"><strong>${labels.start}</strong><a href="/planner.html?lang=${lang}&mode=access" target="_blank" rel="noopener" data-login-open data-placement="footer_login">${labels.login}</a><a href="/planner.html?lang=${lang}&mode=new" target="_blank" rel="noopener" data-planner-open data-placement="footer">${labels.plan}</a></div></div><div class="g-footer__bottom"><span>© 2026 I Travel By My Own. ${labels.rights}</span><span>${labels.world}</span></div></div>`;
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

  /* Home carousel: real photographs, pause on interaction and respect motion preferences. */
  const carousel=document.querySelector('[data-hero-carousel]');
  if(carousel){
    const slides=[...carousel.querySelectorAll('[data-slide]')];
    const dots=[...carousel.querySelectorAll('[data-carousel-dot]')];
    let current=0,timer=null,paused=false,showToken=0;
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
      void load(current+1);
    };
    const stop=()=>{if(timer)clearInterval(timer);timer=null;};
    const start=()=>{stop();if(!paused&&!document.hidden&&!matchMedia('(prefers-reduced-motion: reduce)').matches)timer=setInterval(()=>show(current+1),4300);};
    carousel.querySelector('[data-carousel-prev]')?.addEventListener('click',()=>{show(current-1);start();});
    carousel.querySelector('[data-carousel-next]')?.addEventListener('click',()=>{show(current+1);start();});
    dots.forEach(dot=>dot.addEventListener('click',()=>{show(Number(dot.dataset.carouselDot||0));start();}));
    carousel.addEventListener('mouseenter',()=>{paused=true;stop();});carousel.addEventListener('mouseleave',()=>{paused=false;start();});
    carousel.addEventListener('focusin',stop);carousel.addEventListener('focusout',start);document.addEventListener('visibilitychange',()=>document.hidden?stop():start());void load(1);show(0);start();
  }

  /* Faithful product walkthrough: one clear workspace state at a time. */
  document.querySelectorAll('[data-workspace-demo]').forEach(demo=>{
    const tabs=[...demo.querySelectorAll('[data-workspace-tab]')];
    const panels=[...demo.querySelectorAll('[data-workspace-panel]')];
    tabs.forEach(tab=>tab.addEventListener('click',()=>{
      const key=tab.dataset.workspaceTab;
      tabs.forEach(item=>{const active=item===tab;item.classList.toggle('is-active',active);item.setAttribute('aria-selected',String(active));});
      panels.forEach(panel=>panel.classList.toggle('is-active',panel.dataset.workspacePanel===key));
      window.ITBMOFoundation?.track('workspace_preview_opened',{section:key,language:lang});
    }));
  });

  window.ITBMOFoundation?.track('view_home',{placement:page,language:lang});
})();
