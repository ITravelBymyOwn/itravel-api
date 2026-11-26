import platformConfig from './platform-config.js';
import feedback from './feedback.js';
import travelIntelligence from './travel-intelligence.js';
import itineraryChanges from './itinerary-changes.js';
import supabaseTest from './supabase-test.js';
import accounting from './_lib/accounting.js';

const handlers=Object.freeze({
  'platform-config':platformConfig,
  feedback,
  'travel-intelligence':travelIntelligence,
  'itinerary-changes':itineraryChanges,
  accounting,
  'accounting-impact': (req, res) => accounting(req, res, true),
  'supabase-test':supabaseTest
});

export default async function handler(req,res){
  const endpoint=String(req.query?.endpoint||'').trim().toLowerCase();
  const selected=handlers[endpoint];
  if(!selected)return res.status(404).json({ok:false,code:'PLATFORM_ENDPOINT_NOT_FOUND'});
  return selected(req,res);
}
