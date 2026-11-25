begin;

-- Recheck the approved amount against the current balance before submission.
create function public.itbmo_start_creator_payout(
  p_payout uuid, p_environment text, p_amount_cents integer
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  batch public.creator_payouts%rowtype;
  current_balance bigint;
begin
  select * into batch from public.creator_payouts
    where id=p_payout and paypal_environment=p_environment for update;
  if not found or batch.state <> 'prepared' or batch.amount_cents is distinct from p_amount_cents then
    return null;
  end if;

  select payable_cents into current_balance from public.creator_payout_balances
    where creator_id=batch.creator_id and paypal_environment=p_environment;
  if current_balance is null or current_balance < 0 then return null; end if;

  update public.creator_payouts set state='submitting', attempted_at=now()
    where id=batch.id returning * into batch;
  return to_jsonb(batch);
end $$;

revoke all on function public.itbmo_start_creator_payout(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.itbmo_start_creator_payout(uuid,text,integer) to service_role;

commit;
