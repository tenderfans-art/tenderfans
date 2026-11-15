create schema auth;
create function auth.role() returns text language sql as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'service_role')::text
$$;
create table public.venues(id uuid primary key, status text default 'active', website_url text default 'https://publisher.example');
create table public.event_harvest_sources(
  id uuid primary key,provider text default 'first_party',source_type text default 'ics',
  venue_id uuid references public.venues(id),is_enabled boolean default true,external_source_id text
);
create table public.event_harvest_archive(venue_id uuid references public.venues(id),restored_at timestamptz,next_check_at timestamptz);
create table public.first_party_source_executions(source_id uuid primary key references public.event_harvest_sources(id));
