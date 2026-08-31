-- TenderFans V1 core architecture
-- Public users: search + structured shout-outs. No public comments or uploads.
-- Claimed bartenders/businesses: bio + own media gallery.
-- Future modules attach to durable bartender/venue IDs.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create type public.entity_kind as enum ('bartender','venue');
create type public.claim_status as enum ('pending','approved','rejected','revoked');
create type public.membership_role as enum ('owner','manager','marketing');
create type public.media_status as enum ('pending','published','hidden','removed');
create type public.promotion_status as enum ('draft','active','paused','ended');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (char_length(username) between 3 and 30),
  account_status text not null default 'active' check (account_status in ('active','suspended','deleted')),
  created_at timestamptz not null default now()
);

create table public.venues (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  venue_type text not null default 'bar',
  description text,
  street_address text,
  city text not null,
  state_region text not null,
  postal_code text,
  country_code char(2) not null default 'US',
  latitude double precision,
  longitude double precision,
  website_url text,
  public_phone text,
  opened_at date,
  first_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active','hidden','closed','removed'))
);

create table public.venue_external_refs (
  venue_id uuid not null references public.venues(id) on delete cascade,
  provider text not null check (provider in ('google_places','apple_maps','other')),
  provider_place_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  primary key(provider, provider_place_id),
  unique(venue_id, provider)
);

create table public.bartenders (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  display_name text not null,
  bio text,
  first_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active','hidden','removed'))
);

create table public.bartender_venues (
  id uuid primary key default gen_random_uuid(),
  bartender_id uuid not null references public.bartenders(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  is_current boolean not null default true,
  started_at date,
  ended_at date,
  unique(bartender_id, venue_id, started_at)
);

create table public.bartender_aliases (
  id uuid primary key default gen_random_uuid(),
  bartender_id uuid not null references public.bartenders(id) on delete cascade,
  alias text not null,
  normalized_alias text not null,
  venue_id uuid references public.venues(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index bartender_aliases_trgm on public.bartender_aliases using gin (normalized_alias gin_trgm_ops);
create index bartender_names_trgm on public.bartenders using gin (display_name gin_trgm_ops);
create index venue_names_trgm on public.venues using gin (name gin_trgm_ops);

create table public.entity_claims (
  id uuid primary key default gen_random_uuid(),
  entity_kind public.entity_kind not null,
  bartender_id uuid references public.bartenders(id) on delete cascade,
  venue_id uuid references public.venues(id) on delete cascade,
  claimant_user_id uuid not null references public.profiles(id) on delete cascade,
  status public.claim_status not null default 'pending',
  verification_method text,
  verification_notes text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check ((entity_kind='bartender' and bartender_id is not null and venue_id is null) or (entity_kind='venue' and venue_id is not null and bartender_id is null))
);

create table public.bartender_permissions (
  bartender_id uuid not null references public.bartenders(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  can_edit boolean not null default true,
  can_manage_media boolean not null default true,
  primary key(bartender_id,user_id)
);

create table public.venue_permissions (
  venue_id uuid not null references public.venues(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.membership_role not null default 'manager',
  can_edit boolean not null default true,
  can_manage_media boolean not null default true,
  can_manage_marketing boolean not null default false,
  primary key(venue_id,user_id)
);

create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  entity_kind public.entity_kind not null,
  bartender_id uuid references public.bartenders(id) on delete cascade,
  venue_id uuid references public.venues(id) on delete cascade,
  uploaded_by_user_id uuid not null references public.profiles(id) on delete cascade,
  storage_path text not null,
  alt_text text,
  is_hero boolean not null default false,
  sort_order integer not null default 0,
  status public.media_status not null default 'published',
  created_at timestamptz not null default now(),
  check ((entity_kind='bartender' and bartender_id is not null and venue_id is null) or (entity_kind='venue' and venue_id is not null and bartender_id is null))
);

create table public.traits (
  id smallserial primary key,
  label text not null unique,
  audience public.entity_kind not null,
  active boolean not null default true
);

create table public.voices (
  id smallserial primary key,
  name text not null unique,
  active boolean not null default true
);

create table public.shoutouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  bartender_id uuid not null references public.bartenders(id) on delete restrict,
  venue_id uuid not null references public.venues(id) on delete restrict,
  voice_id smallint references public.voices(id),
  status text not null default 'published' check (status in ('published','hidden','removed')),
  created_at timestamptz not null default now()
);

create table public.shoutout_traits (
  shoutout_id uuid not null references public.shoutouts(id) on delete cascade,
  trait_id smallint not null references public.traits(id),
  primary key(shoutout_id,trait_id)
);

-- Reversible duplicate consolidation. Shoutouts are repointed to canonical bartender_id;
-- source records remain auditable and aliases help future matching.
create table public.bartender_merges (
  id uuid primary key default gen_random_uuid(),
  source_bartender_id uuid not null references public.bartenders(id),
  canonical_bartender_id uuid not null references public.bartenders(id),
  merged_by_user_id uuid references public.profiles(id),
  reason text,
  reversed_at timestamptz,
  created_at timestamptz not null default now(),
  check(source_bartender_id <> canonical_bartender_id)
);

-- Aggregate-friendly analytics: no GPS history or unnecessary personal details.
create table public.analytics_events (
  id bigserial primary key,
  event_name text not null,
  venue_id uuid references public.venues(id) on delete cascade,
  bartender_id uuid references public.bartenders(id) on delete cascade,
  session_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index analytics_venue_time on public.analytics_events(venue_id,created_at desc);
create index analytics_bartender_time on public.analytics_events(bartender_id,created_at desc);

-- Near-future modules: present as extension points, no V1 public UI required.
create table public.events (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  title text not null,
  description text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  status text not null default 'draft' check(status in ('draft','published','cancelled')),
  promotion_status public.promotion_status,
  created_at timestamptz not null default now()
);

create table public.menu_links (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  label text not null,
  url text not null,
  menu_type text not null default 'general',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.product_links (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid references public.venues(id) on delete cascade,
  bartender_id uuid references public.bartenders(id) on delete cascade,
  label text not null,
  url text not null,
  relationship text not null default 'organic' check(relationship in ('organic','affiliate','sponsored')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check(venue_id is not null or bartender_id is not null)
);

create table public.competitions (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  competition_type text not null,
  city text,
  state_region text,
  starts_at timestamptz,
  ends_at timestamptz,
  status text not null default 'draft' check(status in ('draft','nominations','voting','closed','published')),
  created_at timestamptz not null default now()
);

create table public.competition_entries (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  entity_kind public.entity_kind not null,
  bartender_id uuid references public.bartenders(id) on delete cascade,
  venue_id uuid references public.venues(id) on delete cascade,
  created_at timestamptz not null default now(),
  check ((entity_kind='bartender' and bartender_id is not null and venue_id is null) or (entity_kind='venue' and venue_id is not null and bartender_id is null))
);

create table public.awards (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  year integer,
  competition_id uuid references public.competitions(id) on delete set null,
  entity_kind public.entity_kind not null,
  bartender_id uuid references public.bartenders(id) on delete cascade,
  venue_id uuid references public.venues(id) on delete cascade,
  created_at timestamptz not null default now(),
  check ((entity_kind='bartender' and bartender_id is not null and venue_id is null) or (entity_kind='venue' and venue_id is not null and bartender_id is null))
);

-- RLS baseline
alter table public.profiles enable row level security;
alter table public.venues enable row level security;
alter table public.venue_external_refs enable row level security;
alter table public.bartenders enable row level security;
alter table public.bartender_venues enable row level security;
alter table public.bartender_aliases enable row level security;
alter table public.entity_claims enable row level security;
alter table public.bartender_permissions enable row level security;
alter table public.venue_permissions enable row level security;
alter table public.media_assets enable row level security;
alter table public.traits enable row level security;
alter table public.voices enable row level security;
alter table public.shoutouts enable row level security;
alter table public.shoutout_traits enable row level security;
alter table public.analytics_events enable row level security;
alter table public.events enable row level security;
alter table public.menu_links enable row level security;
alter table public.product_links enable row level security;
alter table public.competitions enable row level security;
alter table public.competition_entries enable row level security;
alter table public.awards enable row level security;

create policy "public venues" on public.venues for select using(status='active');
create policy "public bartenders" on public.bartenders for select using(status='active');
create policy "public bartender venues" on public.bartender_venues for select using(true);
create policy "public traits" on public.traits for select using(active);
create policy "public voices" on public.voices for select using(active);
create policy "public published shoutouts" on public.shoutouts for select using(status='published');
create policy "public shoutout traits" on public.shoutout_traits for select using(true);
create policy "public media" on public.media_assets for select using(status='published');
create policy "own profile" on public.profiles for select to authenticated using(auth.uid()=id);
create policy "update own profile" on public.profiles for update to authenticated using(auth.uid()=id) with check(auth.uid()=id);
create policy "create own shoutout" on public.shoutouts for insert to authenticated with check(auth.uid()=user_id);
create policy "create own shoutout traits" on public.shoutout_traits for insert to authenticated with check(exists(select 1 from public.shoutouts s where s.id=shoutout_id and s.user_id=auth.uid()));
create policy "own claims read" on public.entity_claims for select to authenticated using(claimant_user_id=auth.uid());
create policy "own claims create" on public.entity_claims for insert to authenticated with check(claimant_user_id=auth.uid());
create policy "bartender owner media insert" on public.media_assets for insert to authenticated with check(uploaded_by_user_id=auth.uid() and entity_kind='bartender' and exists(select 1 from public.bartender_permissions p where p.bartender_id=media_assets.bartender_id and p.user_id=auth.uid() and p.can_manage_media));
create policy "venue manager media insert" on public.media_assets for insert to authenticated with check(uploaded_by_user_id=auth.uid() and entity_kind='venue' and exists(select 1 from public.venue_permissions p where p.venue_id=media_assets.venue_id and p.user_id=auth.uid() and p.can_manage_media));

insert into public.traits(label,audience) values
('Makes everyone feel welcome','bartender'),('Great recommendations','bartender'),('Fast when it’s packed','bartender'),('Knows the classics','bartender'),('Creative drinks','bartender'),('Remembers regulars','bartender'),('Great energy','bartender'),('Cocktail knowledge','bartender'),('Beer knowledge','bartender'),('Whiskey knowledge','bartender'),('Friendly','bartender'),('Neighborhood favorite','bartender'),
('Great atmosphere','venue'),('Great staff','venue'),('Date-night favorite','venue'),('Live music','venue'),('Sports friendly','venue'),('Great cocktails','venue'),('Great beer selection','venue'),('Late-night favorite','venue'),('Hidden gem','venue'),('Great patio','venue');

insert into public.voices(name) values ('The Regular'),('Cocktail Fan'),('Game-Day Crowd'),('Vacation Mode'),('Local Favorite'),('Night-Out Crew');
