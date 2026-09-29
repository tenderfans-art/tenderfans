-- Ticketmaster event artwork integration.
--
-- Ticketmaster-hosted event artwork populates the existing
-- canonical events.flyer_url field.
--
-- No Supabase Storage object is created. flyer_storage_path
-- remains unchanged. Missing Ticketmaster artwork never clears
-- an existing flyer URL.

create or replace function public.sync_ticketmaster_event(
  p_candidate_id uuid,
  p_source_url text,
  p_raw_title text,
  p_raw_venue_name text,
  p_raw_address text,
  p_raw_starts_at text,
  p_raw_ends_at text,
  p_normalized_title text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_event_fingerprint text,
  p_ticketmaster_status text,
  p_has_definite_start boolean,
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
  canonical_event_id uuid;
  normalized_provider_status text;
begin
  if p_candidate_id is null then
    raise exception 'Harvest candidate is required';
  end if;

  select c.*
  into candidate_record
  from public.event_harvest_candidates c
  join public.event_harvest_sources s
    on s.id = c.source_id
  where c.id = p_candidate_id
    and s.provider = 'ticketmaster'
    and s.external_source_id = 'discovery-v2'
    and s.is_enabled = true
  for update of c;

  if not found then
    raise exception 'Enabled Ticketmaster harvest candidate not found';
  end if;

  if candidate_record.canonical_event_id is null then
    raise exception 'Ticketmaster candidate has no canonical event';
  end if;

  canonical_event_id :=
    candidate_record.canonical_event_id;

  perform 1
  from public.events e
  where e.id = canonical_event_id
    and e.venue_id = candidate_record.venue_id
  for update;

  if not found then
    raise exception 'Canonical Ticketmaster event not found';
  end if;

  normalized_provider_status :=
    lower(trim(coalesce(p_ticketmaster_status, '')));

  if p_ends_at is not null
     and p_starts_at is not null
     and p_ends_at <= p_starts_at then
    raise exception 'Event end must be after event start';
  end if;

  /*
   * A Ticketmaster external event ID is the lifecycle identity.
   * Title/time changes do not create a new TenderFans event.
   *
   * The fingerprint is allowed to change as factual event
   * information changes.
   */
  update public.event_harvest_candidates
  set
    source_url = p_source_url,
    raw_title = coalesce(
      nullif(trim(p_raw_title), ''),
      raw_title
    ),
    raw_venue_name = p_raw_venue_name,
    raw_address = p_raw_address,
    raw_description = null,
    raw_starts_at = p_raw_starts_at,
    raw_ends_at = p_raw_ends_at,
    normalized_title = coalesce(
      nullif(trim(p_normalized_title), ''),
      normalized_title
    ),
    starts_at = case
      when p_has_definite_start
        then p_starts_at
      else starts_at
    end,
    ends_at = case
      when p_has_definite_start
        then p_ends_at
      else ends_at
    end,
    event_fingerprint = case
      when nullif(trim(p_event_fingerprint), '') is not null
        then p_event_fingerprint
      else event_fingerprint
    end,
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
   * Explicit Ticketmaster cancellation is authoritative.
   */
  if normalized_provider_status = 'cancelled' then
    update public.events
    set
      status = 'cancelled',
      venue_approval_status = 'approved',
      admin_approval_status = 'approved',
      updated_at = now()
    where id = canonical_event_id;

    update public.event_harvest_candidates
    set
      status = 'cancelled',
      updated_at = now()
    where id = p_candidate_id;

    return canonical_event_id;
  end if;

  /*
   * Ticketmaster may postpone an event or mark its date/time
   * TBD/TBA before a replacement instant exists.
   *
   * Preserve the last known time internally, but remove the
   * canonical event from public display rather than showing
   * stale information or inventing a new time.
   *
   * Approval remains approved because this is not an Admin
   * review state.
   */
  if not coalesce(p_has_definite_start, false) then
    update public.events
    set
      status = 'draft',
      venue_approval_status = 'approved',
      admin_approval_status = 'approved',
      updated_at = now()
    where id = canonical_event_id;

    update public.event_harvest_candidates
    set
      status = 'stale',
      updated_at = now()
    where id = p_candidate_id;

    return canonical_event_id;
  end if;

  if p_starts_at is null then
    raise exception 'Definite Ticketmaster event requires start time';
  end if;

  if p_raw_title is null
     or trim(p_raw_title) = '' then
    raise exception 'Ticketmaster event title is required';
  end if;

  /*
   * Ticketmaster remains authoritative for mutable factual fields.
   * Provider descriptive text is not copied.
   *
   * A usable Ticketmaster image populates the existing event
   * flyer_url. Missing provider artwork does not erase an
   * existing flyer.
   */
  update public.events
  set
    title = trim(p_raw_title),
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

  update public.event_harvest_candidates
  set
    status = 'published',
    updated_at = now()
  where id = p_candidate_id;

  /*
   * Handles:
   *   draft      -> published
   *   cancelled  -> published
   *   published  -> published (idempotent)
   *
   * Existing notification uniqueness prevents a second
   * "new event" Follow activity for the same canonical event.
   */
  perform public.publish_event(
    canonical_event_id,
    null
  );

  return canonical_event_id;
end;
$$;

revoke all
on function public.sync_ticketmaster_event(
  uuid,
  text,
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
  boolean,
  text,
  jsonb
)
from public;

grant execute
on function public.sync_ticketmaster_event(
  uuid,
  text,
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
  boolean,
  text,
  jsonb
)
to service_role;

-- ============================================================
-- COMPATIBILITY WRAPPER FOR PRE-045 CALLERS
-- ============================================================

create or replace function public.sync_ticketmaster_event(
  p_candidate_id uuid,
  p_source_url text,
  p_raw_title text,
  p_raw_venue_name text,
  p_raw_address text,
  p_raw_starts_at text,
  p_raw_ends_at text,
  p_normalized_title text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_event_fingerprint text,
  p_ticketmaster_status text,
  p_has_definite_start boolean,
  p_raw_payload jsonb default '{}'::jsonb
)
returns uuid
language sql
security definer
set search_path = public
as $$
  select public.sync_ticketmaster_event(
    p_candidate_id,
    p_source_url,
    p_raw_title,
    p_raw_venue_name,
    p_raw_address,
    p_raw_starts_at,
    p_raw_ends_at,
    p_normalized_title,
    p_starts_at,
    p_ends_at,
    p_event_fingerprint,
    p_ticketmaster_status,
    p_has_definite_start,
    null::text,
    p_raw_payload
  );
$$;

revoke all
on function public.sync_ticketmaster_event(
  uuid,
  text,
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
  boolean,
  jsonb
)
from public;

grant execute
on function public.sync_ticketmaster_event(
  uuid,
  text,
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
  boolean,
  jsonb
)
to service_role;
