begin;

alter table public.accounting_documents drop constraint accounting_documents_direction_check;
alter table public.accounting_documents add constraint accounting_documents_direction_check
  check (direction in ('expense', 'income', 'transfer'));

create table public.accounting_paypal_movements (
  reference text primary key,
  movement_date date not null,
  counterparty text not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  gross_amount numeric(18,5) not null,
  fee_amount numeric(18,5) not null,
  net_amount numeric(18,5) not null,
  event_code text not null check (event_code ~ '^T[0-9]{4}$'),
  imported_by uuid references public.profiles(id) on delete set null,
  imported_at timestamptz not null default now()
);
alter table public.accounting_paypal_movements enable row level security;
revoke all on public.accounting_paypal_movements from public, anon, authenticated;
grant select, insert on public.accounting_paypal_movements to service_role;

create table public.accounting_impact_actions (
  action_id text primary key,
  program_id text not null,
  program text not null,
  event_date date not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  amount numeric(18,5) not null,
  source_state text not null check (source_state in ('pending', 'approved', 'reversed')),
  observed_at timestamptz not null
);
alter table public.accounting_impact_actions enable row level security;
revoke all on public.accounting_impact_actions from public, anon, authenticated;
grant select, insert, update on public.accounting_impact_actions to service_role;
create index accounting_impact_actions_event_date_idx on public.accounting_impact_actions (event_date);

create function public.itbmo_accounting_save_impact_action(p_action jsonb)
returns void language sql set search_path = '' as $$
  insert into public.accounting_impact_actions as current_action
    (action_id, program_id, program, event_date, currency, amount, source_state, observed_at)
  select action_id, program_id, program, event_date, currency, amount, source_state, observed_at
  from jsonb_populate_record(null::public.accounting_impact_actions, p_action)
  on conflict (action_id) do update set
    program_id = excluded.program_id, program = excluded.program,
    event_date = excluded.event_date, currency = excluded.currency, amount = excluded.amount,
    source_state = excluded.source_state, observed_at = excluded.observed_at
  where excluded.observed_at >= current_action.observed_at;
$$;
revoke all on function public.itbmo_accounting_save_impact_action(jsonb) from public, anon, authenticated;
grant execute on function public.itbmo_accounting_save_impact_action(jsonb) to service_role;

create view public.accounting_journal with (security_invoker = true) as
select 'document:' || d.id::text as entry_id, d.issue_date as entry_date, 'document'::text as source,
  d.issuer as description, d.document_number as reference, d.currency,
  case when d.document_kind = 'credit_note' then -d.total else d.total end as amount,
  case when d.direction = 'income' and d.category = 'Comisiones de afiliados' then 'unclassified' else d.direction end,
  d.category,
  case when d.direction = 'income' and d.category = 'Comisiones de afiliados' then 'pending_review' else 'recorded' end as review_status
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
       when exists (select from public.accounting_documents d where d.ready and upper(d.document_number)=m.reference
         and d.currency=m.currency and d.direction='income' and d.category='Comisiones de afiliados') then 'matched'
       else 'pending_review' end
from public.accounting_paypal_movements m;

revoke all on public.accounting_journal from public, anon, authenticated;
grant select on public.accounting_journal to service_role;

commit;
