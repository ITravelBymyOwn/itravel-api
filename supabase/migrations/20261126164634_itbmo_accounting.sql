begin;

create table public.accounting_members (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  enabled boolean not null default true
);

create table public.accounting_documents (
  id uuid primary key default gen_random_uuid(),
  created_by uuid references public.profiles(id) on delete set null,
  issue_date date not null check (issue_date between '1900-01-01' and '2199-12-31'),
  direction text not null check (direction in ('expense', 'income')),
  document_kind text not null check (document_kind in ('invoice', 'receipt', 'credit_note', 'debit_note', 'other')),
  jurisdiction text not null check (jurisdiction in ('CR', 'foreign', 'pending')),
  issuer text not null,
  issuer_id text,
  document_number text,
  document_key text check (document_key ~ '^[0-9]{50}$'),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  subtotal numeric(18,5) check (subtotal >= 0),
  tax numeric(18,5) check (tax >= 0),
  total numeric(18,5) not null check (total >= 0),
  exchange_rate numeric(18,5) check (exchange_rate > 0),
  category text not null,
  vat_treatment text not null check (vat_treatment in ('pending', 'eligible', 'ineligible', 'partial', 'not_applicable')),
  income_tax_treatment text not null check (income_tax_treatment in ('pending', 'eligible', 'ineligible', 'partial', 'not_applicable')),
  extraction_method text not null check (extraction_method in ('xml', 'pdf_text', 'ocr', 'mixed', 'manual')),
  notes text,
  original_name text not null,
  content_type text not null,
  sha256 text not null unique check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size integer not null check (byte_size between 1 and 3145728),
  storage_path text not null unique,
  ready boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index accounting_documents_key_idx on public.accounting_documents(document_key) where document_key is not null;
create index accounting_documents_calendar_idx on public.accounting_documents(issue_date desc, id) where ready;

alter table public.accounting_members enable row level security;
alter table public.accounting_documents enable row level security;
revoke all on public.accounting_members, public.accounting_documents from public, anon, authenticated;
grant select on public.accounting_members to service_role;
grant select, insert, update on public.accounting_documents to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('itbmo-accounting', 'itbmo-accounting', false, 3145728,
  array['application/xml', 'application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

create function public.itbmo_accounting_reserve(p_profile uuid, p_document jsonb)
returns table(outcome text, document_id uuid, object_path text)
language plpgsql security invoker set search_path = '' as $$
declare
  existing public.accounting_documents%rowtype;
  new_id uuid := gen_random_uuid();
  document_size integer := (p_document->>'byte_size')::integer;
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
  order by (sha256 = p_document->>'sha256') desc limit 1;

  if found then
    if not existing.ready and existing.sha256 = p_document->>'sha256' then
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

  relative_path := to_char((p_document->>'issue_date')::date, 'YYYY/MM/DD')
    || '/' || new_id || '.' || (p_document->>'extension');
  insert into public.accounting_documents (
    id, created_by, issue_date, direction, document_kind, jurisdiction, issuer, issuer_id, document_number,
    document_key, currency, subtotal, tax, total, exchange_rate, category,
    vat_treatment, income_tax_treatment, extraction_method, notes,
    original_name, content_type, sha256, byte_size, storage_path
  ) values (
    new_id, p_profile, (p_document->>'issue_date')::date, p_document->>'direction',
    p_document->>'document_kind', p_document->>'jurisdiction', p_document->>'issuer', p_document->>'issuer_id',
    p_document->>'document_number', p_document->>'document_key', p_document->>'currency',
    (p_document->>'subtotal')::numeric, (p_document->>'tax')::numeric,
    (p_document->>'total')::numeric, (p_document->>'exchange_rate')::numeric,
    p_document->>'category', p_document->>'vat_treatment', p_document->>'income_tax_treatment',
    p_document->>'extraction_method', p_document->>'notes', p_document->>'original_name',
    p_document->>'content_type', p_document->>'sha256', document_size, relative_path
  );
  return query select 'reserved'::text, new_id, relative_path;
end;
$$;

revoke all on function public.itbmo_accounting_reserve(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.itbmo_accounting_reserve(uuid, jsonb) to service_role;

commit;
