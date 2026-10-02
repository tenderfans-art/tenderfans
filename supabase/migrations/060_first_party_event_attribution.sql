-- ============================================================
-- 060_first_party_event_attribution.sql
--
-- Allow a first-party discovery source to contain events belonging
-- to a different, independently attributed TenderFans Spot.
--
-- Source identity remains provenance/discovery identity.
-- Candidate venue_id remains canonical event venue identity.
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

  if candidate_record.venue_id is null
     or not exists (
       select 1
       from public.venues v
       where v.id = candidate_record.venue_id
     ) then
    raise exception 'First-party candidate has no valid attributed Spot';
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

  if candidate_record.venue_id is null
     or not exists (
       select 1
       from public.venues v
       where v.id = candidate_record.venue_id
     ) then
    raise exception 'First-party candidate has no valid attributed Spot';
  end if;

  if candidate_record.canonical_event_id is null then
    raise exception 'First-party candidate has no canonical event';
  end if;

  canonical_event_id := candidate_record.canonical_event_id;

  perform 1
  from public.events e
  where e.id = canonical_event_id
    and e.venue_id = candidate_record.venue_id
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

create or replace function public.reconcile_first_party_source_absences(
  p_source_id uuid,
  p_scan_started_at timestamptz
)
returns table (
  missing_candidates integer,
  newly_cancelled integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  source_record public.event_harvest_sources%rowtype;
  missing_count integer := 0;
  cancelled_count integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  if p_source_id is null then
    raise exception 'First-party source is required';
  end if;

  if p_scan_started_at is null then
    raise exception 'Scan start time is required';
  end if;

  select s.*
  into source_record
  from public.event_harvest_sources s
  where s.id = p_source_id
    and s.provider = 'first_party'
    and s.is_enabled = true
  for update;

  if not found then
    raise exception 'Enabled first-party harvest source not found';
  end if;

  /*
   * Candidates observed during this scan have last_seen_at at or
   * after p_scan_started_at. Clear any previous absence state.
   */
  update public.event_harvest_candidates c
  set
    missing_since = null,
    consecutive_missing_scans = 0,
    updated_at = now()
  where c.source_id = p_source_id
    and c.last_seen_at >= p_scan_started_at
    and (
      c.missing_since is not null
      or c.consecutive_missing_scans <> 0
    );

  /*
   * Anything linked to a canonical event but not observed during
   * this successful full scan records another consecutive absence.
   *
   * We deliberately retain the candidate's existing lifecycle
   * status on the first absence.
   */
  update public.event_harvest_candidates c
  set
    missing_since = coalesce(c.missing_since, now()),
    consecutive_missing_scans =
      c.consecutive_missing_scans + 1,
    updated_at = now()
  where c.source_id = p_source_id
    and c.canonical_event_id is not null
    and c.last_seen_at < p_scan_started_at;

  get diagnostics missing_count = row_count;

  /*
   * After two consecutive successful absences, cancel only:
   *
   *   * future events,
   *   * whose canonical lifecycle is first-party-controlled,
   *   * and which still belong to this source's Spot.
   *
   * Ticketmaster provenance always wins. Its canonical event is
   * never cancelled because a first-party feed stopped listing it.
   */
  with eligible as (
    select
      c.id as candidate_id,
      c.canonical_event_id
    from public.event_harvest_candidates c
    join public.events e
      on e.id = c.canonical_event_id
    where c.source_id = p_source_id
      and c.consecutive_missing_scans >= 2
      and c.starts_at > now()
      and e.venue_id = c.venue_id
      and e.status <> 'cancelled'
      and not exists (
        select 1
        from public.event_source_links esl
        join public.event_harvest_sources hs
          on hs.id = esl.source_id
        where esl.event_id = c.canonical_event_id
          and hs.provider = 'ticketmaster'
      )
    for update of c, e
  ),
  cancelled_events as (
    update public.events e
    set
      status = 'cancelled',
      updated_at = now()
    from eligible x
    where e.id = x.canonical_event_id
    returning x.candidate_id
  )
  update public.event_harvest_candidates c
  set
    status = 'cancelled',
    updated_at = now()
  from cancelled_events x
  where c.id = x.candidate_id;

  get diagnostics cancelled_count = row_count;

  return query
  select missing_count, cancelled_count;
end;
$$;
