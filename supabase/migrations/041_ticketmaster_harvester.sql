-- TenderFans Ticketmaster Event Harvester support
--
-- Spot-first architecture:
--   * Ticketmaster may attach to an EXISTING TenderFans Spot.
--   * Ticketmaster never creates a TenderFans Spot.
--   * External event candidates are staged before publication.
--   * Suppressed events are not resurrected.
--   * High-confidence candidates can use the existing
--     graduate_harvest_candidate() publication path.
--
-- HTTP/API calls and confidence calculation remain application/job concerns.


-- ============================================================
-- 1. MAKE VENUE EXTERNAL PROVIDERS EXTENSIBLE
-- ============================================================

alter table public.venue_external_refs
  drop constraint if exists venue_external_refs_provider_check;

alter table public.venue_external_refs
  add constraint venue_external_refs_provider_check
  check (
    provider = lower(provider)
    and provider ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
  );

alter table public.event_harvest_candidates
  add column if not exists event_fingerprint text;

create index if not exists
  event_harvest_candidates_fingerprint_idx
on public.event_harvest_candidates (
  venue_id,
  event_fingerprint
)
where event_fingerprint is not null;


-- ============================================================
-- 2. ATTACH EXTERNAL IDENTITY TO AN EXISTING SPOT
-- ============================================================

create or replace function public.set_venue_external_ref(
  p_venue_id uuid,
  p_provider text,
  p_provider_place_id text,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_provider text;
  normalized_place_id text;
begin
  normalized_provider :=
    lower(trim(p_provider));

  normalized_place_id :=
    trim(p_provider_place_id);

  if normalized_provider is null
     or normalized_provider = '' then
    raise exception 'Provider is required';
  end if;

  if normalized_provider !~
     '^[a-z0-9][a-z0-9_-]{0,63}$' then
    raise exception 'Invalid provider identifier';
  end if;

  if normalized_place_id is null
     or normalized_place_id = '' then
    raise exception 'Provider place ID is required';
  end if;

  if not exists (
    select 1
    from public.venues v
    where v.id = p_venue_id
  ) then
    raise exception 'TenderFans Spot not found';
  end if;

  if exists (
    select 1
    from public.venue_external_refs r
    where r.provider = normalized_provider
      and r.provider_place_id = normalized_place_id
      and r.venue_id <> p_venue_id
  ) then
    raise exception
      'External venue identity is already attached to another TenderFans Spot';
  end if;

  /*
   * A provider identity may belong to only one TenderFans Spot.
   * The table's primary key(provider, provider_place_id) enforces
   * that globally, while unique(venue_id, provider) allows one
   * identity from each provider per Spot.
   */
  insert into public.venue_external_refs (
    venue_id,
    provider,
    provider_place_id,
    metadata
  )
  values (
    p_venue_id,
    normalized_provider,
    normalized_place_id,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (venue_id, provider)
  do update set
    provider_place_id =
      excluded.provider_place_id,
    metadata =
      excluded.metadata;
end;
$$;


-- ============================================================
-- 3. UPSERT A HARVEST CANDIDATE FROM A TRUSTED SERVER JOB
-- ============================================================

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

  /*
   * Owner/Admin suppression outranks the Harvester.
   * Do not recreate a candidate that has been explicitly suppressed.
   */
  if exists (
    select 1
    from public.event_harvest_suppressions hs
    where hs.venue_id = p_venue_id
      and (
        hs.event_fingerprint =
          p_event_fingerprint

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
    /*
     * Never let a re-harvest overwrite a terminal human decision
     * or a canonical event that has already been published.
     */
    if existing_status in (
      'published',
      'ignored',
      'suppressed',
      'cancelled'
    ) then
      update public.event_harvest_candidates
      set
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


-- ============================================================
-- 4. MARK A CANDIDATE FOR ADMIN REVIEW
-- ============================================================

create or replace function public.mark_harvest_candidate_for_review(
  p_candidate_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.event_harvest_candidates
  set
    status = 'needs_review',
    updated_at = now()
  where id = p_candidate_id
    and status = 'matched';

  if not found then
    raise exception
      'Matched harvest candidate not found';
  end if;
end;
$$;


-- ============================================================
-- 5. SUPPRESS A HARVESTED EVENT
-- ============================================================

create or replace function public.suppress_harvest_candidate(
  p_candidate_id uuid,
  p_event_fingerprint text,
  p_reason text default null,
  p_suppressed_by uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate_record
    public.event_harvest_candidates%rowtype;
begin
  select *
  into candidate_record
  from public.event_harvest_candidates
  where id = p_candidate_id
  for update;

  if not found then
    raise exception 'Harvest candidate not found';
  end if;

  if candidate_record.venue_id is null then
    raise exception
      'Harvest candidate has no matched Spot';
  end if;

  if p_event_fingerprint is null
     or trim(p_event_fingerprint) = '' then
    raise exception 'Event fingerprint is required';
  end if;

  if candidate_record.event_fingerprint is null
     or candidate_record.event_fingerprint <> trim(p_event_fingerprint) then
    raise exception
      'Event fingerprint does not match harvest candidate';
  end if;

  insert into public.event_harvest_suppressions (
    venue_id,
    source_id,
    external_event_id,
    event_fingerprint,
    reason,
    suppressed_by
  )
  values (
    candidate_record.venue_id,
    candidate_record.source_id,
    candidate_record.external_event_id,
    trim(p_event_fingerprint),
    p_reason,
    p_suppressed_by
  )
  on conflict (venue_id, event_fingerprint)
  do update set
    reason = coalesce(
      excluded.reason,
      public.event_harvest_suppressions.reason
    ),
    suppressed_by = coalesce(
      excluded.suppressed_by,
      public.event_harvest_suppressions.suppressed_by
    );

  update public.event_harvest_candidates
  set
    status = 'suppressed',
    updated_at = now()
  where id = p_candidate_id;
end;
$$;


-- ============================================================
-- 6. SECURITY
-- ============================================================

/*
 * These functions are infrastructure primitives.
 * Browser clients must not call them directly.
 *
 * The future Event Harvester job will use the server-side
 * Supabase secret client, matching the existing notification job.
 */

revoke all on function public.set_venue_external_ref(
  uuid,
  text,
  text,
  jsonb
) from public;

revoke all on function public.upsert_event_harvest_candidate(
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
) from public;

revoke all on function public.mark_harvest_candidate_for_review(
  uuid
) from public;

revoke all on function public.suppress_harvest_candidate(
  uuid,
  text,
  text,
  uuid
) from public;

-- ============================================================
-- 7. SERVER-SIDE HARVESTER EXECUTION
-- ============================================================

grant execute on function public.set_venue_external_ref(
  uuid,
  text,
  text,
  jsonb
) to service_role;

grant execute on function public.upsert_event_harvest_candidate(
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
) to service_role;

grant execute on function public.mark_harvest_candidate_for_review(
  uuid
) to service_role;

grant execute on function public.suppress_harvest_candidate(
  uuid,
  text,
  text,
  uuid
) to service_role;

grant execute on function public.graduate_harvest_candidate(
  uuid,
  uuid
) to service_role;
