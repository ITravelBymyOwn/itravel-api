begin;

create function public.itbmo_admin_web_offer(
  p_profile uuid, p_regular integer default null, p_promotion integer default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  offer public.itbmo_offer_settings%rowtype;
begin
  if not public.itbmo_accounting_admin(p_profile) then return null; end if;
  if p_regular is not null then
    if p_regular not between 1 and 99999999 or
       (p_promotion is not null and (p_promotion < 1 or p_promotion >= p_regular)) then
      return jsonb_build_object('outcome','invalid');
    end if;
    update public.itbmo_offer_settings
      set regular_price_cents=p_regular, promotional_price_cents=p_promotion
      where environment='preview';
  end if;
  select * into offer from public.itbmo_offer_settings where environment='preview';
  return public.itbmo_current_offer('preview') ||
    jsonb_build_object('promotion_cents',offer.promotional_price_cents);
end $$;
grant update (regular_price_cents, promotional_price_cents) on public.itbmo_offer_settings to service_role;
revoke all on function public.itbmo_admin_web_offer(uuid,integer,integer) from public, anon, authenticated;
grant execute on function public.itbmo_admin_web_offer(uuid,integer,integer) to service_role;

create function public.itbmo_reserve_checkout_promo(
  p_code text, p_user_id uuid, p_trip_id uuid, p_session_id uuid,
  p_is_registered boolean, p_is_verified boolean
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  pricing jsonb := public.itbmo_current_offer('preview');
  regular numeric := (pricing->>'regular_price_cents')::numeric/100;
  base numeric := (pricing->>'base_price_cents')::numeric/100;
  reservation record;
  snapshot jsonb;
begin
  if regular is null or base is null then return null; end if;
  select * into reservation from public.itbmo_reserve_promo(
    p_code,p_user_id,p_trip_id,p_session_id,base,'USD',p_is_registered,p_is_verified);
  if not found then return null; end if;

  update public.promo_redemptions r
    set metadata=coalesce(r.metadata,'{}'::jsonb) || jsonb_build_object(
      'checkout_pricing',jsonb_build_object('regular_amount',greatest(regular,r.base_amount),
        'campaign_id',pricing->'campaign_id'))
    where r.id=reservation.redemption_id and not (coalesce(r.metadata,'{}'::jsonb) ? 'checkout_pricing')
      and r.base_amount=base and r.status='reserved';
  select metadata->'checkout_pricing' into snapshot from public.promo_redemptions
    where id=reservation.redemption_id;
  return to_jsonb(reservation) || jsonb_build_object('regular_amount',snapshot->'regular_amount');
end $$;
revoke all on function public.itbmo_reserve_checkout_promo(text,uuid,uuid,uuid,boolean,boolean) from public, anon, authenticated;
grant execute on function public.itbmo_reserve_checkout_promo(text,uuid,uuid,uuid,boolean,boolean) to service_role;

create or replace view public.accounting_sale_breakdown with (security_invoker=true) as
select billed.*, payment.regular_amount, payment.promotion_code, payment.refund_amount,
  coalesce(commission.commission_cents,0)::numeric/100 as creator_commission,
  coalesce(commission.reversed_cents,0)::numeric/100 as creator_commission_reversed,
  billed.gross_amount-coalesce(commission.commission_cents,0)::numeric/100 as itbmo_share,
  case when payment.metadata->>'base_amount' ~ '^[0-9]+(\.[0-9]{1,2})?$'
    then greatest(0,payment.regular_amount - (payment.metadata->>'base_amount')::numeric)
    when payment.promotion_code='site_promotion' then greatest(0,payment.regular_amount-billed.gross_amount)
    else null end as web_discount,
  case when payment.promotion_code is null or payment.promotion_code='site_promotion' then 0
    when payment.metadata->>'discount_amount' ~ '^[0-9]+(\.[0-9]{1,2})?$'
    then (payment.metadata->>'discount_amount')::numeric
    else null end as code_discount
from public.accounting_billing_sales billed
join public.payments payment on payment.id=billed.payment_id
left join public.creator_commissions commission on commission.payment_id=billed.payment_id
  and commission.paypal_environment='sandbox';

commit;
;
