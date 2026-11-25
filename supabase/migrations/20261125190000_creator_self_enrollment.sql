begin;

create or replace function public.itbmo_creator_summary(p_profile uuid, p_environment text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'name', partner.display_name,
    'codes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'code', promo.code, 'type', promo.promo_type, 'discount', promo.discount_value,
        'active', promo.active and partner.status = 'active'
          and (promo.starts_at is null or promo.starts_at <= now())
          and (promo.expires_at is null or promo.expires_at > now()),
        'visits', (select count(*) from public.marketing_touchpoints visit
          where visit.event_name = 'planner_open' and visit.properties->>'medium' = 'creator'
            and visit.properties->>'promotion_code' = promo.code),
        'generated', (select count(*) from public.creator_commissions earned
          join public.promo_redemptions redemption on redemption.id = earned.redemption_id
          join public.trips trip on trip.id = redemption.trip_id
          where earned.creator_id = partner.id and redemption.promo_code_id = promo.id
            and earned.paypal_environment = p_environment and trip.generated_at is not null),
        'sales', (select count(*) from public.creator_commissions c
          join public.promo_redemptions r on r.id = c.redemption_id
          where c.creator_id = partner.id and r.promo_code_id = promo.id
            and c.paypal_environment = p_environment)
      ) order by promo.code)
      from public.promo_codes promo where promo.creator_id = partner.id
    ), '[]'::jsonb),
    'pending_cents', balance.pending_cents,
    'total_commission_cents', (select coalesce(sum(commission_cents-reversed_cents),0)
      from public.creator_commissions where creator_id = partner.id and paypal_environment = p_environment),
    'paid_cents', (select coalesce(sum(amount_cents),0)
      from public.creator_payouts where creator_id = partner.id and paypal_environment = p_environment and state = 'paid'),
    'available_cents', balance.payable_cents,
    'sales', coalesce((
      select jsonb_agg(to_jsonb(sale)) from (
        select c.redemption_id as reference, promo.code, c.created_at, c.eligible_at,
          c.sale_cents, c.commission_cents, c.reversed_cents
        from public.creator_commissions c
        join public.promo_redemptions r on r.id = c.redemption_id
        join public.promo_codes promo on promo.id = r.promo_code_id
        where c.creator_id = partner.id and c.paypal_environment = p_environment
        order by c.created_at desc, c.redemption_id
        limit 100
      ) sale
    ), '[]'::jsonb),
    'payouts', coalesce((
      select jsonb_agg(to_jsonb(payout)) from (
        select period, amount_cents, state, provider_batch_id
        from public.creator_payouts
        where creator_id = partner.id and paypal_environment = p_environment
        order by period desc
        limit 24
      ) payout
    ), '[]'::jsonb)
  )
  from public.creator_partners partner
  join public.creator_payout_balances balance on balance.creator_id = partner.id
    and balance.paypal_environment = p_environment
  where partner.profile_id = p_profile;
$$;
revoke all on function public.itbmo_creator_summary(uuid,text) from public, anon, authenticated;
grant execute on function public.itbmo_creator_summary(uuid,text) to service_role;

create function public.itbmo_enroll_creator(p_profile uuid, p_name text, p_payout_email text)
returns text language plpgsql security invoker set search_path = '' as $$
declare
  owner_email text;
  partner_id uuid;
  code_value text;
  base_cents integer := (public.itbmo_current_offer('preview')->>'base_price_cents')::integer;
begin
  if char_length(trim(p_name)) not between 1 and 100
    or p_payout_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    or char_length(p_payout_email) > 254 then return null; end if;

  select email into owner_email from public.profiles
  where id = p_profile and email_verified and auth_user_id is not null and account_status = 'active'
  for update;
  if not found then return null; end if;

  select creator_code into code_value from public.creator_partners where profile_id = p_profile;
  if found then return code_value; end if;

  -- Fixed Sandbox offer; the production agreement is independent of these test values.
  if base_cents is null or base_cents - round(base_cents * 0.10) <= 30 then return null; end if;
  code_value := 'VIAJE-' || upper(left(replace(gen_random_uuid()::text, '-', ''), 12));
  insert into public.creator_partners
    (profile_id, creator_code, display_name, platform, contact_email, status,
     commission_type, commission_value, currency, hold_days, payout_method, payout_reference)
    values (p_profile, code_value, trim(p_name), 'other', owner_email, 'active',
      'fixed', 0.30, 'USD', 30, 'paypal', p_payout_email)
    returning id into partner_id;
  insert into public.promo_codes
    (creator_id, code, name, promo_type, discount_value, currency, active, registered_only, verified_only)
    values (partner_id, code_value, trim(p_name), 'percentage', 10, 'USD', true, true, true);
  return code_value;
end $$;
revoke all on function public.itbmo_enroll_creator(uuid,text,text) from public, anon, authenticated;
grant execute on function public.itbmo_enroll_creator(uuid,text,text) to service_role;

commit;
