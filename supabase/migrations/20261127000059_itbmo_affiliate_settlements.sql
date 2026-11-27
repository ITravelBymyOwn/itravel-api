begin;

alter table public.accounting_documents
  add column affiliate_settlement boolean not null default false,
  add column paypal_reference text check (paypal_reference ~ '^[A-Z0-9-]{1,64}$' and affiliate_settlement),
  alter column storage_path drop not null,
  alter column original_name drop not null,
  alter column content_type drop not null,
  alter column sha256 drop not null,
  drop constraint accounting_documents_byte_size_check;

alter table public.accounting_documents add constraint accounting_documents_attachment_check check (
  (byte_size between 1 and 3145728 and storage_path is not null and original_name is not null and content_type is not null and sha256 is not null)
  or (affiliate_settlement and byte_size = 0 and ready and storage_path is null and original_name is null and content_type is null and sha256 is null)
);
alter table public.accounting_documents add constraint accounting_documents_affiliate_settlement_check check (
  not affiliate_settlement or (
    direction = 'income' and category = 'Comisiones de afiliados' and document_number is not null and total > 0
  )
);

create unique index accounting_documents_affiliate_payout_idx
  on public.accounting_documents (lower(issuer), lower(document_number)) where affiliate_settlement;
create unique index accounting_documents_affiliate_paypal_idx
  on public.accounting_documents (paypal_reference) where affiliate_settlement and paypal_reference is not null;

create or replace function public.itbmo_accounting_reserve(p_profile uuid, p_document jsonb)
returns table(outcome text, document_id uuid, object_path text)
language plpgsql security invoker set search_path = '' as $$
declare
  existing public.accounting_documents%rowtype;
  new_id uuid := gen_random_uuid();
  document_size integer := coalesce((p_document->>'byte_size')::integer, 0);
  settlement boolean := coalesce((p_document->>'affiliate_settlement')::boolean, false);
  relative_path text;
begin
  if not exists (
    select 1 from public.accounting_members m
    join public.profiles p on p.id = m.profile_id
    where m.profile_id = p_profile and m.enabled and p.email_verified and p.account_status = 'active'
  ) then
    return query select 'forbidden'::text, null::uuid, null::text;
    return;
  end if;

  -- Serialize the quota and deduplication decisions across both ledger members.
  perform pg_advisory_xact_lock(2058981176);
  select * into existing from public.accounting_documents
  where sha256 = p_document->>'sha256' or document_key = p_document->>'document_key'
    or (settlement and affiliate_settlement and (
      (lower(issuer) = lower(p_document->>'issuer') and lower(document_number) = lower(p_document->>'document_number'))
      or paypal_reference = p_document->>'paypal_reference'
    ))
  order by (sha256 = p_document->>'sha256') desc nulls last limit 1;

  if found then
    if not existing.ready and existing.sha256 = p_document->>'sha256'
       and existing.affiliate_settlement = settlement
       and (not settlement or (
         lower(existing.issuer) = lower(p_document->>'issuer')
         and lower(existing.document_number) = lower(p_document->>'document_number')
         and existing.paypal_reference is not distinct from p_document->>'paypal_reference'
         and existing.issue_date = (p_document->>'issue_date')::date
         and existing.currency = p_document->>'currency' and existing.total = (p_document->>'total')::numeric
       )) then
      return query select 'retry'::text, existing.id, existing.storage_path;
    else
      return query select 'duplicate'::text, existing.id, null::text;
    end if;
    return;
  end if;

  if (select coalesce(sum(byte_size), 0) from public.accounting_documents) + document_size > 104857600 then
    return query select 'quota'::text, null::uuid, null::text;
    return;
  end if;

  if document_size > 0 then
    relative_path := to_char((p_document->>'issue_date')::date, 'YYYY/MM/DD')
    || '/' || new_id || '.' || (p_document->>'extension');
  end if;
  insert into public.accounting_documents (
    id, created_by, issue_date, direction, document_kind, jurisdiction, issuer, issuer_id, document_number,
    document_key, currency, subtotal, tax, total, exchange_rate, category,
    vat_treatment, income_tax_treatment, extraction_method, notes,
    original_name, content_type, sha256, byte_size, storage_path, ready, affiliate_settlement, paypal_reference
  ) values (
    new_id, p_profile, (p_document->>'issue_date')::date, p_document->>'direction',
    p_document->>'document_kind', p_document->>'jurisdiction', p_document->>'issuer', p_document->>'issuer_id',
    p_document->>'document_number', p_document->>'document_key', p_document->>'currency',
    (p_document->>'subtotal')::numeric, (p_document->>'tax')::numeric,
    (p_document->>'total')::numeric, (p_document->>'exchange_rate')::numeric,
    p_document->>'category', p_document->>'vat_treatment', p_document->>'income_tax_treatment',
    p_document->>'extraction_method', p_document->>'notes', p_document->>'original_name',
    p_document->>'content_type', p_document->>'sha256', document_size, relative_path, document_size = 0, settlement, p_document->>'paypal_reference'
  );
  return query select 'reserved'::text, new_id, relative_path;
end;
$$;

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
       else 'pending_review' end
from public.accounting_paypal_movements m;

commit;
