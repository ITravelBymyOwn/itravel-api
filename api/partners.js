import { registerPartnerClick, resolveCityOffers, resolveTripOffers } from './_lib/partner-engine.js';
function send(res,status,payload){res.status(status).json(payload)}
export default async function handler(req,res){
  if(req.method!=='POST') return send(res,405,{ok:false,code:'METHOD_NOT_ALLOWED'});
  try{
    const b=req.body||{},action=String(b.action||'');
    if(action==='resolve_trip'){
      const result=await resolveTripOffers(b);
      return send(res,200,{ok:true,offers:result.offers});
    }
    if(action==='resolve_city'){
      const result=await resolveCityOffers(b);if(!result.session)return send(res,401,{ok:false,code:'SESSION_REQUIRED'});
      return send(res,200,{ok:true,offers:result.offers});
    }
    if(action==='click'){
      const result=await registerPartnerClick(b);return send(res,result.ok?200:400,result);
    }
    return send(res,400,{ok:false,code:'INVALID_ACTION'});
  }catch(error){console.error('ITBMO Partner Engine error:',error);return send(res,500,{ok:false,code:'PARTNER_ENGINE_FAILED'})}
}
