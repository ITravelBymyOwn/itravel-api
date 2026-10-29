(()=>{
  'use strict';
  const copy={
    es:{
      common:{k:'AYÚDANOS A AFINAR ITBMO',comment:'¿Quieres contarnos algo más?',placeholder:'Qué te resultó útil o qué faltó…',sensitive:'No incluyas contraseñas, datos financieros ni documentos personales.',contact:'Pueden contactarme para dar seguimiento.',send:'Enviar',later:'Ahora no',thanks:'Gracias. Tu opinión ya está ayudando a mejorar ITBMO.',error:'No pudimos guardar tu evaluación. Intenta nuevamente.',support:'¿Necesitas ayuda con tu viaje?',supportCta:'Contactar soporte',stars:'Califica de 1 a 5 estrellas',rate:'CALIFICA AHORA'},
      itinerary:{title:'¿Cómo calificarías la calidad general de tu itinerario?',body:'Evalúa la organización, coherencia y utilidad del viaje completo.',restore:'Calificar mi itinerario'},
      prepare:{title:'¿Para tu viaje te ayudó a preparar {city}?',body:'Tu respuesta mejora la preparación de esta ciudad y de futuros viajes.',restore:'Dar opinión sobre esta ciudad'}
    },
    en:{
      common:{k:'HELP US REFINE ITBMO',comment:'Would you like to tell us more?',placeholder:'What helped, or what was missing…',sensitive:'Do not include passwords, financial information or personal documents.',contact:'You may contact me to follow up.',send:'Send',later:'Not now',thanks:'Thank you. Your feedback is already helping improve ITBMO.',error:'We could not save your feedback. Please try again.',support:'Need help with your trip?',supportCta:'Contact support',stars:'Rate from 1 to 5 stars',rate:'RATE NOW'},
      itinerary:{title:'How would you rate the overall quality of your itinerary?',body:'Rate the organization, coherence and usefulness of the complete trip.',restore:'Rate my itinerary'},
      prepare:{title:'Did For your trip help you prepare {city}?',body:'Your answer improves how we prepare this city and future trips.',restore:'Share feedback about this city'}
    }
  };
  const seen=new Set();
  const lang=()=>document.documentElement.lang?.startsWith('en')?'en':'es';
  const city=()=>document.querySelector('#tw-city-name')?.textContent?.trim()||'';
  const token=()=>{try{return sessionStorage.getItem('itbmo_guest_session_token')||localStorage.getItem('itbmo_session_token')||''}catch(_){return''}};
  const tripId=()=>{try{const snap=JSON.parse(localStorage.getItem('itbmo_trip_workspace_snapshot_v1')||'null');return String(new URLSearchParams(location.search).get('trip_id')||snap?.trip_id||localStorage.getItem('itbmo_active_trip_id')||'')}catch(_){return''}};
  const track=(name,p={})=>window.ITBMOFoundation?.track?.(name,p);
  const contextKey=(scope,destination='')=>scope==='itinerary'?'itinerary:overall':`prepare:${destination.toLocaleLowerCase()}`;
  function definition(scope){
    const destination=scope==='prepare'?city():'';const strings=copy[lang()];
    return scope==='itinerary'
      ? {scope,destination:'',key:contextKey(scope),type:'trip_planning',placement:'workspace_overview_end',...strings.itinerary,common:strings.common}
      : {scope,destination,key:contextKey(scope,destination),type:'workspace',placement:'city_prepare_end',...strings.prepare,common:strings.common};
  }
  function visible(scope){return scope==='itinerary'?!document.querySelector('#tw-overview')?.hidden:!document.querySelector('#tw-city')?.hidden&&document.querySelector('#tw-mode-prepare')?.classList.contains('active')}
  function build(host,def){
    const t=def.common,state={rating:0,started:false,submitting:false};host.dataset.context=def.key;host.classList.remove('is-collapsed','is-complete');
    const place=def.destination||(lang()==='en'?'this city':'esta ciudad');const title=def.title.replace('{city}',place);
    host.innerHTML=`<div class="tw-feedback__main"><span class="tw-feedback__mark" aria-hidden="true">✦</span><div class="tw-feedback__copy"><small>${t.k}</small><h2>${title}</h2><p>${def.body}</p></div><div class="tw-feedback__rating"><small>${t.rate}</small><div class="tw-feedback__stars" role="radiogroup" aria-label="${t.stars}">${[1,2,3,4,5].map(n=>`<button type="button" role="radio" aria-checked="false" data-rating="${n}" aria-label="${n}">★</button>`).join('')}</div></div><button class="tw-feedback__dismiss tw-feedback__dismiss--icon" type="button" aria-label="${t.later}">×</button></div><div class="tw-feedback__details" hidden><label class="tw-feedback__comment"><span>${t.comment}</span><textarea maxlength="1200" rows="2" placeholder="${t.placeholder}"></textarea><small>${t.sensitive}</small></label><div class="tw-feedback__details-foot"><label class="tw-feedback__consent"><input type="checkbox"><span>${t.contact}</span></label><div class="tw-feedback__actions"><button class="tw-feedback__dismiss" type="button">${t.later}</button><button class="tw-feedback__submit" type="button">${t.send}</button></div></div><p class="tw-feedback__message" aria-live="polite"></p><div class="tw-feedback__recovery" hidden><span>${t.support}</span><a href="./support-contact${lang()==='en'?'-en':''}.html">${t.supportCta}</a></div></div><button class="tw-feedback__restore" type="button"><span aria-hidden="true">★★★★★</span>${def.restore}</button>`;
    const stars=[...host.querySelectorAll('[data-rating]')],details=host.querySelector('.tw-feedback__details'),submit=host.querySelector('.tw-feedback__submit'),message=host.querySelector('.tw-feedback__message');
    stars.forEach(button=>button.onclick=()=>{state.rating=Number(button.dataset.rating);stars.forEach((star,index)=>{star.classList.toggle('is-active',index<state.rating);star.setAttribute('aria-checked',Number(star.dataset.rating)===state.rating?'true':'false')});details.hidden=false;host.classList.add('is-expanded');host.querySelector('.tw-feedback__recovery').hidden=state.rating>2;if(!state.started){state.started=true;track('feedback_started',{feedback_type:def.type,placement:def.placement,destination:def.destination})}});
    const collapse=()=>{host.classList.add('is-collapsed');track('feedback_collapsed',{feedback_type:def.type,placement:def.placement,destination:def.destination})};
    host.querySelectorAll('.tw-feedback__dismiss').forEach(button=>button.onclick=collapse);
    host.querySelector('.tw-feedback__restore').onclick=()=>{host.classList.remove('is-collapsed');track('feedback_restored',{feedback_type:def.type,placement:def.placement,destination:def.destination})};
    submit.onclick=async()=>{if(!state.rating||state.submitting)return;state.submitting=true;submit.disabled=true;message.textContent='';try{const response=await fetch('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_token:token(),trip_id:tripId()||null,source_surface:'workspace',feedback_type:def.type,context_key:def.key,placement:def.placement,destination:def.destination||null,rating_overall:state.rating,comment:host.querySelector('textarea').value,ui_language:lang(),consent_to_contact:host.querySelector('.tw-feedback__consent input').checked})});const result=await response.json().catch(()=>({}));if(!response.ok&&result.code!=='DUPLICATE_FEEDBACK')throw new Error(result.code||'FAILED');host.className=`tw-feedback tw-feedback--${def.scope} is-complete`;host.innerHTML=`<span class="tw-feedback__complete-mark">✓</span><p>${t.thanks}</p>`;track('feedback_submitted',{feedback_type:def.type,rating:state.rating,placement:def.placement,destination:def.destination})}catch(_){message.textContent=t.error;submit.disabled=false;state.submitting=false}};
  }
  function sync(){document.querySelectorAll('[data-feedback-scope]').forEach(host=>{const scope=host.dataset.feedbackScope,show=visible(scope);host.hidden=!show;if(!show)return;const def=definition(scope);if(host.dataset.context!==def.key)build(host,def);if(!seen.has(def.key)){seen.add(def.key);track('feedback_prompt_viewed',{feedback_type:def.type,placement:def.placement,destination:def.destination})}})}
  function ready(config){if(!config?.flags?.user_feedback_enabled)return;sync();window.addEventListener('tw:prepare-mode-changed',()=>setTimeout(sync,0));window.addEventListener('tw:city-entered',()=>setTimeout(sync,0));window.addEventListener('tw:overview-opened',()=>setTimeout(sync,0))}
  document.addEventListener('itbmo:platform-ready',event=>ready(event.detail),{once:true});if(window.ITBMOPlatform?.config)ready(window.ITBMOPlatform.config);
})();
