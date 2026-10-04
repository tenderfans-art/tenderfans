-- ============================================================
-- 068_global_first_party_event_sources.sql
--
-- Register shared/global first-party publisher sources.
--
-- Unlike Spot-scoped first-party sources, these sources have
-- venue_id = NULL. Events harvested from them must resolve their
-- physical TenderFans Spot through event-level attribution.
--
-- Initially restricted to the Facebook Events adapter.
-- ============================================================

create or replace function public.upsert_global_first_party_event_source(
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
  normalized_external_source_id := trim(p_external_source_id);

  if normalized_source_type <> 'facebook_events' then
    raise exception
      'Global first-party source type is not supported: %',
      normalized_source_type;
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
    null,
    true,
    'trusted',
    coalesce(p_config, '{}'::jsonb),
    now(),
    now()
  )
  on conflict (
    provider,
    external_source_id
  )
  where venue_id is null
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
on function public.upsert_global_first_party_event_source(
  text,
  text,
  text,
  text,
  jsonb
)
from public;

grant execute
on function public.upsert_global_first_party_event_source(
  text,
  text,
  text,
  text,
  jsonb
)
to service_role;
