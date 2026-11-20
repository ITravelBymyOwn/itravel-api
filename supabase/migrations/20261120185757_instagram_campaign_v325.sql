begin;

create table public.instagram_campaign_settings (
  campaign_id uuid primary key references public.campaigns(id),
  environment text not null check (environment in ('preview', 'production')),
  quota integer not null check (quota > 0),
  benefit_days integer not null check (benefit_days between 1 and 365),
  new_accounts_only boolean not null default true,
  initials_after timestamptz
);

create table public.instagram_campaign_reels (
  environment text not null check (environment in ('preview', 'production')),
  media_id text not null check (media_id ~ '^[0-9]+$'),
  campaign_id uuid not null references public.instagram_campaign_settings(campaign_id),
  language text not null check (language in ('es', 'en')),
  test_keyword text,
  primary key (environment, media_id),
  unique (campaign_id, language),
  check (environment <> 'production' or test_keyword is null)
);

create table public.instagram_campaign_participation (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.instagram_campaign_settings(campaign_id),
  instagram_id text not null check (instagram_id ~ '^[0-9]+$'),
  comment_id text not null,
  language text not null check (language in ('es', 'en')),
  created_at timestamptz not null default now(),
  outbound_lease_until timestamptz,
  intro_sent_at timestamptz,
  last_message_id text,
  link_sent_at timestamptz,
  link_expires_at timestamptz,
  user_id uuid references public.profiles(id),
  granted_at timestamptz,
  benefit_expires_at timestamptz,
  redemption_id uuid references public.promo_redemptions(id),
  unique (campaign_id, instagram_id),
  unique (campaign_id, user_id)
);

create index instagram_campaign_available_benefit
  on public.instagram_campaign_participation (user_id, granted_at)
  where user_id is not null and redemption_id is null;

alter table public.instagram_campaign_settings enable row level security;
alter table public.instagram_campaign_reels enable row level security;
alter table public.instagram_campaign_participation enable row level security;
revoke all on public.instagram_campaign_settings, public.instagram_campaign_reels,
  public.instagram_campaign_participation from public, anon, authenticated;
grant select, insert, update on public.instagram_campaign_settings, public.instagram_campaign_reels,
  public.instagram_campaign_participation to service_role;

create function public.itbmo_instagram_campaign_claim(
  p_participation uuid, p_link_expires_at timestamptz, p_user uuid, p_environment text
) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_entry public.instagram_campaign_participation%rowtype;
  v_settings public.instagram_campaign_settings%rowtype;
  v_campaign public.campaigns%rowtype;
  v_user public.profiles%rowtype;
begin
  select * into v_entry from public.instagram_campaign_participation where id = p_participation;
  if not found then return jsonb_build_object('code', 'LINK_INVALID'); end if;

  -- Serializa el cupo de ambos reels y la asignación por cuenta.
  select * into v_settings from public.instagram_campaign_settings
    where campaign_id = v_entry.campaign_id and environment = p_environment for update;
  if not found then return jsonb_build_object('code', 'LINK_INVALID'); end if;

  select * into v_campaign from public.campaigns where id = v_entry.campaign_id for update;
  select * into v_entry from public.instagram_campaign_participation where id = p_participation for update;
  if v_entry.link_expires_at is distinct from p_link_expires_at or v_entry.link_expires_at is null then
    return jsonb_build_object('code', 'LINK_INVALID');
  end if;
  select * into v_user from public.profiles where id = p_user;
  if not found or v_user.auth_user_id is null or v_user.email_verified is not true
      or v_user.account_status is distinct from 'active' then
    return jsonb_build_object('code', 'VERIFIED_ACCOUNT_REQUIRED');
  end if;
  if v_entry.user_id = p_user then
    return jsonb_build_object('code', 'CLAIMED', 'expires_at', v_entry.benefit_expires_at);
  end if;
  if v_entry.user_id is not null or v_entry.link_expires_at <= now() then
    return jsonb_build_object('code', 'LINK_INVALID');
  end if;
  if v_campaign.status <> 'active' or v_campaign.starts_at is null or v_campaign.ends_at is null
      or now() < v_campaign.starts_at or now() >= v_campaign.ends_at then
    return jsonb_build_object('code', 'CAMPAIGN_CLOSED');
  end if;
  if v_settings.new_accounts_only and coalesce(v_settings.initials_after, v_campaign.starts_at) > v_user.created_at then
    return jsonb_build_object('code', 'NEW_ACCOUNT_REQUIRED');
  end if;
  if exists (select 1 from public.instagram_campaign_participation
      where campaign_id = v_entry.campaign_id and user_id = p_user) then
    return jsonb_build_object('code', 'ALREADY_CLAIMED');
  end if;
  if (select count(*) from public.instagram_campaign_participation
      where campaign_id = v_entry.campaign_id and granted_at is not null) >= v_settings.quota then
    return jsonb_build_object('code', 'CAMPAIGN_FULL');
  end if;

  update public.instagram_campaign_participation
    set user_id = p_user, granted_at = now(), benefit_expires_at = now() + make_interval(days => v_settings.benefit_days)
    where id = p_participation returning * into v_entry;
  return jsonb_build_object('code', 'CLAIMED', 'expires_at', v_entry.benefit_expires_at);
end;
$$;

create function public.itbmo_instagram_campaign_redeem(
  p_user uuid, p_session uuid, p_trip uuid, p_environment text, p_base numeric, p_currency text
) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_entry public.instagram_campaign_participation%rowtype;
  v_trip public.trips%rowtype;
  v_redemption uuid;
  v_promo uuid;
  v_promo_code text;
begin
  select * into v_trip from public.trips where id = p_trip and user_id = p_user for update;
  if not found or v_trip.status is distinct from 'saved'
      or v_trip.generated_at is not null or coalesce(v_trip.generation_count, 0) <> 0 then
    return jsonb_build_object('code', 'TRIP_UNAVAILABLE');
  end if;
  if exists (select 1 from public.payments where trip_id = p_trip and user_id = p_user and status = 'paid')
      or exists (select 1 from public.promo_redemptions
        where trip_id = p_trip and user_id = p_user and status = 'consumed' and final_amount = 0) then
    return jsonb_build_object('code', 'TRIP_AUTHORIZED');
  end if;

  if exists (select 1 from public.payments where trip_id = p_trip and user_id = p_user and status = 'pending') then
    return jsonb_build_object('code', 'PAYMENT_PENDING');
  end if;

  select entry.* into v_entry from public.instagram_campaign_participation entry
    join public.instagram_campaign_settings settings using (campaign_id)
    where entry.user_id = p_user and entry.redemption_id is null and entry.benefit_expires_at > now()
      and settings.environment = p_environment
    order by entry.benefit_expires_at, entry.id limit 1 for update of entry;
  if not found then return jsonb_build_object('code', 'BENEFIT_UNAVAILABLE'); end if;

  -- Reutiliza el permiso de generación y recuperación por viaje del Planner.
  -- El código interno está inactivo para el canje manual.
  v_promo_code := 'IG-' || upper(v_entry.campaign_id::text);
  insert into public.promo_codes
    (code, name, campaign_id, promo_type, discount_value, currency, active, registered_only, verified_only)
    values (v_promo_code, 'Instagram free itinerary', v_entry.campaign_id, 'free_trip', 100, p_currency, false, true, true)
    on conflict do nothing;
  select id into strict v_promo from public.promo_codes where code = v_promo_code
    and campaign_id = v_entry.campaign_id and promo_type = 'free_trip' and active is false;
  insert into public.promo_redemptions
    (promo_code_id, user_id, trip_id, session_id, status, base_amount, discount_amount, final_amount, currency, consumed_at, metadata)
    values (v_promo, p_user, p_trip, p_session, 'consumed', p_base, p_base, 0, p_currency, now(),
      jsonb_build_object('source', 'instagram_campaign'))
    returning id into v_redemption;

  update public.instagram_campaign_participation set redemption_id = v_redemption where id = v_entry.id;
  return jsonb_build_object('code', 'REDEEMED', 'redemption_id', v_redemption);
end;
$$;

revoke all on function public.itbmo_instagram_campaign_claim(uuid, timestamptz, uuid, text)
  from public, anon, authenticated;
revoke all on function public.itbmo_instagram_campaign_redeem(uuid, uuid, uuid, text, numeric, text)
  from public, anon, authenticated;
grant execute on function public.itbmo_instagram_campaign_claim(uuid, timestamptz, uuid, text) to service_role;
grant execute on function public.itbmo_instagram_campaign_redeem(uuid, uuid, uuid, text, numeric, text) to service_role;

commit;
