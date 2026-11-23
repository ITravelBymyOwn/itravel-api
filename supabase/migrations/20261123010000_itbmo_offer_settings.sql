begin;

create table public.itbmo_offer_settings (
  environment text primary key check (environment in ('preview', 'production')),
  regular_price_cents integer not null default 799 check (regular_price_cents >= 1),
  promotional_price_cents integer default 299,
  campaign_id uuid references public.instagram_campaign_settings(campaign_id),
  check (promotional_price_cents between 1 and regular_price_cents)
);

alter table public.itbmo_offer_settings enable row level security;
revoke all on public.itbmo_offer_settings from public, anon, authenticated;
grant select on public.itbmo_offer_settings to service_role;

insert into public.itbmo_offer_settings (environment) values ('preview'), ('production');

create index instagram_campaign_granted_by_campaign
  on public.instagram_campaign_participation (campaign_id) where granted_at is not null;

create function public.itbmo_current_offer(p_environment text)
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select jsonb_build_object(
    'regular_price_cents', o.regular_price_cents,
    'base_price_cents', case when current_campaign.id is not null then o.regular_price_cents
      else coalesce(o.promotional_price_cents, o.regular_price_cents) end,
    'campaign_id', current_campaign.id
  )
  from public.itbmo_offer_settings o
  left join lateral (
    select c.id
    from public.campaigns c
    join public.instagram_campaign_settings s on s.campaign_id = c.id
    where c.id = o.campaign_id and s.environment = o.environment
      and c.status = 'active' and c.starts_at <= now()
      and (c.ends_at is null or c.ends_at > now())
      and (select count(*) from public.instagram_campaign_participation p
           where p.campaign_id = c.id and p.granted_at is not null) < s.quota
  ) current_campaign on true
  where o.environment = p_environment
$$;

revoke all on function public.itbmo_current_offer(text) from public, anon, authenticated;
grant execute on function public.itbmo_current_offer(text) to service_role;

create or replace function public.itbmo_instagram_campaign_claim(
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
  if not exists (select 1 from public.itbmo_offer_settings o
      where o.environment = p_environment and o.campaign_id = v_entry.campaign_id for share)
      or v_campaign.status <> 'active' or v_campaign.starts_at is null
      or now() < v_campaign.starts_at
      or (v_campaign.ends_at is not null and now() >= v_campaign.ends_at) then
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

commit;
