# ITBMO Growth Foundation V1

## Purpose
Create a non-invasive foundation for marketing attribution, common events, future social distribution and campaign management without coupling external platforms to Planner logic.

## Architectural rules
1. Every marketing channel enters through Campaign + Attribution + Event Gateway.
2. Every external platform connects through an adapter.
3. Supabase/ITBMO remains the operational source of truth.
4. Planner remains isolated from vendor-specific marketing logic.
5. Consent controls dispatch to analytics/advertising/lifecycle destinations.
6. Commercial recommendations remain downstream of traveler needs, never commission-driven.

## V1 runtime pieces
- `/public/assets/js/itbmo-foundation.js`: browser attribution and event client.
- `/api/events`: browser event gateway writing to `marketing_touchpoints`; current server-side `user_events` remains authoritative and is not duplicated.
- `/api/attribution`: first/last-touch attribution endpoint using the dedicated `attributions` table after the additive migration.
- `/supabase/migrations/20260909_growth_foundation_v1.sql`: additive future-ready marketing tables.

## Important deployment note
The SQL migration is intentionally separate from runtime compatibility. Existing pages continue to work before it is applied. Apply it only after review in Supabase.

## Webflow attribution bridge
Because production acquisition occurs on the outer Webflow URL while Vercel pages can be embedded, Webflow must pass its top-level campaign context into the ITBMO iframe. Recommended outer-page snippet:

```html
<script>
(() => {
  const params = new URLSearchParams(location.search);
  const attribution = {
    utm_source: params.get('utm_source'),
    utm_medium: params.get('utm_medium'),
    utm_campaign: params.get('utm_campaign'),
    utm_content: params.get('utm_content'),
    utm_term: params.get('utm_term'),
    creator: params.get('creator'),
    referral: params.get('referral'),
    landing_page: location.pathname,
    referrer: document.referrer || null
  };
  const send = () => document.querySelectorAll('iframe').forEach(frame => {
    try { frame.contentWindow.postMessage({type:'ITBMO_ATTRIBUTION_CONTEXT', attribution}, '*'); } catch (_) {}
  });
  window.addEventListener('load', send);
  setTimeout(send, 1000);
})();
</script>
```

For production hardening, replace `*` with the approved Vercel origin after the final embed topology is fixed.

## Next increment
Partner Engine V1 should consume the same event/attribution foundation for offer impressions, clicks and later conversion reconciliation.
