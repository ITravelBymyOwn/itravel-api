/* I TRAVEL — BY MY OWN · v1.1 UI interactions */
(function(){
  const $=(s,ctx=document)=>ctx.querySelector(s);
  const $$=(s,ctx=document)=>Array.from(ctx.querySelectorAll(s));

  // Año footer
  const y=$("#y"); if(y) y.textContent=new Date().getFullYear();

  // Loader
  const loader=$("#app-loader");
  const showLoader=()=>{ if(!loader) return; loader.classList.remove("hidden"); loader.setAttribute("aria-hidden","false"); };
  const hideLoader=()=>{ if(!loader) return; loader.classList.add("hidden"); loader.setAttribute("aria-hidden","true"); };
  document.addEventListener("readystatechange",()=>{ if(document.readyState==="interactive") showLoader(); if(document.readyState==="complete") hideLoader(); });
  window.addEventListener("load", hideLoader);
  $$(".btn[href], .nav-menu a, a[data-nav]").forEach(a=>{
    a.addEventListener("click", e=>{
      const href=a.getAttribute("href")||""; const isHash=href.startsWith("#"); const isExt=/^https?:\/\//i.test(href);
      if(!isHash && !isExt) { showLoader(); setTimeout(()=>{},60); }
    });
  });

  // Menú responsive
  const navToggle=$(".nav-toggle"); const navMenu=$("#nav-menu");
  if(navToggle && navMenu){
    navToggle.addEventListener("click",()=>{
      const open=navMenu.style.display==="flex"; navMenu.style.display=open?"none":"flex"; navToggle.setAttribute("aria-expanded", String(!open));
    });
    $$("#nav-menu a").forEach(l=>l.addEventListener("click",()=>{
      if(getComputedStyle(navToggle).display!=="none"){ navMenu.style.display="none"; navToggle.setAttribute("aria-expanded","false"); }
    }));
    document.addEventListener("click",(e)=>{
      const within=navMenu.contains(e.target) || navToggle.contains(e.target);
      if(!within && getComputedStyle(navToggle).display!=="none"){ navMenu.style.display="none"; navToggle.setAttribute("aria-expanded","false"); }
    });
    window.addEventListener("resize",()=>{ if(window.innerWidth>720){ navMenu.style.display="flex"; navToggle.setAttribute("aria-expanded","false"); } else { navMenu.style.display="none"; }});
  }

  // Activar imágenes reales cuando se añadan URLs
  function wireImage(imgSel, creditSel, photos){
    const img=$(imgSel); const cap=$(creditSel);
    if(!img || !photos || photos.length===0) return;

    let idx=0;
    const apply=(p)=>{
      if(!p || !p.src) return;
      img.src=p.src; img.alt=p.alt||"Foto de viaje";
      img.addEventListener("load",()=>{
        const ph=img.nextElementSibling; if(ph && ph.classList.contains("img-placeholder")){ ph.style.display="none"; img.style.display="block"; }
        if(cap) cap.textContent = p.credit || "";
      }, { once:true });
    };
    apply(photos[0]);

    // Rotación simple cada 9s
    setInterval(()=>{
      idx=(idx+1)%photos.length; apply(photos[idx]);
    }, 9000);
  }

  // Array de fotos: reemplaza por tus URLs libres (Unsplash/Pexels) cuando las tengas.
  const heroPhotos=[
    { src:"/img/hero-iceland.jpg", alt:"Auroras en Islandia", credit:"Foto: Unsplash (cambiar URL real)" },
    { src:"/img/hero-kyoto.jpg",   alt:"Templos en Kyoto",   credit:"Foto: Unsplash (cambiar URL real)" },
    { src:"/img/hero-tromso.jpg",  alt:"Paisaje ártico",     credit:"Foto: Unsplash (cambiar URL real)" },
    { src:"/img/hero-santorini.jpg",alt:"Santorini al atardecer", credit:"Foto: Unsplash (cambiar URL real)" }
  ];
  wireImage("#hero-img", "#photo-credit", heroPhotos);

  const mockupPhotos=[
    { src:"/img/mockup-map.jpg", alt:"Mapa de ruta", credit:"" }
  ];
  wireImage("#mockup-img", null, mockupPhotos);

  // Tracing afiliados (data-aff) — listo para conectar a tu EventBus/analítica
  $$("[data-aff]").forEach(el=>{
    el.addEventListener("click",()=>{
      const tag=el.getAttribute("data-aff");
      try{ window.dispatchEvent(new CustomEvent("aff:click",{ detail:{ tag, ts:Date.now() } })); }catch(_){}
    });
  });

  // Accesibilidad: focus visible en teclado
  function handleFirstTab(e){ if(e.key==="Tab"){ document.body.classList.add("user-is-tabbing"); window.removeEventListener("keydown",handleFirstTab); } }
  window.addEventListener("keydown",handleFirstTab);
})();
