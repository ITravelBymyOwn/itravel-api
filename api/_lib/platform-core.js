import crypto from 'crypto';
import { resolveSession, supabaseFetch } from './itbmo-foundation.js';

export const PLATFORM_FLAGS = Object.freeze([
  'platform_foundation_enabled','social_links_enabled','communication_hub_enabled',
  'whatsapp_support_enabled','web_chat_enabled','user_feedback_enabled',
  'travel_graph_enabled','mobility_engine_enabled','live_location_enabled',
  'live_context_enabled','weather_intelligence_enabled','nearby_intelligence_enabled',
  'dynamic_itinerary_enabled','companion_enabled'
]);

export const cleanText=(value,max=180)=>String(value??'')
  .replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);

export function boolEnv(name,fallback=false){
  const value=process.env[name];
  return value===undefined?fallback:/^(1|true|yes|on)$/i.test(String(value));
}

export function safeHttpsUrl(value=''){
  try{const url=new URL(String(value||''));return url.protocol==='https:'?url.toString():''}catch(_){return''}
}

export async function featureFlags(){
  const fallback={
    platform_foundation_enabled:true,social_links_enabled:true,communication_hub_enabled:true,
    whatsapp_support_enabled:false,web_chat_enabled:false,user_feedback_enabled:true,
    travel_graph_enabled:true,mobility_engine_enabled:true,live_location_enabled:true,
    live_context_enabled:false,weather_intelligence_enabled:false,nearby_intelligence_enabled:false,
    dynamic_itinerary_enabled:false,companion_enabled:true
  };
  try{
    const rows=await supabaseFetch(`/feature_flags?select=key,enabled&key=in.(${PLATFORM_FLAGS.join(',')})`);
    for(const row of rows||[])if(PLATFORM_FLAGS.includes(row?.key))fallback[row.key]=Boolean(row.enabled);
  }catch(_){ }
  return fallback;
}

export async function authenticatedTrip(sessionToken,tripId){
  const session=await resolveSession(sessionToken);
  if(!session)return {session:null,trip:null};
  const id=cleanText(tripId,80);
  if(!id)return {session,trip:null};
  const rows=await supabaseFetch(`/trips?select=id,user_id,status,language,destinations,planner_input,itinerary_data,generated_at,updated_at&id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(session.user_id)}&limit=1`);
  return {session,trip:Array.isArray(rows)?rows[0]||null:null};
}

const stableId=(...parts)=>crypto.createHash('sha256').update(parts.map(x=>String(x??'')).join('|')).digest('hex').slice(0,24);
const dateOnly=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||''))?String(value):null;

export function buildTravelGraph(trip){
  const checkpoint=trip?.itinerary_data&&typeof trip.itinerary_data==='object'?trip.itinerary_data:{};
  const itineraries=checkpoint.itineraries&&typeof checkpoint.itineraries==='object'?checkpoint.itineraries:{};
  const cityMeta=checkpoint.city_meta&&typeof checkpoint.city_meta==='object'?checkpoint.city_meta:{};
  const destinations=(Array.isArray(trip?.destinations)?trip.destinations:[]).map((item,index)=>({
    sequence:index+1,city:cleanText(item?.city,120),country:cleanText(item?.country,120),
    country_code:cleanText(item?.country_code||item?.countryCode,8).toUpperCase(),
    base_date:dateOnly(item?.base_date||item?.baseDate),days:Math.max(1,Math.min(60,Number(item?.days)||1))
  })).filter(x=>x.city);
  const stays=[];const days=[];const activities=[];const segments=[];
  for(const destination of destinations){
    const stayId=stableId(trip.id,'stay',destination.sequence,destination.city);
    stays.push({id:stayId,...destination,accommodation:cleanText(cityMeta?.[destination.city]?.accommodation||cityMeta?.[destination.city]?.lodging,180)||null});
    const byDay=itineraries?.[destination.city]?.byDay||{};
    const dayNumbers=Object.keys(byDay).map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
    for(const dayNumber of dayNumbers){
      const dayId=stableId(trip.id,stayId,'day',dayNumber);
      const rows=Array.isArray(byDay[dayNumber])?byDay[dayNumber]:[];
      const dayDate=destination.base_date?new Date(`${destination.base_date}T12:00:00Z`):null;
      if(dayDate)dayDate.setUTCDate(dayDate.getUTCDate()+dayNumber-1);
      days.push({id:dayId,stay_id:stayId,city:destination.city,day_number:dayNumber,date:dayDate?dayDate.toISOString().slice(0,10):null});
      let previous=null;
      rows.forEach((row,index)=>{
        const activityId=stableId(trip.id,dayId,'activity',index,cleanText(row?.activity||row?.to,140));
        const activity={id:activityId,day_id:dayId,stay_id:stayId,city:destination.city,sequence:index+1,
          start:cleanText(row?.start,12)||null,end:cleanText(row?.end,12)||null,
          from:cleanText(row?.from,180)||null,to:cleanText(row?.to,180)||null,
          title:cleanText(String(row?.activity||'').replace(/^rev:\s*/i,''),220)||cleanText(row?.to,220),
          kind:cleanText(row?.kind,40)||'activity',transport:cleanText(row?.transport,500)||null,
          fixed:Boolean(row?.fixed||row?.locked||row?.reservation_fixed)};
        activities.push(activity);
        if(activity.from||activity.to){segments.push({id:stableId(trip.id,dayId,'segment',index),day_id:dayId,stay_id:stayId,sequence:index+1,
          origin:activity.from||previous?.to||previous?.title||null,destination:activity.to||activity.title||null,
          scheduled_start:activity.start,transport_summary:activity.transport,source:'itinerary'});}
        previous=activity;
      });
    }
  }
  return {schema_version:'travel-graph-v1',trip_id:trip.id,generated_at:new Date().toISOString(),source_updated_at:trip.updated_at||trip.generated_at||null,stays,days,activities,segments};
}

export function navigationLinks({origin,destination,mode='transit'}){
  const from=cleanText(origin,240),to=cleanText(destination,240);
  if(!to)return {};
  const allowedMode=['driving','walking','bicycling','transit'].includes(mode)?mode:'transit';
  const google=new URL('https://www.google.com/maps/dir/');google.searchParams.set('api','1');if(from)google.searchParams.set('origin',from);google.searchParams.set('destination',to);google.searchParams.set('travelmode',allowedMode);
  const waze=new URL('https://www.waze.com/ul');waze.searchParams.set('q',to);waze.searchParams.set('navigate','yes');
  return {google_maps:google.toString(),waze:waze.toString()};
}

export async function liveGateway(payload){
  const endpoint=safeHttpsUrl(process.env.ITBMO_LIVE_GATEWAY_URL);
  const secret=String(process.env.ITBMO_LIVE_GATEWAY_SECRET||'');
  if(!endpoint)return {available:false,code:'PROVIDER_NOT_CONFIGURED'};
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),8000);
  try{
    const response=await fetch(endpoint,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json',Accept:'application/json',...(secret?{Authorization:`Bearer ${secret}`}:{})},body:JSON.stringify(payload)});
    if(!response.ok)return {available:false,code:'PROVIDER_ERROR',status:response.status};
    const data=await response.json();
    return {available:true,provider:cleanText(data?.provider||'live_gateway',80),retrieved_at:new Date().toISOString(),expires_at:data?.expires_at||null,data:data?.data??data};
  }catch(error){return {available:false,code:error?.name==='AbortError'?'PROVIDER_TIMEOUT':'PROVIDER_UNAVAILABLE'}}
  finally{clearTimeout(timer)}
}
