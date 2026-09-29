-- ============================================================
-- 053_first_party_ticketmaster_authority.sql
--
-- Preserve Ticketmaster authority when a first-party source
-- shares the same canonical event.
--
-- First-party provenance/candidate state continues to refresh,
-- but a Ticketmaster-linked canonical event is not mutated or
-- republished by first-party synchronization.
-- ============================================================

create or replace function public.sync_first_party_event(
  p_candidate_id uuid,
  p_source_url text,
  p_raw_title text,
  p_raw_description text,
  p_raw_starts_at text,
  p_raw_ends_at text,
  p_normalized_title text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_event_fingerprint text,
  p_flyer_url text,
  p_raw_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate_record public.event_harvest_candidates%rowtype;
  source_record public.event_harvest_sources%rowtype;
  canonical_event_id uuid;
  has_ticketmaster_provenance boolean := false;
begin
  if p_candidate_id is null then
    raise exception 'Harvest candidate is required';
  end if;

  select c.*
  into candidate_record
  from public.event_harvest_candidates c
  where c.id = p_candidate_id
  for update;

  if not found then
    raise exception 'Harvest candidate not found';
  end if;

  select s.*
  into source_record
  from public.event_harvest_sources s
  where s.id = candidate_record.source_id
    and s.provider = 'first_party'
    and s.is_enabled = true
  for update;

  if not found then
    raise exception 'Enabled first-party harvest source not found';
  end if;

  if source_record.venue_id is null
     or candidate_record.venue_id <> source_record.venue_id then
    raise exception 'First-party source is not bound to candidate Spot';
  end if;

  if candidate_record.canonical_event_id is null then
    raise exception 'First-party candidate has no canonical event';
  end if;

  canonical_event_id := candidate_record.canonical_event_id;

  perform 1
  from public.events e
  where e.id = canonical_event_id
    and e.venue_id = source_record.venue_id
  for update;

  if not found then
    raise exception 'Canonical first-party event not found';
  end if;

  select exists (
    select 1
    from public.event_source_links esl
    join public.event_harvest_sources hs
      on hs.id = esl.source_id
    where esl.event_id = canonical_event_id
      and hs.provider = 'ticketmaster'
  )
  into has_ticketmaster_provenance;

  if p_raw_title is null
     or trim(p_raw_title) = '' then
    raise exception 'First-party event title is required';
  end if;

  if p_starts_at is null then
    raise exception 'First-party event start time is required';
  end if;

  if p_ends_at is not null
     and p_ends_at <= p_starts_at then
    raise exception 'Event end must be after event start';
  end if;

  update public.event_harvest_candidates
  set
    source_url = p_source_url,
    raw_title = trim(p_raw_title),
    raw_description = p_raw_description,
    raw_starts_at = p_raw_starts_at,
    raw_ends_at = p_raw_ends_at,
    normalized_title = coalesce(
      nullif(trim(p_normalized_title), ''),
      normalized_title
    ),
    starts_at = p_starts_at,
    ends_at = p_ends_at,
    event_fingerprint = coalesce(
      nullif(trim(p_event_fingerprint), ''),
      event_fingerprint
    ),
    raw_payload = coalesce(
      p_raw_payload,
      raw_payload
    ),
    last_seen_at = now(),
    last_verified_at = now(),
    updated_at = now()
  where id = p_candidate_id;

  update public.event_source_links
  set
    source_url = p_source_url,
    last_seen_at = now(),
    last_verified_at = now(),
    updated_at = now()
  where candidate_id = p_candidate_id
    and event_id = canonical_event_id;

  /*
   * The official Spot source is authoritative for factual event
   * content unless the canonical event has Ticketmaster provenance.
   *
   * Ticketmaster-linked canonical events remain under Ticketmaster
   * authority; first-party synchronization refreshes only its own
   * candidate and source-link provenance.
   *
   * Missing artwork does not erase previously known artwork.
   * No Storage path is created for remote first-party artwork.
   */
  if not has_ticketmaster_provenance then
    update public.events
    set
      title = trim(p_raw_title),
      description = p_raw_description,
      starts_at = p_starts_at,
      ends_at = p_ends_at,
      flyer_url = coalesce(
        nullif(trim(p_flyer_url), ''),
        flyer_url
      ),
      venue_approval_status = 'approved',
      admin_approval_status = 'approved',
      updated_at = now()
    where id = canonical_event_id;
  end if;

  update public.event_harvest_candidates
  set
    status = 'published',
    updated_at = now()
  where id = p_candidate_id;

  /*
   * Publish first-party-controlled canonical events idempotently.
   * Ticketmaster-linked events are not republished here because
   * Ticketmaster owns their canonical lifecycle.
   */
  if not has_ticketmaster_provenance then
    perform public.publish_event(
      canonical_event_id,
      null
    );
  end if;

  return canonical_event_id;
end;
$$;

revoke all
on function public.sync_first_party_event(
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  timestamptz,
  text,
  text,
  jsonb
)
from public;

grant execute
on function public.sync_first_party_event(
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  timestamptz,
  text,
  text,
  jsonb
)
to service_role;
