begin;

alter table public.promo_redemptions
  add column creator_commission_cents integer check (creator_commission_cents >= 0),
  add column creator_hold_days integer check (creator_hold_days >= 0);

create function public.itbmo_accounting_admin(p_profile uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from public.accounting_members m join public.profiles p on p.id=m.profile_id
    where m.profile_id=p_profile and m.enabled and p.account_status='active'
      and p.email_verified and p.auth_user_id is not null);
$$;

create function public.itbmo_admin_creator_deal(
  p_admin uuid, p_code text, p_mode text, p_discount numeric, p_commission_cents integer,
  p_name text, p_email text, p_payout_email text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  owner_id uuid;
  partner_id uuid;
  base_cents integer := (public.itbmo_current_offer('preview')->>'base_price_cents')::integer;
  discount_cents integer;
begin
  if not public.itbmo_accounting_admin(p_admin) then return jsonb_build_object('outcome','forbidden'); end if;
  if p_code is null or p_code !~ '^[A-Z0-9][A-Z0-9_-]{2,39}$' or
     p_mode is null or p_mode not in ('percentage','fixed') or
     p_discount is null or p_discount <= 0 or p_discount > 999999 or p_discount <> round(p_discount,2)
     or p_commission_cents is null or p_commission_cents < 0
     or (p_mode='percentage' and p_discount >= 100) or base_cents is null then
    return jsonb_build_object('outcome','invalid');
  end if;
  discount_cents := case p_mode when 'percentage' then round(base_cents*p_discount/100) else round(p_discount*100) end;
  if discount_cents < 1 or base_cents - discount_cents <= p_commission_cents then
    return jsonb_build_object('outcome','invalid');
  end if;

  if p_email is null then
    select id into partner_id from public.creator_partners where creator_code=p_code and currency='USD' for update;
    if not found then return jsonb_build_object('outcome','not_found'); end if;
    update public.promo_codes set promo_type=p_mode, discount_value=p_discount
      where creator_id=partner_id and code=p_code and currency='USD' and promo_type in ('percentage','fixed');
    if not found then return jsonb_build_object('outcome','not_found'); end if;
    update public.creator_partners set commission_type='fixed', commission_value=p_commission_cents::numeric/100
      where id=partner_id;
  else
    if p_name is null or length(trim(p_name)) not between 1 and 100 or p_payout_email is null or
      length(p_email) > 254 or length(p_payout_email) > 254 or
      p_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' or
      p_payout_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
      return jsonb_build_object('outcome','invalid');
    end if;
    select id into owner_id from public.profiles
      where email=p_email and email_verified and auth_user_id is not null and account_status='active'
      order by id limit 1 for update;
    if not found then return jsonb_build_object('outcome','account_required'); end if;
    insert into public.creator_partners
      (profile_id,creator_code,display_name,platform,contact_email,status,commission_type,
       commission_value,currency,hold_days,payout_method,payout_reference)
    values (owner_id,p_code,trim(p_name),'other',p_email,'active','fixed',
       p_commission_cents::numeric/100,'USD',30,'paypal',p_payout_email)
    returning id into partner_id;
    insert into public.promo_codes
      (creator_id,code,name,promo_type,discount_value,currency,active,registered_only,verified_only)
    values (partner_id,p_code,trim(p_name),p_mode,p_discount,'USD',true,true,true);
  end if;
  return jsonb_build_object('outcome','saved','code',p_code,
    'base_cents',base_cents,'final_cents',base_cents-discount_cents,'commission_cents',p_commission_cents);
exception when unique_violation then return jsonb_build_object('outcome','exists');
end $$;

revoke all on function public.itbmo_accounting_admin(uuid) from public, anon, authenticated;
revoke all on function public.itbmo_admin_creator_deal(uuid,text,text,numeric,integer,text,text,text) from public, anon, authenticated;
grant execute on function public.itbmo_accounting_admin(uuid) to service_role;
grant execute on function public.itbmo_admin_creator_deal(uuid,text,text,numeric,integer,text,text,text) to service_role;
revoke execute on function public.itbmo_create_creator(text,text,text,text,integer,integer) from service_role;

create function public.itbmo_snapshot_creator_deal()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  select case when partner.status<>'active' then 0
    when partner.commission_type='fixed' then coalesce(round(partner.commission_value*100)::int,0)
    when partner.commission_type='percentage' then coalesce(round(new.final_amount*partner.commission_value)::int,0)
    else 0 end, greatest(0,coalesce(partner.hold_days,30))
  into new.creator_commission_cents,new.creator_hold_days
  from public.promo_codes promo join public.creator_partners partner on partner.id=promo.creator_id
  where promo.id=new.promo_code_id and promo.promo_type<>'free_trip' and partner.currency=new.currency;
  if new.creator_commission_cents >= round(new.final_amount*100) then
    raise exception 'PROMO_UNAVAILABLE';
  end if;
  return new;
end $$;
revoke all on function public.itbmo_snapshot_creator_deal() from public, anon, authenticated;
grant execute on function public.itbmo_snapshot_creator_deal() to service_role;

create trigger promo_redemptions_snapshot_creator_deal before insert on public.promo_redemptions
for each row execute function public.itbmo_snapshot_creator_deal();

-- Freeze already reserved terms before administrators can change an agreement.
update public.promo_redemptions r set creator_commission_cents=case
    when partner.status<>'active' then 0
    when partner.commission_type='fixed' then greatest(0,coalesce(round(partner.commission_value*100)::int,0))
    when partner.commission_type='percentage' then greatest(0,coalesce(round(r.final_amount*partner.commission_value)::int,0))
    else 0 end,
    creator_hold_days=greatest(0,coalesce(partner.hold_days,30))
from public.promo_codes promo join public.creator_partners partner on partner.id=promo.creator_id
where r.promo_code_id=promo.id and promo.promo_type<>'free_trip' and r.currency=partner.currency
  and r.status in ('reserved','consumed');

create or replace function public.itbmo_record_creator_commission() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  sale_cents integer;
  commission_cents integer;
  agreement record;
begin
  if new.provider <> 'paypal' or new.provider_transaction_id is null
    or new.currency <> 'USD' or coalesce(new.metadata->>'paypal_env','') not in ('live','sandbox')
    or new.promotion_code is null then
    return new;
  end if;

  if new.status in ('refunded','partially_refunded','canceled') or coalesce(new.refund_amount,0) > 0 then
    update public.creator_commissions c
    set reversed_cents = case
      when new.status in ('refunded','canceled') or new.refund_amount is null then c.commission_cents
      else least(c.commission_cents, round(c.commission_cents * new.refund_amount / new.amount)::integer)
    end where c.payment_id = new.id;
    return new;
  end if;

  if new.status <> 'paid' or new.paid_at is null
    or (new.metadata->>'promo_redemption_id') is null then
    return new;
  end if;

  select p.id as creator_id, p.commission_type, p.commission_value,
         coalesce(r.creator_hold_days,p.hold_days) as hold_days, r.id as redemption_id,
         r.creator_commission_cents as agreed_cents
  into agreement
  from public.promo_redemptions r
  join public.promo_codes promo on promo.id = r.promo_code_id
  join public.creator_partners p on p.id = promo.creator_id
  where r.id::text = new.metadata->>'promo_redemption_id'
    and r.promo_code_id::text = new.metadata->>'promo_code_id'
    and r.trip_id = new.trip_id and r.user_id = new.user_id
    and r.status in ('reserved','consumed')
    and r.final_amount = new.amount and r.currency = new.currency
    and promo.code = new.promotion_code and promo.promo_type <> 'free_trip'
    and (r.creator_commission_cents is not null or p.status = 'active') and p.currency = new.currency;

  if not found then
    return new;
  end if;

  sale_cents := round(new.amount * 100)::integer;
  commission_cents := coalesce(agreement.agreed_cents, case agreement.commission_type
    when 'fixed' then round(agreement.commission_value * 100)::integer
    when 'percentage' then round(sale_cents * agreement.commission_value / 100)::integer
    else 0 end);
  if commission_cents > 0 and commission_cents <= sale_cents then
    insert into public.creator_commissions(payment_id,redemption_id,creator_id,currency,
      paypal_environment,sale_cents,commission_cents,eligible_at)
    values (new.id,agreement.redemption_id,agreement.creator_id,new.currency,new.metadata->>'paypal_env',
      sale_cents,commission_cents,new.paid_at + make_interval(days => greatest(0,coalesce(agreement.hold_days,30))))
    on conflict do nothing;
  end if;
  return new;
end $$;

create view public.accounting_sale_breakdown with (security_invoker=true) as
select billed.*, payment.regular_amount, payment.promotion_code, payment.refund_amount,
  coalesce(commission.commission_cents,0)::numeric/100 as creator_commission,
  coalesce(commission.reversed_cents,0)::numeric/100 as creator_commission_reversed,
  billed.gross_amount-coalesce(commission.commission_cents,0)::numeric/100 as itbmo_share
from public.accounting_billing_sales billed
join public.payments payment on payment.id=billed.payment_id
left join public.creator_commissions commission on commission.payment_id=billed.payment_id
  and commission.paypal_environment='sandbox';

revoke all on public.accounting_sale_breakdown from public, anon, authenticated;
grant select on public.accounting_sale_breakdown to service_role;

commit;
