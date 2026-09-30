-- ============================================================
-- 058_event_all_day_semantics.sql
--
-- Preserve date-only / all-day event semantics independently
-- from timestamptz storage.
--
-- starts_at / ends_at remain the canonical ordering and
-- lifecycle timestamps. is_all_day tells consumers that the
-- UTC date components represent a calendar date and must not
-- be shifted through the viewer's timezone.
-- ============================================================

alter table public.events
  add column if not exists is_all_day boolean not null default false;

alter table public.event_harvest_candidates
  add column if not exists is_all_day boolean not null default false;


-- ============================================================
-- 1. HARVEST CANDIDATE UPSERT
-- ============================================================

drop function if exists public.upsert_event_harvest_candidate(
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
  timestamptz,
  timestamptz,
  uuid,
  numeric,
  text,
  jsonb
);

create or replace function public.upsert_event_harvest_candidate(
  p_source_id uuid,
  p_external_event_id text,
  p_source_url text,
  p_raw_title text,
  p_raw_venue_name text,
  p_raw_address text,
  p_raw_description text,
  p_raw_starts_at text,
  p_raw_ends_at text,
  p_normalized_title text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_venue_id uuid,
  p_confidence_score numeric,
  p_event_fingerprint text,
  p_raw_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate_id uuid;
  existing_status text;
  normalized_external_event_id text;
begin
  normalized_external_event_id :=
    trim(p_external_event_id);

  if p_source_id is null then
    raise exception 'Harvest source is required';
  end if;

  if not exists (
    select 1
    from public.event_harvest_sources s
    where s.id = p_source_id
      and s.is_enabled = true
  ) then
    raise exception 'Enabled harvest source not found';
  end if;

  if normalized_external_event_id is null
     or normalized_external_event_id = '' then
    raise exception 'External event ID is required';
  end if;

  if p_raw_title is null
     or trim(p_raw_title) = '' then
    raise exception 'Event title is required';
  end if;

  if p_venue_id is null
     or not exists (
       select 1
       from public.venues v
       where v.id = p_venue_id
     ) then
    raise exception 'Matched TenderFans Spot is required';
  end if;

  if p_starts_at is null then
    raise exception 'Normalized start time is required';
  end if;

  if p_ends_at is not null
     and p_ends_at <= p_starts_at then
    raise exception 'Event end must be after event start';
  end if;

  if p_confidence_score is not null
     and (
       p_confidence_score < 0
       or p_confidence_score > 1
     ) then
    raise exception 'Confidence score must be between 0 and 1';
  end if;

  if p_event_fingerprint is null
     or trim(p_event_fingerprint) = '' then
    raise exception 'Event fingerprint is required';
  end if;

  if exists (
    select 1
    from public.event_harvest_suppressions hs
    where hs.venue_id = p_venue_id
      and (
        hs.event_fingerprint = p_event_fingerprint
        or (
          hs.source_id = p_source_id
          and hs.external_event_id =
            normalized_external_event_id
        )
      )
  ) then
    return null;
  end if;

  select
    c.id,
    c.status
  into
    candidate_id,
    existing_status
  from public.event_harvest_candidates c
  where c.source_id = p_source_id
    and c.external_event_id =
      normalized_external_event_id
  for update;

  if candidate_id is not null then
    if existing_status in (
      'published',
      'ignored',
      'suppressed',
      'cancelled'
    ) then
      update public.event_harvest_candidates
      set
        is_all_day = coalesce(
          (p_raw_payload->>'isAllDay')::boolean,
          false
        ),
        last_seen_at = now(),
        last_verified_at = now(),
        raw_payload =
          coalesce(p_raw_payload, raw_payload),
        updated_at = now()
      where id = candidate_id;

      return candidate_id;
    end if;

    update public.event_harvest_candidates
    set
      source_url = p_source_url,
      raw_title = p_raw_title,
      raw_venue_name = p_raw_venue_name,
      raw_address = p_raw_address,
      raw_description = p_raw_description,
      raw_starts_at = p_raw_starts_at,
      raw_ends_at = p_raw_ends_at,
      normalized_title = p_normalized_title,
      starts_at = p_starts_at,
      ends_at = p_ends_at,
      venue_id = p_venue_id,
      confidence_score = p_confidence_score,
      event_fingerprint = p_event_fingerprint,
      is_all_day = coalesce(
          (p_raw_payload->>'isAllDay')::boolean,
          false
        ),
      status = 'matched',
      raw_payload =
        coalesce(p_raw_payload, '{}'::jsonb),
      last_seen_at = now(),
      last_verified_at = now(),
      updated_at = now()
    where id = candidate_id;

    return candidate_id;
  end if;

  insert into public.event_harvest_candidates (
    source_id,
    external_event_id,
    source_url,
    raw_title,
    raw_venue_name,
    raw_address,
    raw_description,
    raw_starts_at,
    raw_ends_at,
    normalized_title,
    starts_at,
    ends_at,
    venue_id,
    confidence_score,
    event_fingerprint,
    is_all_day,
    status,
    raw_payload,
    first_seen_at,
    last_seen_at,
    last_verified_at
  )
  values (
    p_source_id,
    normalized_external_event_id,
    p_source_url,
    p_raw_title,
    p_raw_venue_name,
    p_raw_address,
    p_raw_description,
    p_raw_starts_at,
    p_raw_ends_at,
    p_normalized_title,
    p_starts_at,
    p_ends_at,
    p_venue_id,
    p_confidence_score,
    p_event_fingerprint,
    coalesce(
      (p_raw_payload->>'isAllDay')::boolean,
      false
    ),
    'matched',
    coalesce(p_raw_payload, '{}'::jsonb),
    now(),
    now(),
    now()
  )
  returning id
  into candidate_id;

  return candidate_id;
end;
$$;

revoke all
on function public.upsert_event_harvest_candidate(
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
  timestamptz,
  timestamptz,
  uuid,
  numeric,
  text,
  jsonb
)
from public;

grant execute
on function public.upsert_event_harvest_candidate(
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
  timestamptz,
  timestamptz,
  uuid,
  numeric,
  text,
  jsonb
)
to service_role;


-- ============================================================
-- 2. FIRST-PARTY BOOTSTRAP
-- ============================================================

create or replace function public.bootstrap_first_party_harvest_candidate(
  p_candidate_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate_record public.event_harvest_candidates%rowtype;
  source_record public.event_harvest_sources%rowtype;
  created_event_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

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

  if candidate_record.canonical_event_id is not null then
    return candidate_record.canonical_event_id;
  end if;

  if candidate_record.status not in (
    'matched',
    'needs_review',
    'approved'
  ) then
    raise exception
      'Harvest candidate cannot be bootstrapped from status %',
      candidate_record.status;
  end if;

  if candidate_record.starts_at is null then
    raise exception
      'Harvest candidate has no normalized start time';
  end if;

  insert into public.events (
    venue_id,
    title,
    description,
    starts_at,
    ends_at,
    is_all_day,
    status,
    venue_approval_status,
    admin_approval_status,
    reviewed_by,
    reviewed_at,
    updated_at
  )
  values (
    candidate_record.venue_id,
    candidate_record.raw_title,
    candidate_record.raw_description,
    candidate_record.starts_at,
    candidate_record.ends_at,
    candidate_record.is_all_day,
    'published',
    'approved',
    'approved',
    null,
    null,
    now()
  )
  returning id
  into created_event_id;

  insert into public.event_source_links (
    event_id,
    source_id,
    candidate_id,
    external_event_id,
    source_url,
    first_seen_at,
    last_seen_at,
    last_verified_at
  )
  values (
    created_event_id,
    candidate_record.source_id,
    p_candidate_id,
    candidate_record.external_event_id,
    candidate_record.source_url,
    candidate_record.first_seen_at,
    candidate_record.last_seen_at,
    candidate_record.last_verified_at
  );

  update public.event_harvest_candidates
  set
    canonical_event_id = created_event_id,
    status = 'published',
    updated_at = now()
  where id = p_candidate_id;

  perform public.suppress_event_publication_notification(
    created_event_id,
    'initial_source_bootstrap'
  );

  return created_event_id;
end;
$$;

revoke all
on function public.bootstrap_first_party_harvest_candidate(uuid)
from public;

grant execute
on function public.bootstrap_first_party_harvest_candidate(uuid)
to service_role;


-- ============================================================
-- 3. FIRST-PARTY LIFECYCLE SYNC
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

  /*
   * Observation of the stable external identity clears any
   * previously accumulated disappearance state.
   */
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
    is_all_day = coalesce(
      (p_raw_payload->>'isAllDay')::boolean,
      false
    ),
    raw_payload = coalesce(
      p_raw_payload,
      raw_payload
    ),
    last_seen_at = now(),
    last_verified_at = now(),
    missing_since = null,
    consecutive_missing_scans = 0,
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
   * Ticketmaster-linked canonicals remain under Ticketmaster
   * authority. First-party synchronization only refreshes its
   * own candidate/provenance in that case.
   */
  if not has_ticketmaster_provenance then
    update public.events
    set
      title = trim(p_raw_title),
      description = p_raw_description,
      starts_at = p_starts_at,
      ends_at = p_ends_at,
      is_all_day = coalesce(
        (p_raw_payload->>'isAllDay')::boolean,
        false
      ),
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
   * If a first-party-controlled event was cancelled because it
   * disappeared and later reappears, publish_event restores the
   * same canonical event. Existing notification uniqueness means
   * this does not become another "new event" notification.
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


-- ============================================================
-- 4. TICKETMASTER ALL-DAY AUTHORITY
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
      is_all_day = false,
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
      is_all_day = false,
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
    is_all_day = false,
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
