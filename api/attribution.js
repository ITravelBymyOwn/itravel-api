import { newEventId, resolveSession, supabaseFetch } from './_lib/itbmo-foundation.js';

const ALLOWED_FIELDS = [
  'source','medium','campaign','content','term','creator','referral','landing_page','referrer'
];

function cleanTouch(input={}) {
  const output = {};
  for (const key of ALLOWED_FIELDS) {
    const value = input?.[key];
    if (value === undefined || value === null || value === '') continue;
    output[key] = String(value).slice(0,300);
  }
  return output;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok:false, code:'METHOD_NOT_ALLOWED' });
  try {
    const body = req.body || {};
    const firstTouch = cleanTouch(body.first_touch);
    const lastTouch = cleanTouch(body.last_touch);
    if (!Object.keys(firstTouch).length && !Object.keys(lastTouch).length) {
      return res.status(400).json({ ok:false, code:'ATTRIBUTION_EMPTY' });
    }

    const session = await resolveSession(body.session_token).catch(()=>null);
    const attributionId = String(body.attribution_id || newEventId()).slice(0,80);
    const anonymousId = body.anonymous_id ? String(body.anonymous_id).slice(0,80) : null;

    try {
      await supabaseFetch('/attributions?on_conflict=attribution_id', {
        method:'POST',
        headers:{ Prefer:'resolution=merge-duplicates,return=minimal' },
        body:JSON.stringify({
          attribution_id:attributionId,
          anonymous_id:anonymousId,
          user_id:session?.user_id || null,
          session_id:session?.id || null,
          first_touch:firstTouch,
          last_meaningful_touch:lastTouch,
          updated_at:new Date().toISOString()
        })
      });
      return res.status(201).json({ ok:true, attribution_id:attributionId, persisted:true });
    } catch (_) {
      /* Existing profile UTM capture remains untouched. Dedicated attribution begins after migration. */
      return res.status(202).json({
        ok:true,
        attribution_id:attributionId,
        persisted:false,
        migration_required:true
      });
    }
  } catch (error) {
    console.error('ITBMO Attribution error:', error);
    return res.status(500).json({ ok:false, code:'ATTRIBUTION_WRITE_FAILED' });
  }
}
