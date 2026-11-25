begin;

create table public.creator_payouts (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creator_partners(id),
  period date not null,
  currency text not null check (currency = 'USD'),
  paypal_environment text not null check (paypal_environment in ('sandbox','live')),
  amount_cents integer not null check (amount_cents > 0),
  recipient text not null check (recipient ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
  state text not null default 'prepared'
    check (state in ('prepared','submitting','processing','paid','failed','returned','review')),
  provider_batch_id text unique,
  attempted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (creator_id, period, paypal_environment)
);

create table public.creator_commissions (
  payment_id uuid primary key references public.payments(id),
  redemption_id uuid not null unique references public.promo_redemptions(id),
  creator_id uuid not null references public.creator_partners(id),
  currency text not null check (currency = 'USD'),
  paypal_environment text not null check (paypal_environment in ('sandbox','live')),
  sale_cents integer not null check (sale_cents > 0),
  commission_cents integer not null check (commission_cents > 0 and commission_cents <= sale_cents),
  reversed_cents integer not null default 0 check (reversed_cents between 0 and commission_cents),
  eligible_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index creator_commissions_eligible_idx on public.creator_commissions (creator_id, eligible_at);
alter table public.creator_commissions enable row level security;
alter table public.creator_payouts enable row level security;
revoke all on public.creator_commissions, public.creator_payouts from public, anon, authenticated;
grant select, insert, update on public.creator_commissions, public.creator_payouts to service_role;

create function public.itbmo_record_creator_commission() returns trigger
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
         p.hold_days, r.id as redemption_id
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
    and p.status = 'active' and p.currency = new.currency;

  if not found or agreement.commission_value is null or agreement.commission_value <= 0 then
    return new;
  end if;

  sale_cents := round(new.amount * 100)::integer;
  commission_cents := case agreement.commission_type
    when 'fixed' then round(agreement.commission_value * 100)::integer
    when 'percentage' then round(sale_cents * agreement.commission_value / 100)::integer
    else 0 end;
  if commission_cents > 0 and commission_cents <= sale_cents then
    insert into public.creator_commissions(payment_id,redemption_id,creator_id,currency,
      paypal_environment,sale_cents,commission_cents,eligible_at)
    values (new.id,agreement.redemption_id,agreement.creator_id,new.currency,new.metadata->>'paypal_env',
      sale_cents,commission_cents,new.paid_at + make_interval(days => greatest(0,coalesce(agreement.hold_days,30))))
    on conflict do nothing;
  end if;
  return new;
end $$;

create trigger payments_record_creator_commission
after update of status, paid_at, refund_amount on public.payments
for each row execute function public.itbmo_record_creator_commission();

-- One balance per creator. Pending submissions reserve funds until PayPal resolves them.
create view public.creator_payout_balances with (security_invoker=true) as
select p.id as creator_id, p.creator_code, p.display_name, p.currency, scope.paypal_environment,
  coalesce(c.pending_cents,0) as pending_cents,
  coalesce(c.earned_cents,0) - coalesce(b.committed_cents,0) as payable_cents
from public.creator_partners p
cross join (values ('sandbox'), ('live')) as scope(paypal_environment)
left join lateral (
  select
    sum(commission_cents-reversed_cents) filter (where eligible_at > now()) as pending_cents,
    sum(commission_cents-reversed_cents) filter (where eligible_at <= now()) as earned_cents
  from public.creator_commissions where creator_id=p.id and currency=p.currency
    and paypal_environment=scope.paypal_environment
) c on true
left join lateral (
  select sum(amount_cents) as committed_cents from public.creator_payouts
  where creator_id=p.id and currency=p.currency and paypal_environment=scope.paypal_environment
    and state not in ('failed','returned')
) b on true;
revoke all on public.creator_payout_balances from public, anon, authenticated;
grant select on public.creator_payout_balances to service_role;

-- Serialize batch preparation per creator and capture the recipient and amount
-- on the settlement record before calling PayPal.
create function public.itbmo_prepare_creator_payout(
  p_creator uuid, p_environment text, p_amount_cents integer
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  partner public.creator_partners%rowtype;
  payout public.creator_payouts%rowtype;
  available bigint;
  this_period date := date_trunc('month', now() at time zone 'UTC')::date;
begin
  if p_environment not in ('sandbox','live') or p_amount_cents is null or p_amount_cents <= 0 then
    return null;
  end if;
  select * into partner from public.creator_partners where id=p_creator for update;
  if not found or partner.payout_method is distinct from 'paypal'
    or partner.payout_reference is null or partner.currency <> 'USD' then
    return null;
  end if;

  select * into payout from public.creator_payouts
    where creator_id=p_creator and period=this_period and paypal_environment=p_environment;
  if found then
    if payout.amount_cents <> p_amount_cents then return null; end if;
    return to_jsonb(payout);
  end if;
  if exists (select 1 from public.creator_payouts where creator_id=p_creator
    and paypal_environment=p_environment and state in ('prepared','submitting','processing','review')) then
    return null;
  end if;

  select payable_cents into available from public.creator_payout_balances
    where creator_id=p_creator and paypal_environment=p_environment;
  if available is null or available <> p_amount_cents then return null; end if;

  insert into public.creator_payouts(creator_id,period,currency,paypal_environment,amount_cents,recipient)
  values(p_creator,this_period,partner.currency,p_environment,p_amount_cents,partner.payout_reference)
  returning * into payout;
  return to_jsonb(payout);
end $$;
revoke all on function public.itbmo_prepare_creator_payout(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.itbmo_prepare_creator_payout(uuid,text,integer) to service_role;

revoke all on function public.itbmo_record_creator_commission() from public, anon, authenticated;
grant execute on function public.itbmo_record_creator_commission() to service_role;

commit;
