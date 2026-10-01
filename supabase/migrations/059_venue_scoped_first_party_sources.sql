-- ============================================================
-- VENUE-SCOPED FIRST-PARTY SOURCE IDENTITY
--
-- Multiple TenderFans Spots may legitimately share the same
-- physical event infrastructure (hotel/resort calendars,
-- restaurant groups, entertainment complexes, etc.).
--
-- A first-party source registration therefore belongs to:
--
--   provider + venue_id + external_source_id
--
-- rather than globally to:
--
--   provider + external_source_id
--
-- Existing source rows are preserved in place. No source IDs,
-- bootstrap state, candidates, or harvest history are changed.
-- ============================================================

alter table public.event_harvest_sources
  drop constraint if exists
  event_harvest_sources_provider_external_source_id_key;

alter table public.event_harvest_sources
  add constraint event_harvest_sources_provider_venue_external_source_key
  unique (provider, venue_id, external_source_id);

-- Preserve global uniqueness for provider-level sources that do
-- not belong to a TenderFans Spot.
create unique index if not exists
  event_harvest_sources_global_external_source_uidx
on public.event_harvest_sources (
  provider,
  external_source_id
)
where venue_id is null;


create or replace function public.upsert_first_party_event_source(
  p_venue_id uuid,
  p_source_type text,
  p_name text,
  p_source_url text,
  p_external_source_id text,
  p_config jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  source_id uuid;
  normalized_source_type text;
  normalized_source_url text;
  normalized_external_source_id text;
begin
  normalized_source_type := lower(trim(p_source_type));
  normalized_source_url := trim(p_source_url);
  normalized_external_source_id :=
    trim(p_external_source_id);

  if p_venue_id is null
     or not exists (
       select 1
       from public.venues v
       where v.id = p_venue_id
         and v.status = 'active'
     ) then
    raise exception 'Active TenderFans Spot is required';
  end if;

  if normalized_source_type is null
     or normalized_source_type = '' then
    raise exception 'Source type is required';
  end if;

  if p_name is null
     or trim(p_name) = '' then
    raise exception 'Source name is required';
  end if;

  if normalized_source_url is null
     or normalized_source_url = '' then
    raise exception 'Source URL is required';
  end if;

  if normalized_external_source_id is null
     or normalized_external_source_id = '' then
    raise exception 'External source ID is required';
  end if;

  insert into public.event_harvest_sources (
    provider,
    source_type,
    name,
    source_url,
    external_source_id,
    venue_id,
    is_enabled,
    trust_level,
    config,
    created_at,
    updated_at
  )
  values (
    'first_party',
    normalized_source_type,
    trim(p_name),
    normalized_source_url,
    normalized_external_source_id,
    p_venue_id,
    true,
    'trusted',
    coalesce(p_config, '{}'::jsonb),
    now(),
    now()
  )
  on conflict (
    provider,
    venue_id,
    external_source_id
  )
  do update
  set
    source_type = excluded.source_type,
    name = excluded.name,
    source_url = excluded.source_url,
    is_enabled = true,
    trust_level = 'trusted',
    config = excluded.config,
    last_error = null,
    updated_at = now()
  returning id
  into source_id;

  return source_id;
end;
$$;

revoke all
on function public.upsert_first_party_event_source(
  uuid,
  text,
  text,
  text,
  text,
  jsonb
)
from public;

grant execute
on function public.upsert_first_party_event_source(
  uuid,
  text,
  text,
  text,
  text,
  jsonb
)
to service_role;
