/* =========================================================
   ITBMO Foundation V1
   Attribution + Event Gateway client
   - No PII in analytics payloads
   - Preserves first touch and last meaningful touch locally
   - Accepts top-level attribution context via postMessage
   ========================================================= */
(() => {
  'use strict';

  const KEYS={
    anonymous:'itbmo_anonymous_id_v1',
    attribution:'itbmo_attribution_id_v1',
    first:'itbmo_first_touch_v1',
    last:'itbmo_last_touch_v1'
  };
  const SESSION_KEYS=['itbmo_guest_session_token','itbmo_session_token'];
  const ATTR_KEYS=['utm_source','utm_medium','utm_campaign','utm_content','utm_term','creator','referral'];
  const SAFE_EVENT_NAMES=new Set([
    'view_home','planner_open','planner_started','guest_started','sign_up','login',
    'trip_configuration_started','destinations_saved','checkout_started','checkout_opened',
    'purchase','payment_approved','payment_cancelled','payment_failed','generation_started',
    'generation_completed','itinerary_generated','workspace_opened','city_workspace_opened',
    'partner_offer_view','partner_offer_click','affiliate_click','trip_shared','trip_reopened',
    'new_trip_started','new_planning_started','export_pdf','export_csv','export_receipt',
    'info_chat_question','start_chat'
  ]);
  const SAFE_PARAM_KEYS=new Set([
    'language','city_count','days_total','payment_provider','currency','generation_mode',
    'partner','partner_name','placement','destination','queries_used','queries_remaining',
    'file_type','error_stage','campaign_id','campaign_key','channel','source','medium',
    'content','creator','referral','landing_page','first_touch_source','last_touch_source'
  ]);

  function uuid(){
    try{return crypto.randomUUID();}catch(_){return `itbmo-${Date.now()}-${Math.random().toString(36).slice(2,12)}`;}
  }
  function storageGet(key){try{return localStorage.getItem(key)||'';}catch(_){return '';}}
  function storageSet(key,value){try{localStorage.setItem(key,value);}catch(_){}}
  function jsonGet(key){try{return JSON.parse(storageGet(key)||'null');}catch(_){return null;}}
  function jsonSet(key,value){storageSet(key,JSON.stringify(value));}
  function stableId(key){let value=storageGet(key);if(!value){value=uuid();storageSet(key,value);}return value;}
  function sessionToken(){
    try{return sessionStorage.getItem(SESSION_KEYS[0])||localStorage.getItem(SESSION_KEYS[1])||'';}catch(_){return '';}
  }
  function activeTripId(){try{return localStorage.getItem('itbmo_active_trip_id')||'';}catch(_){return '';}}

  function normalizeTouch(raw={}){
    const output={};
    const aliases={
      utm_source:'source',utm_medium:'medium',utm_campaign:'campaign',utm_content:'content',utm_term:'term',
      source:'source',medium:'medium',campaign:'campaign',content:'content',term:'term',
      creator:'creator',referral:'referral',landing_page:'landing_page',referrer:'referrer'
    };
    Object.entries(aliases).forEach(([from,to])=>{
      const value=raw?.[from];
      if(value!==undefined && value!==null && String(value).trim()) output[to]=String(value).trim().slice(0,300);
    });
    return output;
  }

  function queryTouch(){
    const params=new URLSearchParams(location.search);
    const raw={};
    ATTR_KEYS.forEach(key=>{const value=params.get(key);if(value)raw[key]=value;});
    raw.landing_page=location.pathname;
    if(document.referrer) raw.referrer=document.referrer;
    return normalizeTouch(raw);
  }

  function hasCampaignSignal(touch){
    return Boolean(touch?.source || touch?.medium || touch?.campaign || touch?.content || touch?.creator || touch?.referral);
  }

  let anonymousId=stableId(KEYS.anonymous);
  let attributionId=stableId(KEYS.attribution);
  let firstTouch=jsonGet(KEYS.first);
  let lastTouch=jsonGet(KEYS.last);

  function capture(raw, {meaningful=true}={}){
    const touch=normalizeTouch(raw);
    if(!Object.keys(touch).length) return;
    if(!firstTouch && hasCampaignSignal(touch)){firstTouch={...touch,captured_at:new Date().toISOString()};jsonSet(KEYS.first,firstTouch);}
    if(meaningful && hasCampaignSignal(touch)){lastTouch={...touch,captured_at:new Date().toISOString()};jsonSet(KEYS.last,lastTouch);}
  }

  capture(queryTouch());

  function relayAttribution(raw){
    try{
      document.querySelectorAll('iframe').forEach(frame=>{
        if(!frame.contentWindow) return;
        let targetOrigin='*';
        try{ targetOrigin=new URL(frame.src,location.href).origin; }catch(_){ }
        frame.contentWindow.postMessage({type:'ITBMO_ATTRIBUTION_CONTEXT',attribution:raw},targetOrigin);
      });
    }catch(_){ }
  }

  function trustedAttributionOrigin(origin){
    try{
      if(origin===location.origin) return true;
      const host=new URL(origin).hostname.toLowerCase();
      return host==='itravelbymyown.com' || host==='www.itravelbymyown.com' || host.endsWith('.webflow.io');
    }catch(_){ return false; }
  }

  window.addEventListener('message',(event)=>{
    const data=event?.data;
    if(!data || data.type!=='ITBMO_ATTRIBUTION_CONTEXT' || !trustedAttributionOrigin(event.origin)) return;
    const incoming=data.attribution || data.payload || {};
    capture(incoming,{meaningful:true});
    relayAttribution(incoming);
  });

  const initialRelay=()=>relayAttribution(lastTouch || firstTouch || queryTouch());
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',initialRelay,{once:true});
  else initialRelay();
  setTimeout(initialRelay,700);
  setTimeout(initialRelay,1800);

  function cleanParams(parameters={}){
    const clean={};
    Object.entries(parameters||{}).forEach(([key,value])=>{
      if(!SAFE_PARAM_KEYS.has(key) || value===undefined || value===null) return;
      if(typeof value==='number' && Number.isFinite(value)) clean[key]=value;
      else if(typeof value==='boolean') clean[key]=value;
      else clean[key]=String(value).slice(0,160);
    });
    return clean;
  }

  function analyticsDispatch(eventName,parameters){
    const payload={type:'ITBMO_ANALYTICS_EVENT',event_name:eventName,parameters};
    try{
      if(window.top && window.top!==window) window.top.postMessage(payload,'*');
      else{
        window.dataLayer=window.dataLayer||[];
        window.dataLayer.push({event:'itbmo_event',itbmo_event_name:eventName,...parameters});
      }
    }catch(_){ }
  }

  async function firstPartyDispatch(eventName,eventId,parameters){
    try{
      await fetch('/api/events',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        keepalive:true,
        body:JSON.stringify({
          event_id:eventId,
          event_name:eventName,
          session_token:sessionToken()||null,
          trip_id:activeTripId()||null,
          anonymous_id:anonymousId,
          attribution_id:attributionId,
          properties:parameters
        })
      });
    }catch(_){ }
  }

  function track(eventName,parameters={}){
    const name=String(eventName||'').trim();
    if(!SAFE_EVENT_NAMES.has(name)) return '';
    const eventId=uuid();
    const clean=cleanParams(parameters);
    if(!clean.language) clean.language=(document.documentElement.lang||'en').slice(0,2);
    if(firstTouch?.source) clean.first_touch_source=String(firstTouch.source).slice(0,160);
    if(lastTouch?.source) clean.last_touch_source=String(lastTouch.source).slice(0,160);
    analyticsDispatch(name,clean);
    void firstPartyDispatch(name,eventId,clean);
    return eventId;
  }

  async function syncAttribution(){
    if(!firstTouch && !lastTouch) return;
    try{
      await fetch('/api/attribution',{
        method:'POST',headers:{'Content-Type':'application/json'},keepalive:true,
        body:JSON.stringify({
          attribution_id:attributionId,
          anonymous_id:anonymousId,
          session_token:sessionToken()||null,
          first_touch:firstTouch||null,
          last_touch:lastTouch||firstTouch||null
        })
      });
    }catch(_){ }
  }

  window.ITBMOFoundation={
    track,captureAttribution:capture,syncAttribution,
    getAttribution:()=>({anonymous_id:anonymousId,attribution_id:attributionId,first_touch:firstTouch,last_touch:lastTouch})
  };
})();
