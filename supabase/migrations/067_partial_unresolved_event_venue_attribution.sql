-- ============================================================
-- PARTIAL UNRESOLVED EVENT VENUE ATTRIBUTION
--
-- Shared publisher sources such as Facebook may identify an
-- event without supplying a complete physical venue identity.
--
-- Preserve those events for Admin review without manufacturing
-- a publisher venue name. Complete structured venue evidence
-- remains required for automatic venue matching.
-- ============================================================

alter table public.event_harvest_unresolved_venues
  alter column publisher_venue_name drop not null;


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
  v_external_event_id := trim(p_external_event_id);

  if not exists (
    select 1
    from public.event_harvest_sources s
    where s.id = p_source_id
      and s.is_enabled = true
  ) then
    raise exception 'Enabled harvest source not found';
  end if;

  if v_external_event_id is null
     or v_external_event_id = '' then
    raise exception 'External event ID is required';
  end if;

  if p_raw_title is null
     or trim(p_raw_title) = '' then
    raise exception 'Event title is required';
  end if;

  if p_suggested_venue_id is not null
     and not exists (
       select 1
       from public.venues v
       where v.id = p_suggested_venue_id
     ) then
    raise exception 'Suggested TenderFans Spot not found';
  end if;

  if p_confidence_score is not null
     and (
       p_confidence_score < 0
       or p_confidence_score > 1
     ) then
    raise exception 'Confidence score must be between 0 and 1';
  end if;

  insert into public.event_harvest_unresolved_venues (
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
    nullif(trim(p_publisher_venue_name), ''),
    nullif(trim(p_publisher_address), ''),
    nullif(trim(p_publisher_city), ''),
    nullif(trim(p_publisher_state_region), ''),
    nullif(trim(p_publisher_postal_code), ''),
    p_suggested_venue_id,
    p_confidence_score,
    coalesce(p_evidence, '{}'::jsonb),
    coalesce(p_raw_payload, '{}'::jsonb)
  )
  on conflict (source_id, external_event_id)
  do update set
    source_url = excluded.source_url,
    raw_title = excluded.raw_title,
    raw_starts_at = excluded.raw_starts_at,
    raw_ends_at = excluded.raw_ends_at,
    publisher_venue_name = excluded.publisher_venue_name,
    publisher_address = excluded.publisher_address,
    publisher_city = excluded.publisher_city,
    publisher_state_region = excluded.publisher_state_region,
    publisher_postal_code = excluded.publisher_postal_code,
    suggested_venue_id = excluded.suggested_venue_id,
    confidence_score = excluded.confidence_score,
    evidence = excluded.evidence,
    raw_payload = excluded.raw_payload,
    last_seen_at = now(),
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

revoke all
on function public.upsert_event_harvest_unresolved_venue(
  uuid, text, text, text, text, text, text, text, text, text,
  text, uuid, numeric, jsonb, jsonb
)
from public, anon, authenticated;

grant execute
on function public.upsert_event_harvest_unresolved_venue(
  uuid, text, text, text, text, text, text, text, text, text,
  text, uuid, numeric, jsonb, jsonb
)
to service_role;
