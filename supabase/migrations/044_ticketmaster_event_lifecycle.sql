-- ============================================================
-- TenderFans
-- Ticketmaster Authoritative Event Lifecycle
-- ============================================================
--
-- Ticketmaster remains authoritative for the complete lifecycle
-- of canonical events imported from the Ticketmaster Discovery API.
--
-- This migration:
--   1. Synchronizes published Ticketmaster candidates and their
--      canonical events when Ticketmaster changes event facts.
--   2. Cancels canonical events when Ticketmaster cancels them.
--   3. Temporarily removes postponed/TBD/TBA events from public
--      display without inventing a replacement date/time.
--   4. Allows the same canonical event to return to published when
--      Ticketmaster later supplies a definite start time.
--   5. Prevents Spot owners from editing Ticketmaster-controlled
--      canonical events.
--
-- Admin event management remains unchanged.
-- Generic Harvester behavior remains unchanged.
-- ============================================================


-- ============================================================
-- 1. TICKETMASTER AUTHORITATIVE LIFECYCLE SYNC
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
   * Do not copy provider descriptive text or imagery.
   */
  update public.events
  set
    title = trim(p_raw_title),
    starts_at = p_starts_at,
    ends_at = p_ends_at,
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


-- ============================================================
-- 2. PROTECT TICKETMASTER EVENTS FROM SPOT-OWNER EDITING
-- ============================================================

create or replace function public.spot_owner_update_event(
  p_event_id uuid,
  p_venue_id uuid,
  p_title text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_flyer_url text,
  p_flyer_storage_path text
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not exists (
    select 1
    from public.venue_permissions vp
    where vp.user_id = auth.uid()
      and vp.venue_id = p_venue_id
      and vp.can_edit = true
  ) then
    raise exception 'Spot management access required';
  end if;

  /*
   * Ticketmaster owns the lifecycle of events imported from its
   * Discovery API. Spot managers may manage the Spot, but may not
   * mutate the provider-controlled canonical event.
   */
  if exists (
    select 1
    from public.event_source_links esl
    join public.event_harvest_sources ehs
      on ehs.id = esl.source_id
    where esl.event_id = p_event_id
      and ehs.provider = 'ticketmaster'
      and ehs.external_source_id = 'discovery-v2'
  ) then
    raise exception
      'Ticketmaster-managed events cannot be edited by the Spot';
  end if;

  if trim(coalesce(p_title, '')) = '' then
    raise exception 'Event title is required';
  end if;

  if p_starts_at is null then
    raise exception 'Event start time is required';
  end if;

  if p_ends_at is not null
     and p_ends_at <= p_starts_at then
    raise exception 'End time must be after start time';
  end if;

  if trim(coalesce(p_flyer_url, '')) = ''
     or trim(coalesce(p_flyer_storage_path, '')) = '' then
    raise exception 'Event flyer is required';
  end if;

  update public.events e
  set
    title = trim(p_title),
    starts_at = p_starts_at,
    ends_at = p_ends_at,
    flyer_url = p_flyer_url,
    flyer_storage_path = p_flyer_storage_path,
    status = 'draft',
    venue_approval_status = 'approved',
    admin_approval_status = 'pending',
    reviewed_by = null,
    reviewed_at = null,
    updated_at = now()
  where e.id = p_event_id
    and e.venue_id = p_venue_id;

  if not found then
    raise exception 'Event not found for this Spot';
  end if;
end;
$function$;

revoke execute
on function public.spot_owner_update_event(
  uuid,
  uuid,
  text,
  timestamptz,
  timestamptz,
  text,
  text
)
from public, anon;

grant execute
on function public.spot_owner_update_event(
  uuid,
  uuid,
  text,
  timestamptz,
  timestamptz,
  text,
  text
)
to authenticated, service_role;
