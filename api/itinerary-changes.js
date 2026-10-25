import crypto from 'crypto';
import { authenticatedTrip, buildTravelGraph, cleanText, featureFlags, liveGateway, supabaseFetch } from './_lib/platform-core.js';

export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({ok:false,code:'METHOD_NOT_ALLOWED'});
  const body=req.body||{};const action=cleanText(body.action,30);const flags=await featureFlags();
  try{
    const {session,trip}=await authenticatedTrip(body.session_token,body.trip_id);
    if(!session)return res.status(401).json({ok:false,code:'SESSION_REQUIRED'});
    if(!trip)return res.status(404).json({ok:false,code:'TRIP_NOT_FOUND'});
    if(!flags.dynamic_itinerary_enabled)return res.status(200).json({ok:true,available:false,code:'DYNAMIC_ITINERARY_DISABLED'});
    if(action==='propose'){
      const instruction=cleanText(body.instruction,800);
      if(!instruction)return res.status(400).json({ok:false,code:'INSTRUCTION_REQUIRED'});
      const graph=buildTravelGraph(trip);
      const result=await liveGateway({capability:'itinerary_reoptimization',trip_id:trip.id,instruction,graph,constraints:{preserve_fixed_reservations:true,require_user_approval:true,recalculate_mobility:true}});
      if(!result.available)return res.status(200).json({ok:true,available:false,code:result.code});
      const proposal=result.data?.proposal||result.data;
      if(!proposal||typeof proposal!=='object'||Array.isArray(proposal))return res.status(502).json({ok:false,code:'INVALID_PROVIDER_PROPOSAL'});
      const id=crypto.randomUUID();
      await supabaseFetch('/itinerary_change_proposals',{method:'POST',body:JSON.stringify({id,trip_id:trip.id,base_graph_version:1,requested_change:{instruction},proposed_diff:proposal.diff||{},impact_summary:proposal.impact_summary||{},status:'proposed'})});
      return res.status(201).json({ok:true,available:true,proposal_id:id,proposal:{diff:proposal.diff||{},impact_summary:proposal.impact_summary||{}},requires_approval:true});
    }
    if(action==='decision'){
      const proposalId=cleanText(body.proposal_id,80),decision=body.decision==='approve'?'approved':body.decision==='reject'?'rejected':'';
      if(!proposalId||!decision)return res.status(400).json({ok:false,code:'INVALID_DECISION'});
      const rows=await supabaseFetch(`/itinerary_change_proposals?select=id,trip_id,status&id=eq.${encodeURIComponent(proposalId)}&trip_id=eq.${encodeURIComponent(trip.id)}&limit=1`);
      const proposal=Array.isArray(rows)?rows[0]||null:null;
      if(!proposal)return res.status(404).json({ok:false,code:'PROPOSAL_NOT_FOUND'});
      if(proposal.status!=='proposed')return res.status(409).json({ok:false,code:'PROPOSAL_NOT_PENDING'});
      await supabaseFetch(`/itinerary_change_proposals?id=eq.${encodeURIComponent(proposalId)}&trip_id=eq.${encodeURIComponent(trip.id)}`,{method:'PATCH',body:JSON.stringify({status:decision,updated_at:new Date().toISOString(),...(decision==='approved'?{approved_at:new Date().toISOString()}:{})})});
      return res.status(200).json({ok:true,status:decision,applied:false,note:'Approval is recorded; itinerary mutation remains a separate versioned operation.'});
    }
    return res.status(400).json({ok:false,code:'INVALID_ACTION'});
  }catch(error){console.error('ITBMO itinerary change error',{action,code:error?.code||'UNKNOWN'});return res.status(503).json({ok:false,code:'ITINERARY_CHANGE_UNAVAILABLE'})}
}
