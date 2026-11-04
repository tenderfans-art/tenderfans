-- 106: Geographic ownership for newly onboarded Spots.
--
-- Existing Spot memberships remain authoritative.
-- The Workflow Isolation Test Market is not changed.
-- No new Spot may enter through these Google intake paths
-- without a Market assignment.
--
-- A Market may cover multiple configured counties.
-- A county may belong to only one geographic Market.

begin;

create table public.event_processing_market_counties (
  country_code text not null default 'US'
    check (country_code ~ '^[A-Z]{2}$'),
  state_region text not null
    check (state_region ~ '^[A-Z]{2}$'),
  county_key text not null
    check (
      county_key = lower(trim(county_key))
      and length(county_key) between 3 and 100
    ),
  market_id uuid not null
    references public.event_processing_markets(id)
    on delete restrict,
  created_at timestamptz not null default now(),
  primary key (country_code, state_region, county_key)
);

create index event_processing_market_counties_market_idx
on public.event_processing_market_counties(market_id);

alter table public.event_processing_market_counties
  enable row level security;

revoke all on public.event_processing_market_counties
from public, anon, authenticated;

grant select, insert, update, delete
on public.event_processing_market_counties
to service_role;

-- Configure the inaugural geographic Market.
-- Do not configure the separate isolation-test Market.
do $$
declare
  v_market_id uuid;
begin
  select id into v_market_id
  from public.event_processing_markets
  where market_key = 'pinellas-county'
    and display_name = 'Pinellas County';

  if v_market_id is null then
    raise exception
      'Migration 106: Pinellas County Market not found';
  end if;

  insert into public.event_processing_market_counties (
    country_code, state_region, county_key, market_id
  )
  values (
    'US', 'FL', 'pinellas county', v_market_id
  );
end;
$$;

-- Create a Market and its first county in one transaction.
create function public.create_market_with_county(
  p_name text,
  p_key text,
  p_country_code text,
  p_state_region text,
  p_county_name text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_market_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  if nullif(trim(p_name), '') is null
     or nullif(trim(p_key), '') is null
     or nullif(trim(p_county_name), '') is null then
    raise exception 'Market identity and county are required';
  end if;

  insert into public.event_processing_markets (
    market_key,
    display_name,
    is_enabled
  )
  values (
    trim(p_key),
    trim(p_name),
    false
  )
  returning id into v_market_id;

  insert into public.event_processing_market_counties (
    country_code,
    state_region,
    county_key,
    market_id
  )
  values (
    upper(trim(p_country_code)),
    upper(trim(p_state_region)),
    lower(trim(p_county_name)),
    v_market_id
  );

  return v_market_id;
end;
$$;

revoke all on function public.create_market_with_county(
  text, text, text, text, text
) from public, anon, authenticated;

grant execute on function public.create_market_with_county(
  text, text, text, text, text
) to service_role;

-- Atomic Google upsert and Market assignment.
-- An assignment conflict rolls back the entire Spot upsert.
-- Existing Google review decisions cannot be bypassed.
create function public.upsert_google_venue_in_market(
  p_place_id text,
  p_name text,
  p_street_address text,
  p_city text,
  p_state_region text,
  p_postal_code text,
  p_latitude double precision,
  p_longitude double precision,
  p_public_phone text,
  p_website_url text,
  p_regular_hours jsonb,
  p_market_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_venue_id uuid;
  v_requested_market uuid;
  v_review_status text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  if p_market_id is null then
    raise exception 'Market assignment is required';
  end if;

  select status into v_review_status
  from public.event_harvest_google_spot_reviews
  where place_id = p_place_id
  for update;

  if v_review_status = 'rejected' then
    raise exception 'Google Spot was rejected in Spot Review';
  end if;

  if v_review_status = 'pending' then
    raise exception 'Google Spot requires existing Admin Spot Review';
  end if;

  select market_id into v_requested_market
  from public.event_google_spot_market_requests
  where place_id = p_place_id
  for update;

  if v_requested_market is not null
     and v_requested_market <> p_market_id then
    raise exception 'Google Place already requested for another market';
  end if;

  v_venue_id := public.upsert_google_venue(
    p_place_id,
    p_name,
    p_street_address,
    p_city,
    p_state_region,
    p_postal_code,
    p_latitude,
    p_longitude,
    p_public_phone,
    p_website_url,
    p_regular_hours
  );

  perform public.assign_spot_to_market_internal(
    v_venue_id,
    p_market_id
  );

  return v_venue_id;
end;
$$;

revoke all on function public.upsert_google_venue_in_market(
  text, text, text, text, text, text,
  double precision, double precision,
  text, text, jsonb, uuid
) from public, anon, authenticated;

grant execute on function public.upsert_google_venue_in_market(
  text, text, text, text, text, text,
  double precision, double precision,
  text, text, jsonb, uuid
) to service_role;

commit;
