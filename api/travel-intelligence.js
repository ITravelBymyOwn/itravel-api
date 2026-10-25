import { authenticatedTrip, buildTravelGraph, cleanText, featureFlags, liveGateway, navigationLinks } from './_lib/platform-core.js';

const MODES=new Set(['best','driving','walking','bicycling','transit']);
const coordinate=value=>{const n=Number(value);return Number.isFinite(n)&&n>=-180&&n<=180?n:null};

export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({ok:false,code:'METHOD_NOT_ALLOWED'});
  const body=req.body||{};const action=cleanText(body.action,40);const flags=await featureFlags();
  try{
    const {session,trip}=await authenticatedTrip(body.session_token,body.trip_id);
    if(!session)return res.status(401).json({ok:false,code:'SESSION_REQUIRED'});
    if(!trip)return res.status(404).json({ok:false,code:'TRIP_NOT_FOUND'});
    if(action==='graph'){
      if(!flags.travel_graph_enabled)return res.status(404).json({ok:false,code:'FEATURE_DISABLED'});
      return res.status(200).json({ok:true,graph:buildTravelGraph(trip)});
    }
    if(action==='route'){
      if(!flags.mobility_engine_enabled)return res.status(404).json({ok:false,code:'FEATURE_DISABLED'});
      const origin=cleanText(body.origin,240),destination=cleanText(body.destination,240),mode=MODES.has(body.mode)?body.mode:'best';
      if(!destination)return res.status(400).json({ok:false,code:'DESTINATION_REQUIRED'});
      const links=navigationLinks({origin,destination,mode});
      let live={available:false,code:'LIVE_CONTEXT_DISABLED'};
      if(flags.live_context_enabled)live=await liveGateway({capability:'route',trip_id:trip.id,origin,destination,mode,departure_time:cleanText(body.departure_time,40)||null,locale:body.language==='en'?'en':'es'});
      return res.status(200).json({ok:true,source:live.available?'provider':'delegated_navigation',links,live,disclaimer:body.language==='en'?'Live times, availability and route conditions are confirmed by the navigation provider.':'Los tiempos, disponibilidad y condiciones en vivo se confirman con el proveedor de navegación.'});
    }
    if(action==='live_context'){
      if(!flags.live_context_enabled)return res.status(200).json({ok:true,available:false,code:'LIVE_CONTEXT_DISABLED'});
      const lat=coordinate(body.latitude),lng=coordinate(body.longitude);
      if(lat===null||lng===null||Math.abs(lat)>90)return res.status(400).json({ok:false,code:'VALID_LOCATION_REQUIRED'});
      const requested=(Array.isArray(body.capabilities)?body.capabilities:[]).map(x=>cleanText(x,30)).filter(x=>['weather','nearby','disruption','route'].includes(x));
      const result=await liveGateway({capability:'context',trip_id:trip.id,location:{latitude:lat,longitude:lng},capabilities:requested,city:cleanText(body.city,120),next_activity:cleanText(body.next_activity,180),locale:body.language==='en'?'en':'es'});
      return res.status(200).json({ok:true,...result,location_persisted:false});
    }
    return res.status(400).json({ok:false,code:'INVALID_ACTION'});
  }catch(error){console.error('ITBMO travel intelligence error',{action,code:error?.code||'UNKNOWN'});return res.status(503).json({ok:false,code:'TRAVEL_INTELLIGENCE_UNAVAILABLE'})}
}
