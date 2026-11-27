begin;

create table public.creator_recorded_payments (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creator_partners(id),
  creator_code text not null,
  currency text not null check (currency = 'USD'),
  paypal_environment text not null check (paypal_environment in ('sandbox','live')),
  amount_cents integer not null check (amount_cents > 0),
  payment_date date not null,
  method text not null check (method in ('bank','paypal','other')),
  reference text not null check (char_length(reference) between 1 and 90),
  recorded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index creator_recorded_payments_reference_idx on public.creator_recorded_payments
  (paypal_environment, method, lower(reference));
create index creator_recorded_payments_creator_idx on public.creator_recorded_payments
  (creator_id, paypal_environment, created_at desc, id desc);
alter table public.creator_recorded_payments enable row level security;
revoke all on public.creator_recorded_payments from public, anon, authenticated, service_role;
grant select, insert on public.creator_recorded_payments to service_role;

create or replace view public.creator_payout_balances with (security_invoker=true) as
select p.id as creator_id, p.creator_code, p.display_name, p.currency, scope.paypal_environment,
  coalesce(c.pending_cents,0) as pending_cents,
  coalesce(c.earned_cents,0) - coalesce(b.committed_cents,0) - coalesce(recorded.paid_cents,0) as payable_cents
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
) b on true
left join lateral (
  select sum(amount_cents) as paid_cents from public.creator_recorded_payments
  where creator_id=p.id and currency=p.currency and paypal_environment=scope.paypal_environment
) recorded on true;
revoke all on public.creator_payout_balances from public, anon, authenticated;
grant select on public.creator_payout_balances to service_role;

create function public.itbmo_accounting_creator_balance(p_code text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('code', creator_code, 'name', display_name,
    'currency', currency, 'available_cents', greatest(payable_cents,0))
  from public.creator_payout_balances
  where creator_code=p_code and paypal_environment='sandbox';
$$;

create function public.itbmo_accounting_record_creator_payment(
  p_profile uuid, p_code text, p_amount integer, p_date date, p_method text, p_reference text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  partner public.creator_partners%rowtype;
  previous public.creator_recorded_payments%rowtype;
  payment_id uuid;
  available bigint;
  normalized_reference text := btrim(p_reference);
begin
  if not exists (select 1 from public.accounting_members m join public.profiles p on p.id=m.profile_id
    where m.profile_id=p_profile and m.enabled and p.account_status='active' and p.email_verified) then
    return jsonb_build_object('outcome','forbidden');
  end if;
  if p_amount is null or p_amount <= 0 or p_date is null or
     p_date not between '1900-01-01' and (now() at time zone 'America/Costa_Rica')::date or
     p_method is null or p_method not in ('bank','paypal','other') or normalized_reference is null or
     length(normalized_reference) not between 1 and 90 or normalized_reference ~ '[[:cntrl:]]' then
    return jsonb_build_object('outcome','invalid');
  end if;

  -- Coordinate with automated payout preparation, which locks the same collaborator.
  select * into partner from public.creator_partners where creator_code=p_code for update;
  if not found or partner.currency <> 'USD' then
    return jsonb_build_object('outcome','unknown_code');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('itbmo:creator:sandbox:' || p_method || ':' || lower(normalized_reference), 0));
  select * into previous from public.creator_recorded_payments
    where paypal_environment='sandbox' and method=p_method and lower(reference)=lower(normalized_reference);
  if found then
    if previous.creator_id=partner.id and previous.amount_cents=p_amount and previous.payment_date=p_date then
      return jsonb_build_object('outcome','existing','id',previous.id);
    end if;
    return jsonb_build_object('outcome','reference_conflict');
  end if;
  if p_method='paypal' and exists (select 1 from public.creator_payouts
    where paypal_environment='sandbox' and upper(provider_batch_id)=upper(normalized_reference)) then
    return jsonb_build_object('outcome','reference_conflict');
  end if;

  select payable_cents into available from public.creator_payout_balances
    where creator_id=partner.id and paypal_environment='sandbox';
  if available is null or available < p_amount then
    return jsonb_build_object('outcome','insufficient_balance','available_cents',greatest(available,0));
  end if;

  insert into public.creator_recorded_payments
    (creator_id, creator_code, currency, paypal_environment, amount_cents, payment_date, method, reference, recorded_by)
  values (partner.id, partner.creator_code, partner.currency, 'sandbox', p_amount, p_date, p_method, normalized_reference, p_profile)
  returning id into payment_id;
  return jsonb_build_object('outcome','recorded','id',payment_id);
end $$;

revoke all on function public.itbmo_accounting_creator_balance(text) from public, anon, authenticated;
revoke all on function public.itbmo_accounting_record_creator_payment(uuid,text,integer,date,text,text) from public, anon, authenticated;
grant execute on function public.itbmo_accounting_creator_balance(text) to service_role;
grant execute on function public.itbmo_accounting_record_creator_payment(uuid,text,integer,date,text,text) to service_role;

create view public.creator_payment_history with (security_invoker = true) as
select m.id, m.creator_id, m.creator_code, m.paypal_environment, m.amount_cents,
  date_trunc('month', m.payment_date::timestamp)::date as period, m.payment_date,
  'paid'::text as state, m.method, m.reference, m.created_at
from public.creator_recorded_payments m
union all
select b.id, b.creator_id, p.creator_code, b.paypal_environment, b.amount_cents, b.period,
  null::date, b.state, 'paypal', b.provider_batch_id, b.created_at
from public.creator_payouts b join public.creator_partners p on p.id=b.creator_id;

revoke all on public.creator_payment_history from public, anon, authenticated;
grant select on public.creator_payment_history to service_role;

create function public.itbmo_creator_payment_history(
  p_profile uuid, p_environment text, p_before timestamptz, p_before_id uuid
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(payment) order by created_at desc, id desc), '[]'::jsonb)
  from (
    select h.id, h.period, h.payment_date, h.creator_code, h.amount_cents, h.state, h.method, h.reference, h.created_at
    from public.creator_payment_history h
    join public.creator_partners p on p.id=h.creator_id
    where p.profile_id=p_profile and h.paypal_environment=p_environment
      and (p_before is null or (h.created_at, h.id) < (p_before, p_before_id))
    order by h.created_at desc, h.id desc limit 25
  ) payment;
$$;
revoke all on function public.itbmo_creator_payment_history(uuid,text,timestamptz,uuid) from public, anon, authenticated;
grant execute on function public.itbmo_creator_payment_history(uuid,text,timestamptz,uuid) to service_role;

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
      from public.creator_payment_history where creator_id = partner.id and paypal_environment = p_environment and state = 'paid'),
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
      select jsonb_agg(to_jsonb(payout) order by created_at desc, id desc) from (
        select id, period, payment_date, creator_code, amount_cents, state, reference, method, created_at,
          case when payment_date is null then reference end as provider_batch_id
        from public.creator_payment_history
        where creator_id = partner.id and paypal_environment = p_environment
        order by created_at desc, id desc
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

create or replace view public.accounting_journal with (security_invoker = true) as
select 'document:' || d.id::text as entry_id, d.issue_date as entry_date, 'document'::text as source,
  d.issuer as description, d.document_number as reference, d.currency,
  case when d.document_kind = 'credit_note' then -d.total else d.total end as amount,
  case when d.direction = 'income' and d.category = 'Comisiones de afiliados' and not d.affiliate_settlement then 'unclassified' else d.direction end,
  d.category,
  case when d.affiliate_settlement then 'affiliate_settlement'
       when d.direction = 'income' and d.category = 'Comisiones de afiliados' then 'pending_review' else 'recorded' end as review_status
from public.accounting_documents d where d.ready
union all
select 'impact:' || a.action_id, a.event_date, 'impact', a.program, a.action_id, a.currency,
  case when a.source_state = 'reversed' then 0 else a.amount end,
  case when a.source_state = 'approved' then 'income' else 'unclassified' end,
  'Comisiones de afiliados', a.source_state
from public.accounting_impact_actions a
union all
select 'payment:' || s.payment_id::text, (s.paid_at at time zone 'America/Costa_Rica')::date,
  'sale', 'Venta de itinerario (Sandbox)', s.capture_reference, s.currency, s.gross_amount,
  'income', 'Ventas de itinerarios', s.fiscal_status
from public.accounting_billing_sales s
union all
select 'paypal:' || m.reference, m.movement_date, 'paypal', coalesce(nullif(m.counterparty,''), 'PayPal'),
  m.reference, m.currency, m.gross_amount,
  case when m.event_code in ('T0400','T0401') then 'transfer' else 'unclassified' end,
  case when m.event_code in ('T0400','T0401') then 'Retiro de PayPal al banco' else 'Actividad PayPal' end,
  case when m.event_code in ('T0400','T0401') then 'recorded'
       when exists (select from public.accounting_billing_sales s where s.capture_reference=m.reference and s.currency=m.currency) then 'matched'
       when m.gross_amount > 0 and exists (select from public.accounting_documents d where d.ready and d.affiliate_settlement
         and d.paypal_reference=upper(m.reference) and d.currency=m.currency and d.total=m.gross_amount) then 'matched'
       when m.gross_amount < 0 and exists (select from public.creator_recorded_payments p
         where p.paypal_environment='sandbox' and p.method='paypal' and upper(p.reference)=upper(m.reference)
           and p.currency=m.currency and p.amount_cents::numeric / 100 = -m.gross_amount) then 'matched'
       else 'pending_review' end
from public.accounting_paypal_movements m
union all
select 'creator:' || p.id::text, p.payment_date, 'creator_payment',
  partner.display_name || ' · ' || p.creator_code, p.reference, p.currency, p.amount_cents::numeric / 100,
  'expense', 'Comisiones pagadas a colaboradores', 'recorded'
from public.creator_recorded_payments p
join public.creator_partners partner on partner.id=p.creator_id
where p.paypal_environment='sandbox';

commit;
