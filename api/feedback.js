import crypto from 'crypto';
import { authenticatedTrip, cleanText, supabaseFetch } from './_lib/platform-core.js';

const allowedSurfaces=new Set(['workspace','post_trip','support','home','other']);
const allowedTypes=new Set(['product','trip_planning','workspace','support','partner_experience','other']);
export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({ok:false,code:'METHOD_NOT_ALLOWED'});
  try{
    const body=req.body||{};const rating=Number(body.rating_overall);
    if(!Number.isInteger(rating)||rating<1||rating>5)return res.status(400).json({ok:false,code:'INVALID_RATING'});
    const tripId=cleanText(body.trip_id,80);const {session,trip}=await authenticatedTrip(body.session_token,tripId);
    if(!session)return res.status(401).json({ok:false,code:'SESSION_REQUIRED'});
    if(tripId&&!trip)return res.status(403).json({ok:false,code:'TRIP_NOT_AVAILABLE'});
    const surface=allowedSurfaces.has(body.source_surface)?body.source_surface:'workspace';
    const type=allowedTypes.has(body.feedback_type)?body.feedback_type:'product';
    const duplicate=await supabaseFetch(`/user_feedback?select=id&session_id=eq.${encodeURIComponent(session.id)}&source_surface=eq.${surface}${tripId?`&trip_id=eq.${encodeURIComponent(tripId)}`:'&trip_id=is.null'}&created_at=gte.${encodeURIComponent(new Date(Date.now()-5*60*1000).toISOString())}&limit=1`);
    if(Array.isArray(duplicate)&&duplicate.length)return res.status(409).json({ok:false,code:'DUPLICATE_FEEDBACK'});
    const id=crypto.randomUUID();
    await supabaseFetch('/user_feedback',{method:'POST',body:JSON.stringify({id,user_id:session.user_id,session_id:session.id,trip_id:tripId||null,source_surface:surface,feedback_type:type,rating_overall:rating,comment:cleanText(body.comment,1200)||null,ui_language:/^(es|en)$/.test(body.ui_language)?body.ui_language:'es',app_version:'V295',trip_status_snapshot:cleanText(trip?.status,40)||null,city_count:Array.isArray(trip?.destinations)?trip.destinations.length:null,consent_to_contact:Boolean(body.consent_to_contact),status:'new'})});
    return res.status(201).json({ok:true,feedback_id:id});
  }catch(error){console.error('ITBMO feedback error',{code:error?.code||'UNKNOWN',status:error?.status||null});return res.status(503).json({ok:false,code:'FEEDBACK_UNAVAILABLE'})}
}
