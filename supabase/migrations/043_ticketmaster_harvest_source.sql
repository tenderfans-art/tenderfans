-- TenderFans Event Harvester
-- Register Ticketmaster Discovery API as an approved harvest source.

insert into public.event_harvest_sources (
  provider,
  source_type,
  name,
  source_url,
  external_source_id,
  is_enabled,
  trust_level,
  config
)
values (
  'ticketmaster',
  'api',
  'Ticketmaster Discovery API',
  'https://app.ticketmaster.com/discovery/v2/',
  'discovery-v2',
  true,
  'standard',
  jsonb_build_object(
    'event_endpoint', 'events.json',
    'venue_endpoint', 'venues.json',
    'spot_first', true
  )
)
on conflict (provider, external_source_id)
do update set
  source_type = excluded.source_type,
  name = excluded.name,
  source_url = excluded.source_url,
  is_enabled = excluded.is_enabled,
  trust_level = excluded.trust_level,
  config = excluded.config,
  updated_at = now();
