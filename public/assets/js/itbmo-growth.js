/* ITBMO V297 · Commercial, resources and destination shell
   One code path for Home + product pages, inside Webflow or standalone. */
(() => {
  'use strict';

  document.documentElement.classList.add('js');

  const lang=(document.documentElement.lang||'es').toLowerCase().startsWith('en')?'en':'es';
  const page=String(document.body?.dataset?.page||'home');
  const rawRoutes={
    home:{es:'./preview-home.html',en:'./preview-home-en.html'},
    how:{es:'./como-funciona.html',en:'./how-it-works.html'},
    sample:{es:'./ejemplo-itinerario.html',en:'./sample-itinerary.html'},
    pricing:{es:'./precios.html',en:'./pricing.html'},
    about:{es:'./acerca-de-itbmo.html',en:'./about-itbmo.html'},
    destinations:{es:'./destinos.html',en:'./destinations.html'},
    resources:{es:'./recursos.html',en:'./resources.html'},
    collaborate:{es:'./colabora.html',en:'./partner-with-itbmo.html'},
    support:{es:'./support-contact.html',en:'./support-contact-en.html'},
    privacy:{es:'./privacy-cookies.html',en:'./privacy-cookies-en.html'},
    terms:{es:'./terms.html',en:'./terms-en.html'},
    affiliates:{es:'./ads-affiliates.html',en:'./ads-affiliates-en.html'}
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

  const plannerUrl=(mode='new')=>`./planner.html?lang=${lang}&mode=${mode}`;
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
    openPlanner(trigger,'login');
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

  window.ITBMOFoundation?.track('view_home',{placement:page,language:lang});
})();
