create schema auth;
create function auth.role() returns text language sql as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'service_role')::text
$$;
create table public.venues(id uuid primary key);
create table public.event_harvest_sources(id uuid primary key);
create table public.event_processing_market_cycles(
  id uuid primary key, market_id uuid not null, status text default 'running',
  started_at timestamptz default now(), finished_at timestamptz,
  peak_active_sources integer default 0, peak_active_workflows integer default 0,
  last_observed_at timestamptz
);
