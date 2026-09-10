import {
  newEventId,
  resolveSession,
  sanitizeEventName,
  sanitizeProperties,
  supabaseFetch
} from './_lib/itbmo-foundation.js';

const ANONYMOUS_EVENTS = new Set(['view_home','planner_open','planner_started','trip_configuration_started']);

function send(res, status, payload) {
  res.status(status).json(payload);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok:false, code:'METHOD_NOT_ALLOWED' });

  try {
    const body = req.body || {};
    const eventName = sanitizeEventName(body.event_name);
    if (!eventName) return send(res, 400, { ok:false, code:'INVALID_EVENT' });

    const session = await resolveSession(body.session_token).catch(()=>null);
    if (!session && !ANONYMOUS_EVENTS.has(eventName)) {
      return send(res, 401, { ok:false, code:'SESSION_REQUIRED' });
    }

    const eventId = String(body.event_id || newEventId()).slice(0,80);
    const properties = sanitizeProperties(body.properties || {});
    const anonymousId = body.anonymous_id ? String(body.anonymous_id).slice(0,80) : null;
    const attributionId = body.attribution_id ? String(body.attribution_id).slice(0,80) : null;
    const tripId = body.trip_id ? String(body.trip_id).slice(0,80) : null;

    /* Browser telemetry is deliberately separate from user_events.
       Existing server-side operational events remain authoritative and are not duplicated. */
    try {
      await supabaseFetch('/marketing_touchpoints', {
        method:'POST',
        body:JSON.stringify({
          event_id:eventId,
          anonymous_id:anonymousId,
          attribution_id:attributionId,
          user_id:session?.user_id || null,
          session_id:session?.id || null,
          trip_id:tripId,
          event_name:eventName,
          properties
        })
      });
      return send(res, 201, { ok:true, event_id:eventId, persisted:true });
    } catch (_) {
      /* Safe rollout: analytics must never block Planner UX before migration is applied. */
      return send(res, 202, { ok:true, event_id:eventId, persisted:false, migration_required:true });
    }
  } catch (error) {
    console.error('ITBMO Event Gateway error:', error);
    return send(res, 500, { ok:false, code:'EVENT_WRITE_FAILED' });
  }
}
