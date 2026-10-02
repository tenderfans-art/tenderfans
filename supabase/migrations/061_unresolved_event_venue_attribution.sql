-- TenderFans Event Harvester:
-- unresolved publisher event venue attribution
--
-- A harvested event can identify a physical venue that cannot yet be
-- safely associated with a TenderFans Spot.
--
-- These records deliberately remain outside event_harvest_candidates
-- until venue attribution is resolved. This prevents the source Spot
-- from being used as false event ownership merely to satisfy the
-- candidate pipeline's required venue_id.
--
-- Existing event_harvest_venue_matches remains unchanged. That table
-- represents a known TenderFans Spot -> external provider venue match.
-- This table represents the inverse problem:
--
-- harvested event -> publisher venue -> unresolved TenderFans Spot.

create table public.event_harvest_unresolved_venues (
  id uuid primary key default gen_random_uuid(),

  source_id uuid not null
    references public.event_harvest_sources(id)
    on delete cascade,

  external_event_id text not null,
  source_url text,

  raw_title text not null,
  raw_starts_at text,
  raw_ends_at text,

  publisher_venue_name text not null,
  publisher_address text,
  publisher_city text,
  publisher_state_region text,
  publisher_postal_code text,

  suggested_venue_id uuid
    references public.venues(id)
    on delete set null,

  confidence_score numeric(5,4)
    check (
      confidence_score is null
      or (
        confidence_score >= 0
        and confidence_score <= 1
      )
    ),

  evidence jsonb not null default '{}'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb,

  status text not null default 'pending'
    check (
      status in (
        'pending',
        'resolved',
        'rejected'
      )
    ),

  resolved_venue_id uuid
    references public.venues(id)
    on delete set null,

  reviewed_by uuid
    references public.profiles(id)
    on delete set null,

  reviewed_at timestamptz,

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (
    source_id,
    external_event_id
  )
);

create index
  event_harvest_unresolved_venues_review_idx
on public.event_harvest_unresolved_venues (
  status,
  confidence_score desc,
  first_seen_at asc
);

create index
  event_harvest_unresolved_venues_source_idx
on public.event_harvest_unresolved_venues (
  source_id,
  last_seen_at desc
);


-- ============================================================
-- HARVESTER UPSERT
-- ============================================================

create or replace function
public.upsert_event_harvest_unresolved_venue(
  p_source_id uuid,
  p_external_event_id text,
  p_source_url text,
  p_raw_title text,
  p_raw_starts_at text,
  p_raw_ends_at text,
  p_publisher_venue_name text,
  p_publisher_address text,
  p_publisher_city text,
  p_publisher_state_region text,
  p_publisher_postal_code text,
  p_suggested_venue_id uuid default null,
  p_confidence_score numeric default null,
  p_evidence jsonb default '{}'::jsonb,
  p_raw_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_external_event_id text;
begin
  v_external_event_id :=
    trim(p_external_event_id);

  if not exists (
    select 1
    from public.event_harvest_sources s
    where s.id = p_source_id
      and s.is_enabled = true
  ) then
    raise exception
      'Enabled harvest source not found';
  end if;

  if v_external_event_id is null
     or v_external_event_id = '' then
    raise exception
      'External event ID is required';
  end if;

  if p_raw_title is null
     or trim(p_raw_title) = '' then
    raise exception
      'Event title is required';
  end if;

  if p_publisher_venue_name is null
     or trim(p_publisher_venue_name) = '' then
    raise exception
      'Publisher venue name is required';
  end if;

  if p_suggested_venue_id is not null
     and not exists (
       select 1
       from public.venues v
       where v.id = p_suggested_venue_id
     ) then
    raise exception
      'Suggested TenderFans Spot not found';
  end if;

  if p_confidence_score is not null
     and (
       p_confidence_score < 0
       or p_confidence_score > 1
     ) then
    raise exception
      'Confidence score must be between 0 and 1';
  end if;

  insert into
    public.event_harvest_unresolved_venues (
      source_id,
      external_event_id,
      source_url,
      raw_title,
      raw_starts_at,
      raw_ends_at,
      publisher_venue_name,
      publisher_address,
      publisher_city,
      publisher_state_region,
      publisher_postal_code,
      suggested_venue_id,
      confidence_score,
      evidence,
      raw_payload
    )
  values (
    p_source_id,
    v_external_event_id,
    nullif(trim(p_source_url), ''),
    trim(p_raw_title),
    nullif(trim(p_raw_starts_at), ''),
    nullif(trim(p_raw_ends_at), ''),
    trim(p_publisher_venue_name),
    nullif(trim(p_publisher_address), ''),
    nullif(trim(p_publisher_city), ''),
    nullif(trim(p_publisher_state_region), ''),
    nullif(trim(p_publisher_postal_code), ''),
    p_suggested_venue_id,
    p_confidence_score,
    coalesce(p_evidence, '{}'::jsonb),
    coalesce(p_raw_payload, '{}'::jsonb)
  )
  on conflict (
    source_id,
    external_event_id
  )
  do update set
    source_url =
      excluded.source_url,
    raw_title =
      excluded.raw_title,
    raw_starts_at =
      excluded.raw_starts_at,
    raw_ends_at =
      excluded.raw_ends_at,
    publisher_venue_name =
      excluded.publisher_venue_name,
    publisher_address =
      excluded.publisher_address,
    publisher_city =
      excluded.publisher_city,
    publisher_state_region =
      excluded.publisher_state_region,
    publisher_postal_code =
      excluded.publisher_postal_code,
    suggested_venue_id =
      excluded.suggested_venue_id,
    confidence_score =
      excluded.confidence_score,
    evidence =
      excluded.evidence,
    raw_payload =
      excluded.raw_payload,
    last_seen_at = now(),
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;


-- ============================================================
-- SECURITY
-- ============================================================

alter table
  public.event_harvest_unresolved_venues
enable row level security;

revoke all
on table public.event_harvest_unresolved_venues
from public, anon, authenticated;

revoke all
on function
public.upsert_event_harvest_unresolved_venue(
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  uuid,
  numeric,
  jsonb,
  jsonb
)
from public, anon, authenticated;

grant execute
on function
public.upsert_event_harvest_unresolved_venue(
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  uuid,
  numeric,
  jsonb,
  jsonb
)
to service_role;
