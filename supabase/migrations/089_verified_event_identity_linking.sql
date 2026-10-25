-- 089_verified_event_identity_linking.sql
--
-- Correct the existing cross-source identity and occurrence-review
-- lifecycle. No Spot-specific identities or URLs.
--
-- Preserve exact fingerprint matching and same-source ambiguity review.
-- Provider-qualified Eventbrite identities link to existing canonicals
-- rather than being routed to duplicate review.
-- Secondary sources preserve provenance without overwriting the
-- established canonical owner's descriptive fields.

create or replace function public.link_harvest_candidate_to_existing_event(
  p_candidate_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate_record public.event_harvest_candidates%rowtype;
  existing_event_id uuid;
  matching_event_ids uuid[];
  match_count integer;
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

  if candidate_record.canonical_event_id is not null then
    return candidate_record.canonical_event_id;
  end if;

  if candidate_record.venue_id is null then
    raise exception 'Harvest candidate has no matched Spot';
  end if;

  if candidate_record.event_fingerprint is null
     or trim(candidate_record.event_fingerprint) = '' then
    raise exception 'Harvest candidate has no event fingerprint';
  end if;


  /*
   * Reuse exact fingerprint identity, or a provider-qualified
   * Eventbrite event URL at the same publishing Spot and start.
   *
   * Only the explicit eventbriteUrl payload field is used for
   * provider identity. Arbitrary payload text is not sufficient.
   */
  select array_agg(distinct c.canonical_event_id)
  into matching_event_ids
  from public.event_harvest_candidates c
  join public.events e
    on e.id = c.canonical_event_id
  join public.event_harvest_sources cs
    on cs.id = c.source_id
  join public.event_harvest_sources incoming_source
    on incoming_source.id = candidate_record.source_id
  where c.id <> p_candidate_id
    and c.venue_id = candidate_record.venue_id
    and e.venue_id = candidate_record.venue_id
    and c.canonical_event_id is not null
    and c.status not in (
      'ignored', 'suppressed', 'stale', 'cancelled'
    )
    and (
      c.event_fingerprint = candidate_record.event_fingerprint
      or (
        c.starts_at = candidate_record.starts_at
        and cs.source_type = 'eventbrite_organizer'
        and c.external_event_id ~ '^[0-9]+$'
        and coalesce(
          candidate_record.raw_payload ->> 'eventbriteUrl', ''
        ) ~* '^https?://(www[.])?eventbrite[.]com/'
        and (
          candidate_record.raw_payload ->> 'eventbriteUrl'
        ) ~ (
          '(^|[^0-9])' || c.external_event_id || '([^0-9]|$)'
        )
      )
      or (
        c.starts_at = candidate_record.starts_at
        and incoming_source.source_type = 'eventbrite_organizer'
        and candidate_record.external_event_id ~ '^[0-9]+$'
        and coalesce(
          c.raw_payload ->> 'eventbriteUrl', ''
        ) ~* '^https?://(www[.])?eventbrite[.]com/'
        and (
          c.raw_payload ->> 'eventbriteUrl'
        ) ~ (
          '(^|[^0-9])'
          || candidate_record.external_event_id
          || '([^0-9]|$)'
        )
      )
    );

  match_count := coalesce(array_length(matching_event_ids, 1), 0);

  if match_count > 1 then
    return null;
  end if;

  if match_count = 1 then
    existing_event_id := matching_event_ids[1];
  end if;

  if existing_event_id is null then
    return null;
  end if;

  /*
   * Preserve the new source as independent provenance while
   * sharing the existing canonical TenderFans event.
   */
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
    existing_event_id,
    candidate_record.source_id,
    p_candidate_id,
    candidate_record.external_event_id,
    candidate_record.source_url,
    candidate_record.first_seen_at,
    candidate_record.last_seen_at,
    candidate_record.last_verified_at
  )
  on conflict do nothing;

  if not exists (
    select 1
    from public.event_source_links l
    where l.candidate_id = p_candidate_id
      and l.event_id = existing_event_id
  ) then
    raise exception
      'Provenance link conflict for candidate %',
      p_candidate_id;
  end if;

  update public.event_harvest_candidates
  set
    canonical_event_id = existing_event_id,
    status = 'published',
    updated_at = now()
  where id = p_candidate_id;

  return existing_event_id;
end;
$$;

create or replace function
public.flag_event_harvest_occurrence_review(
  p_candidate_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_candidate public.event_harvest_candidates%rowtype;
  v_peer_ids uuid[];
  v_all_ids uuid[];
  v_event_id uuid;
begin
  select *
  into v_candidate
  from public.event_harvest_candidates
  where id = p_candidate_id
  for update;

  if not found then
    raise exception 'Harvest candidate not found';
  end if;

  if v_candidate.starts_at is null then
    return false;
  end if;

  /*
   * Find plausible representations of this same occurrence.
   *
   * Same-source title containment remains reviewable.
   *
   * Explicit Eventbrite references that could not be linked
   * unambiguously also remain reviewable. Candidates already
   * linked to the same canonical event are excluded above.
   */
  select array_agg(distinct peer.id)
  into v_peer_ids
  from public.event_harvest_candidates peer
  join public.event_harvest_sources peer_source
    on peer_source.id = peer.source_id
  where peer.id <> v_candidate.id
    and peer.starts_at = v_candidate.starts_at
    and peer.venue_id = v_candidate.venue_id
    and (
      peer.canonical_event_id is null
      or v_candidate.canonical_event_id is null
      or peer.canonical_event_id <> v_candidate.canonical_event_id
    )
    and peer.status not in (
      'ignored',
      'suppressed',
      'stale',
      'cancelled'
    )
    and (
      (
        peer.source_id = v_candidate.source_id
        and peer.normalized_title is not null
        and v_candidate.normalized_title is not null
        and (
          peer.normalized_title like
            '%' || v_candidate.normalized_title || '%'
          or
          v_candidate.normalized_title like
            '%' || peer.normalized_title || '%'
        )
      )
      or
      (
        peer_source.source_type = 'eventbrite_organizer'
        and peer.external_event_id ~ '^[0-9]+$'
        and coalesce(
          v_candidate.raw_payload ->> 'eventbriteUrl', ''
        ) ~* '^https?://(www[.])?eventbrite[.]com/'
        and (
          v_candidate.raw_payload ->> 'eventbriteUrl'
        ) ~ (
          '(^|[^0-9])'
          || peer.external_event_id
          || '([^0-9]|$)'
        )
      )
      or
      (
        v_candidate.external_event_id ~ '^[0-9]+$'
        and exists (
          select 1
          from public.event_harvest_sources current_source
          where current_source.id = v_candidate.source_id
            and current_source.source_type = 'eventbrite_organizer'
        )
        and coalesce(
          peer.raw_payload ->> 'eventbriteUrl', ''
        ) ~* '^https?://(www[.])?eventbrite[.]com/'
        and (
          peer.raw_payload ->> 'eventbriteUrl'
        ) ~ (
          '(^|[^0-9])'
          || v_candidate.external_event_id
          || '([^0-9]|$)'
        )
      )
    );
  if coalesce(array_length(v_peer_ids, 1), 0) = 0 then
    return false;
  end if;

  v_all_ids :=
    array_append(v_peer_ids, v_candidate.id);

  /*
   * Mark every implicated candidate for human review.
   *
   * Preserve the candidate and its canonical relationship so approval
   * can reuse the established graduate_harvest_candidate lifecycle.
   */
  update public.event_harvest_candidates c
  set
    status = 'needs_review',
    raw_payload =
      coalesce(c.raw_payload, '{}'::jsonb)
      ||
      jsonb_build_object(
        'occurrenceReview',
        jsonb_build_object(
          'requiresReview', true,
          'reason', 'possible_duplicate_occurrence',
          'flaggedAt', now()
        )
      ),
    updated_at = now()
  where c.id = any(v_all_ids);

  /*
   * A peer may already have graduated before later evidence exposed
   * the ambiguity. Pull harvested canonical events back to draft while
   * the occurrence is awaiting review.
   *
   * Never retract a canonical event carrying Ticketmaster provenance.
   */
  for v_event_id in
    select distinct c.canonical_event_id
    from public.event_harvest_candidates c
    where c.id = any(v_all_ids)
      and c.canonical_event_id is not null
  loop
    if not exists (
      select 1
      from public.event_source_links esl
      join public.event_harvest_sources s
        on s.id = esl.source_id
      where esl.event_id = v_event_id
        and s.provider = 'ticketmaster'
    ) then
      update public.events
      set status = 'draft'
      where id = v_event_id
        and status = 'published';
    end if;
  end loop;

  return true;
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
  is_secondary_identity_link boolean := false;
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


  /*
   * An Eventbrite organizer candidate explicitly linked through
   * another source's eventbriteUrl contributes provenance, but
   * does not replace that existing canonical source's content.
   *
   * Ordinary fingerprint links and website updates retain
   * their established synchronization behavior.
   */
  select exists (
    select 1
    from public.event_harvest_sources incoming_source
    join public.event_harvest_candidates owner_candidate
      on owner_candidate.canonical_event_id = candidate_record.canonical_event_id
     and owner_candidate.id <> p_candidate_id
     and owner_candidate.venue_id = candidate_record.venue_id
     and owner_candidate.starts_at = candidate_record.starts_at
    where incoming_source.id = candidate_record.source_id
      and incoming_source.source_type = 'eventbrite_organizer'
      and candidate_record.external_event_id ~ '^[0-9]+$'
      and coalesce(
        owner_candidate.raw_payload ->> 'eventbriteUrl', ''
      ) ~* '^https?://(www[.])?eventbrite[.]com/'
      and (
        owner_candidate.raw_payload ->> 'eventbriteUrl'
      ) ~ (
        '(^|[^0-9])'
        || candidate_record.external_event_id
        || '([^0-9]|$)'
      )
  )
  into is_secondary_identity_link;

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
  if not has_ticketmaster_provenance
     and not is_secondary_identity_link then
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
  if not has_ticketmaster_provenance
     and not is_secondary_identity_link then
    perform public.publish_event(
      canonical_event_id,
      null
    );
  end if;

  return canonical_event_id;
end;
$$;
