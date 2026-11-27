begin;

create table public.accounting_billing_sales (
  payment_id uuid primary key references public.payments(id),
  provider text not null,
  capture_reference text not null,
  paid_at timestamptz not null,
  gross_amount numeric not null check (gross_amount > 0),
  currency text not null,
  processing_environment text not null check (processing_environment = 'sandbox'),
  fiscal_status text not null default 'pending_review' check (fiscal_status in ('pending_review','ready','submitted','accepted','rejected')),
  delivery_status text not null default 'pending' check (delivery_status in ('pending','sent','failed')),
  territorial_treatment text check (territorial_treatment in ('domestic','export')),
  evidence_reference text,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  document_type text check (document_type in ('01','04','09')),
  net_amount numeric,
  vat_amount numeric,
  document_key text unique check (document_key ~ '^[0-9]{50}$'),
  signed_xml_path text,
  hacienda_response_path text,
  pdf_path text,
  unique (provider, processing_environment, capture_reference)
);

create index accounting_billing_sales_period_idx on public.accounting_billing_sales(paid_at desc, payment_id);
alter table public.accounting_billing_sales enable row level security;
revoke all on public.accounting_billing_sales from public, anon, authenticated;
grant select, insert, update on public.accounting_billing_sales to service_role;

create function public.itbmo_review_billing_sale(
  p_payment uuid, p_treatment text, p_type text, p_evidence text, p_profile uuid
) returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (select 1 from public.accounting_members m join public.profiles p on p.id=m.profile_id
    where m.profile_id=p_profile and m.enabled and p.email_verified and p.account_status='active')
    or coalesce(char_length(trim(p_evidence)),0) not between 5 and 500
    or not coalesce((p_treatment='domestic' and p_type in ('01','04')) or (p_treatment='export' and p_type='09'), false)
  then return false; end if;

  -- The transaction total is preserved. The draft assumes VAT is included in domestic prices.
  update public.accounting_billing_sales
    set territorial_treatment=p_treatment, document_type=p_type, evidence_reference=trim(p_evidence),
        reviewed_by=p_profile, reviewed_at=now(),
        net_amount=case when p_treatment='domestic' then round(gross_amount / 1.13, 2) else gross_amount end,
        vat_amount=case when p_treatment='domestic' then gross_amount - round(gross_amount / 1.13, 2) else 0 end,
        fiscal_status='ready'
    where payment_id=p_payment and fiscal_status='pending_review';
  return found;
end;
$$;

revoke all on function public.itbmo_review_billing_sale(uuid,text,text,text,uuid) from public, anon, authenticated;
grant execute on function public.itbmo_review_billing_sale(uuid,text,text,text,uuid) to service_role;

create function public.itbmo_enqueue_billing_sale()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.status = 'paid' and new.amount > 0 and new.paid_at is not null
     and new.provider = 'paypal' and new.metadata->>'paypal_env' = 'sandbox'
     and new.metadata->>'product' = 'itbmo_premium_journey'
     and new.provider_status = 'COMPLETED' and nullif(btrim(new.provider_transaction_id), '') is not null then
    insert into public.accounting_billing_sales (
      payment_id, provider, capture_reference, paid_at, gross_amount, currency, processing_environment
    ) values (
      new.id, new.provider, new.provider_transaction_id, new.paid_at, new.amount, new.currency, 'sandbox'
    ) on conflict do nothing;
  end if;
  return new;
end;
$$;

revoke all on function public.itbmo_enqueue_billing_sale() from public, anon, authenticated;
grant execute on function public.itbmo_enqueue_billing_sale() to service_role;

create trigger itbmo_enqueue_billing_sale after insert or update of status, provider_transaction_id, provider_status, paid_at
on public.payments for each row execute function public.itbmo_enqueue_billing_sale();

commit;
