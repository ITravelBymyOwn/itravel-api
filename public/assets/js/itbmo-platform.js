(()=>{
  'use strict';
  const OFFICIAL_SOCIALS=[
    {platform:'instagram',label:'Instagram',url:'https://www.instagram.com/itravelbymyown/'},
    {platform:'facebook',label:'Facebook',url:'https://www.facebook.com/people/Itravelbymyown/61588326876876/'},
    {platform:'tiktok',label:'TikTok',url:'https://www.tiktok.com/@itravelbymyown'},
    {platform:'youtube',label:'YouTube',url:'https://www.youtube.com/@itravelbymyown'},
    {platform:'linkedin',label:'LinkedIn',url:'https://www.linkedin.com/company/itravelbymyown/'},
    {platform:'x',label:'X',url:'https://x.com/itravelbymyown'},
    {platform:'pinterest',label:'Pinterest',url:'https://www.pinterest.com/itravelbymyown/'}
  ];
  const icons={
    instagram:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4.1"/><circle class="fill" cx="17.4" cy="6.7" r="1.1"/></svg>',
    facebook:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 21v-8h2.8l.4-3H14V8.1c0-.9.3-1.5 1.7-1.5h1.7V3.9c-.3 0-1.4-.1-2.5-.1-2.5 0-4.1 1.5-4.1 4.2v2H8v3h2.8v8H14Z"/></svg>',
    tiktok:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.7 3c.3 2.2 1.6 3.6 3.8 3.8v3.1a8 8 0 0 1-3.8-1.1v6.1a6 6 0 1 1-5.2-5.9v3.2a2.9 2.9 0 1 0 2.1 2.7V3h3.1Z"/></svg>',
    youtube:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 7.2a2.8 2.8 0 0 0-2-2C17.3 4.7 12 4.7 12 4.7s-5.3 0-7 .5a2.8 2.8 0 0 0-2 2A29 29 0 0 0 2.5 12 29 29 0 0 0 3 16.8a2.8 2.8 0 0 0 2 2c1.7.5 7 .5 7 .5s5.3 0 7-.5a2.8 2.8 0 0 0 2-2 29 29 0 0 0 .5-4.8 29 29 0 0 0-.5-4.8Z"/><path class="cut" d="m10 15.2 5.2-3.2L10 8.8v6.4Z"/></svg>',
    linkedin:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 8.5H3.4V21h3.2V8.5ZM5 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm6.7 5.5H8.6V21h3.2v-6.2c0-1.6.3-3.2 2.3-3.2s2 1.9 2 3.3V21h3.2v-6.9c0-3.4-.7-6-4.7-6-1.9 0-3.2 1-3.7 2h-.1V8.5Z"/></svg>',
    x:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h4.7l4.2 5.6L17.8 3H20l-6.1 7.2L20.5 21h-4.7l-4.6-6.2L5.9 21H3.6l6.6-7.8L4 3Zm3.6 1.8 9.1 14.4h1.8L9.4 4.8H7.6Z"/></svg>',
    pinterest:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.6 19.3c-.1-1.7 0-3.7.4-5.5l1.3-5.3s-.3-.8-.3-2c0-1.9 1.1-3.3 2.5-3.3 1.2 0 1.8.9 1.8 2 0 1.2-.8 2.9-1.1 4.5-.3 1.3.7 2.4 2 2.4 2.4 0 4.2-2.5 4.2-6.1 0-3.2-2.3-5.4-5.6-5.4-3.8 0-6 2.8-6 5.8 0 1.1.4 2.4 1 3 .1.1.1.2.1.4l-.4 1.5c-.1.5-.5.6-.9.4-1.7-.8-2.7-3.2-2.7-5.1 0-4.1 3-7.9 8.7-7.9 4.6 0 8.1 3.3 8.1 7.6 0 4.5-2.9 8.2-6.8 8.2-1.3 0-2.6-.7-3-1.5l-.8 3.1c-.3 1.1-1.1 2.5-1.6 3.4.9.3 1.8.5 2.7.5A10 10 0 0 0 12 2Z"/></svg>'
  };
  let configPromise;
  const load=()=>configPromise||(configPromise=fetch('/api/platform-config',{headers:{Accept:'application/json'}}).then(r=>r.ok?r.json():null).catch(()=>null));
  const track=(name,properties={})=>window.ITBMOFoundation?.track?.(name,properties);
  function socialBlock(accounts,lang){
    const wrap=document.createElement('div');
    wrap.className='itbmo-social-links';
    wrap.setAttribute('aria-label',lang==='en'?'ITBMO official social networks':'Redes sociales oficiales de ITBMO');
    accounts.forEach(account=>{
      const platform=String(account.platform||'').toLowerCase();
      const a=document.createElement('a');
      a.href=account.url;a.target='_blank';a.rel='noopener noreferrer';
      a.className=`itbmo-social-link itbmo-social-link--${platform}`;
      a.setAttribute('aria-label',account.label||platform);a.title=account.label||platform;
      a.innerHTML=icons[platform]||'<span aria-hidden="true">↗</span>';
      a.onclick=()=>track('social_link_clicked',{channel:platform,placement:document.body.classList.contains('support-page')?'support':'footer'});
      wrap.appendChild(a);
    });
    return wrap;
  }
  function supportActions(config,lang){
    document.querySelectorAll('[data-itbmo-support-channels]').forEach(host=>{
      if(config?.flags?.whatsapp_support_enabled&&config?.support?.whatsapp_url){
        const a=document.createElement('a');a.className='button button--primary itbmo-channel-action';
        a.href=config.support.whatsapp_url;a.target='_blank';a.rel='noopener noreferrer';
        a.textContent=lang==='en'?'Chat on WhatsApp':'Escribir por WhatsApp';
        a.onclick=()=>track('support_channel_opened',{channel:'whatsapp',placement:'support'});host.appendChild(a);
      }
      if(!host.children.length)host.hidden=true;
    });
  }
  function webChat(config){
    if(!config?.flags?.web_chat_enabled||!config?.support?.web_chat?.script_url||document.querySelector('[data-itbmo-web-chat]'))return;
    const script=document.createElement('script');script.src=config.support.web_chat.script_url;script.async=true;
    script.dataset.itbmoWebChat=config.support.web_chat.provider;script.onerror=()=>track('support_channel_unavailable',{channel:'web_chat'});document.head.appendChild(script);
  }
  async function boot(){
    const lang=document.documentElement.lang?.toLowerCase().startsWith('en')?'en':'es';
    const config=await load()||{ok:false,flags:{},social_accounts:OFFICIAL_SOCIALS,support:{}};
    const accounts=Array.isArray(config.social_accounts)&&config.social_accounts.length?config.social_accounts:OFFICIAL_SOCIALS;
    document.querySelectorAll('[data-itbmo-social-links]').forEach(host=>host.replaceChildren(socialBlock(accounts,lang)));
    supportActions(config,lang);webChat(config);
    window.ITBMOPlatform={config,track,load,officialSocials:OFFICIAL_SOCIALS};
    document.dispatchEvent(new CustomEvent('itbmo:platform-ready',{detail:config}));
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
