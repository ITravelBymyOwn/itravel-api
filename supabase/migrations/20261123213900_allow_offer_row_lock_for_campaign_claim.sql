-- PostgreSQL requires UPDATE privilege for SELECT FOR SHARE.
grant update (campaign_id) on public.itbmo_offer_settings to service_role;
