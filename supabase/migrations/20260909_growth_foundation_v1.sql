-- ITBMO Growth Foundation V1
-- Additive only. Review in Supabase before applying.

create table if not exists public.marketing_channels (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  channel_type text not null,
  enabled boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  campaign_key text not null unique,
  name text not null,
  objective text,
  destination_key text,
  language text,
  status text not null default 'draft',
  starts_at timestamptz,
  ends_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.campaign_links (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.campaigns(id) on delete cascade,
  channel_id uuid references public.marketing_channels(id) on delete set null,
  content_key text,
  creator_key text,
  referral_key text,
  landing_path text not null,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  enabled boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.attributions (
  id uuid primary key default gen_random_uuid(),
  attribution_id text not null unique,
  anonymous_id text,
  user_id uuid,
  session_id uuid,
  first_touch jsonb not null default '{}'::jsonb,
  last_meaningful_touch jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_attributions_anonymous_id on public.attributions(anonymous_id);
create index if not exists idx_attributions_user_id on public.attributions(user_id);
create index if not exists idx_attributions_session_id on public.attributions(session_id);


create table if not exists public.marketing_touchpoints (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  anonymous_id text,
  attribution_id text,
  user_id uuid,
  session_id uuid,
  trip_id uuid,
  event_name text not null,
  properties jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists idx_marketing_touchpoints_anonymous on public.marketing_touchpoints(anonymous_id);
create index if not exists idx_marketing_touchpoints_attribution on public.marketing_touchpoints(attribution_id);
create index if not exists idx_marketing_touchpoints_event on public.marketing_touchpoints(event_name, occurred_at desc);
create index if not exists idx_marketing_touchpoints_user on public.marketing_touchpoints(user_id);
create index if not exists idx_marketing_touchpoints_session on public.marketing_touchpoints(session_id);
create index if not exists idx_marketing_touchpoints_trip on public.marketing_touchpoints(trip_id);

create table if not exists public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  platform text not null,
  account_name text,
  account_external_id text,
  public_url text,
  language text,
  market text,
  status text not null default 'planned',
  connection_status text not null default 'not_connected',
  enabled boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(platform, account_external_id)
);

create table if not exists public.feature_flags (
  key text primary key,
  enabled boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.feature_flags(key, enabled) values
  ('growth_foundation_enabled', true),
  ('social_links_enabled', false),
  ('social_publishing_enabled', false),
  ('trip_share_enabled', false),
  ('partner_engine_enabled', false),
  ('brevo_lifecycle_enabled', false),
  ('campaign_landings_enabled', false),
  ('referral_enabled', false)
on conflict (key) do nothing;

insert into public.marketing_channels(slug,name,channel_type) values
  ('direct','Direct','direct'),
  ('organic_search','Organic Search','search'),
  ('instagram','Instagram','social'),
  ('tiktok','TikTok','social'),
  ('youtube','YouTube','social'),
  ('pinterest','Pinterest','social'),
  ('facebook','Facebook','social'),
  ('email','Email','lifecycle'),
  ('whatsapp','WhatsApp','lifecycle'),
  ('creator','Creator','creator'),
  ('referral','Referral','referral'),
  ('paid_search','Paid Search','paid'),
  ('paid_social','Paid Social','paid')
on conflict (slug) do nothing;
