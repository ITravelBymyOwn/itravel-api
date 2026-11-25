begin;

alter table public.creator_partners
  add column profile_id uuid unique references public.profiles(id);

create index marketing_touchpoints_creator_visits
  on public.marketing_touchpoints ((properties->>'promotion_code'))
  where event_name = 'planner_open' and properties->>'medium' = 'creator';

create function public.itbmo_creator_summary(p_profile uuid, p_environment text)
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
        'sales', (select count(*) from public.creator_commissions c
          join public.promo_redemptions r on r.id = c.redemption_id
          where c.creator_id = partner.id and r.promo_code_id = promo.id
            and c.paypal_environment = p_environment)
      ) order by promo.code)
      from public.promo_codes promo where promo.creator_id = partner.id
    ), '[]'::jsonb),
    'pending_cents', balance.pending_cents,
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

create function public.itbmo_create_creator(
  p_code text, p_name text, p_email text, p_payout_email text,
  p_discount integer, p_commission_cents integer
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  owner_id uuid;
  partner_id uuid;
  base_cents integer := (public.itbmo_current_offer('preview')->>'base_price_cents')::integer;
begin
  if base_cents is null or p_discount not between 1 and 99 or p_commission_cents < 1
    or p_commission_cents >= round(base_cents * (100-p_discount)::numeric / 100) then
    return null;
  end if;

  select id into owner_id from public.profiles
  where lower(email) = p_email and email_verified and auth_user_id is not null
    and account_status = 'active'
  order by id limit 1;
  if not found then return null; end if;

  insert into public.creator_partners
    (profile_id, creator_code, display_name, platform, contact_email, status,
     commission_type, commission_value, currency, hold_days, payout_method, payout_reference)
    values (owner_id, p_code, p_name, 'other', p_email, 'active',
      'fixed', p_commission_cents::numeric / 100, 'USD', 30, 'paypal', p_payout_email)
    returning id into partner_id;
  insert into public.promo_codes
    (creator_id, code, name, promo_type, discount_value, currency, active, registered_only, verified_only)
    values (partner_id, p_code, p_name, 'percentage', p_discount, 'USD', true, true, true);
  return partner_id;
end $$;
revoke all on function public.itbmo_create_creator(text,text,text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.itbmo_create_creator(text,text,text,text,integer,integer) to service_role;

commit;
