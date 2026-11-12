/* ITBMO V298 preview · confirmation recovery and Info Chat discoverability. */
(()=>{
  'use strict';
  const es=()=>String(document.documentElement.lang||'').toLowerCase().startsWith('es');
  const copy=()=>es()?{
    resend:'Reenviar correo de confirmación',resending:'Reenviando…',resent:'Listo. Enviamos un nuevo enlace; revisa también Spam o Promociones.',fail:'No pudimos reenviarlo todavía. Espera un momento e intenta nuevamente.',cooldown:n=>`Puedes reenviar otro enlace en ${n} s`,change:'Escribí mal mi correo',wrong:'Por seguridad, la confirmación sólo puede llegar al correo con el que se creó la cuenta. Abriremos el registro para que corrijas la dirección.',protected:'Este correo está vinculado a una planificación de invitado. Para no perderla, contáctanos desde Soporte y corregiremos la dirección de forma segura.',unconfirmed:'Tu correo aún no está confirmado. Reenvía el enlace para activar tu cuenta.',chatKicker:'✦ ASISTENTE DISPONIBLE',chatTitle:'Info Chat está listo',chatCopy:'Pregunta por zonas, transporte, clima, gastronomía o cualquier información útil para personalizar tu recorrido.',chatAction:'Preguntar ahora →'
  }:{
    resend:'Resend confirmation email',resending:'Resending…',resent:'Done. We sent a new link; check Spam or Promotions too.',fail:'We could not resend it yet. Wait a moment and try again.',cooldown:n=>`You can resend another link in ${n}s`,change:'I entered the wrong email',wrong:'For security, confirmation can only be sent to the address used to create the account. We will reopen registration so you can correct it.',protected:'This email is linked to guest planning. To avoid losing it, contact Support and we will correct the address securely.',unconfirmed:'Your email has not been confirmed yet. Resend the link to activate your account.',chatKicker:'✦ ASSISTANT AVAILABLE',chatTitle:'Info Chat is ready',chatCopy:'Ask about areas, transport, weather, food or any useful information before personalizing your journey.',chatAction:'Ask now →'
  };
  const q=s=>document.querySelector(s);
  const pendingKey='itbmo_pending_signup_v1';
  const pendingEmail=()=>String(q('#account-confirmation-email')?.textContent||q('#account-login-email')?.value||'').trim().toLowerCase();
  function status(message='',type=''){
    const node=q('#account-confirmation-status');if(!node)return;
    node.textContent=message;node.className=`account-confirmation-card__status${type?` ${type}`:''}`;
  }
  function showPending(email,message=''){
    try{sessionStorage.setItem(pendingKey,JSON.stringify({email,created_at:Date.now()}));}catch(_){}
    const guest=q('#account-guest'),panel=q('#account-confirmation-panel'),emailNode=q('#account-confirmation-email');
    if(guest)guest.style.display='none';if(panel)panel.style.display='block';if(emailNode)emailNode.textContent=email;
    status(message||copy().unconfirmed,'is-error');
  }
  function cooldown(seconds=60){
    const button=q('#account-confirmation-resend');if(!button)return;
    let remaining=seconds;button.disabled=true;
    const tick=()=>{button.textContent=remaining>0?copy().cooldown(remaining):copy().resend;if(remaining--<=0){button.disabled=false;clearInterval(timer);}};
    tick();const timer=setInterval(tick,1000);
  }
  async function resend(){
    const email=pendingEmail(),button=q('#account-confirmation-resend');if(!email||!button)return;
    button.disabled=true;button.textContent=copy().resending;status('');
    try{
      const redirect_to=`${location.origin}/auth-confirmed.html?lang=${es()?'es':'en'}`;
      const response=await fetch('/api/user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'resend_confirmation',email,origin:location.origin,redirect_to})});
      if(!response.ok)throw new Error('RESEND_FAILED');
      status(copy().resent,'is-success');cooldown(60);
    }catch(_){status(copy().fail,'is-error');button.disabled=false;button.textContent=copy().resend;}
  }
  function changeEmail(){
    const hasPlanning=Boolean(sessionStorage.getItem('itbmo_guest_session_token')||localStorage.getItem('itbmo_session_token'));
    if(hasPlanning){status(copy().protected,'is-error');return;}
    try{sessionStorage.removeItem(pendingKey);sessionStorage.setItem('itbmo_open_register_v298','1');}catch(_){}
    status(copy().wrong,'is-success');setTimeout(()=>location.reload(),500);
  }
  function enhanceChat(root=document){
    const button=root.querySelector?.('#guided-info-chat-open');if(!button||button.dataset.v298==='1')return;
    button.dataset.v298='1';
    const title=button.querySelector('.v277-chat-title'),subtitle=button.querySelector('.v277-chat-subtitle'),action=button.querySelector('.v277-chat-action');
    const kicker=document.createElement('span');kicker.className='v277-chat-kicker';kicker.textContent=copy().chatKicker;button.prepend(kicker);
    if(title)title.textContent=copy().chatTitle;if(subtitle)subtitle.textContent=copy().chatCopy;if(action)action.textContent=copy().chatAction;
  }
  const nativeFetch=window.fetch.bind(window);
  window.fetch=async function(input,init){
    const response=await nativeFetch(input,init);
    try{
      const url=typeof input==='string'?input:input?.url||'';
      const body=typeof init?.body==='string'?JSON.parse(init.body):null;
      if(url.includes('/api/user')&&body?.action==='sign_in'&&response.status===403){
        const data=await response.clone().json();
        if(data?.confirmation_required)setTimeout(()=>showPending(data.email||body.email,copy().unconfirmed),0);
      }
    }catch(_){}
    return response;
  };
  document.addEventListener('DOMContentLoaded',()=>{
    const resendButton=q('#account-confirmation-resend'),changeButton=q('#account-confirmation-change-email');
    if(resendButton){resendButton.textContent=copy().resend;resendButton.addEventListener('click',resend);}
    if(changeButton){changeButton.textContent=copy().change;changeButton.addEventListener('click',changeEmail);}
    try{if(sessionStorage.getItem('itbmo_open_register_v298')==='1'){sessionStorage.removeItem('itbmo_open_register_v298');setTimeout(()=>q('#account-register-toggle')?.click(),120);}}catch(_){}
    enhanceChat();
    new MutationObserver(records=>records.forEach(record=>record.addedNodes.forEach(node=>{if(node.nodeType===1)enhanceChat(node);}))).observe(document.body,{childList:true,subtree:true});
  },{once:true});
})();
