import crypto from 'crypto';
import { resolveSession, supabaseFetch } from './itbmo-foundation.js';

const SAFE_SLUGS = new Set(['holafly','omio','viator','getyourguide']);

export async function getPartner(slug){
  if(!SAFE_SLUGS.has(slug)) return null;
  const rows=await supabaseFetch(`/travel_partners?select=id,slug,name,category,status,enabled,metadata&slug=eq.${encodeURIComponent(slug)}&limit=1`);
  return Array.isArray(rows)?rows[0]:null;
}

export async function getOffer(slug, placement=''){
  const partner=await getPartner(slug);
  if(!partner || !partner.enabled || partner.status!=='approved') return null;
  const q=`/partner_offers?select=id,partner_id,offer_key,need_type,placement,title_es,title_en,description_es,description_en,target_url,confidence,enabled,metadata&partner_id=eq.${partner.id}&enabled=eq.true&limit=20`;
  const rows=await supabaseFetch(q);
  const offer=(Array.isArray(rows)?rows:[]).find(x=>!placement || x.placement===placement) || null;
  return offer?{...offer,partner:{id:partner.id,slug:partner.slug,name:partner.name}}:null;
}

export async function resolveTripOffers({session_token,trip_id}){
  // Trip-wide offers are safe to resolve even if the workspace was reopened
  // without a persisted session token. Session context is attached when available.
  const session=await resolveSession(session_token).catch(()=>null);
  const offers=[];
  const holafly = await getOffer('holafly', 'trip_connectivity');
  if(holafly) offers.push(holafly);
  return {session,offers};
}

export async function resolveCityOffers({session_token,trip_id,needs=[]}){
  const session=await resolveSession(session_token);
  if(!session) return {session:null,offers:[]};
  const types=new Set((Array.isArray(needs)?needs:[]).map(x=>String(x?.need_type||'')));
  const offers=[];
  if(types.has('intercity_transport') || types.has('transport_arrangement')){
    const omio=await getOffer('omio','city_transport').catch(()=>null);
    if(omio) offers.push(omio);
  }
  return {session,offers};
}

export async function registerPartnerClick({session_token,trip_id,offer_id,placement}){
  // Affiliate destinations are public. Preserve session attribution when available,
  // but never make a useful trip-wide offer disappear because a token is unavailable.
  const session=await resolveSession(session_token).catch(()=>null);
  const rows=await supabaseFetch(`/partner_offers?select=id,partner_id,target_url,enabled& id=eq.${encodeURIComponent(offer_id)}`.replace('& ', '&'));
  const offer=Array.isArray(rows)?rows[0]:null;
  if(!offer?.enabled || !/^https:\/\//i.test(String(offer.target_url||''))) return {ok:false,code:'OFFER_NOT_AVAILABLE'};
  const clickId=crypto.randomUUID();
  await supabaseFetch('/partner_clicks',{method:'POST',body:JSON.stringify({click_id:clickId,partner_id:offer.partner_id,offer_id:offer.id,user_id:session?.user_id||null,session_id:session?.id||null,trip_id:trip_id||null,placement:String(placement||'').slice(0,80)})});
  return {ok:true,click_id:clickId,url:offer.target_url};
}
