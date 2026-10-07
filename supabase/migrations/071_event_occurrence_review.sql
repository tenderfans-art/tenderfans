-- ============================================================
-- EVENT OCCURRENCE REVIEW
--
-- Route plausible duplicate representations of the same real-world
-- occurrence to the existing Event Venue Match Review workflow.
--
-- This does NOT fuzzy-merge events.
-- This does NOT choose a winning Spot.
--
-- Each implicated harvest candidate remains independently reviewable.
-- Admin may approve the correct representation and reject the others.
--
-- Detection is intentionally conservative:
--
--   1. Same first-party source + exact occurrence start +
--      containment between normalized titles.
--
--      This catches publisher feeds that expose multiple representations
--      of the same occurrence without treating generic same-time events
--      across unrelated sources as duplicates.
--
--   2. Provider-qualified Eventbrite reference:
--      one candidate explicitly contains an eventbrite.com reference
--      containing another Eventbrite candidate's numeric external ID,
--      at the same occurrence start.
--
-- Existing exact fingerprint dedupe remains authoritative and runs
-- before this review layer.
-- ============================================================


-- ============================================================
-- DETECTION / REVIEW ROUTING
-- ============================================================

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
   * Rule A:
   * Same source + exact start + title containment.
   *
   * Rule B:
   * Explicit Eventbrite URL/reference relationship at the same start.
   * We only compare numeric Eventbrite external IDs and require the
   * referring payload to actually mention eventbrite.com.
   *
   * Arbitrary raw-payload substring matching is intentionally avoided.
   */
  select array_agg(distinct peer.id)
  into v_peer_ids
  from public.event_harvest_candidates peer
  join public.event_harvest_sources peer_source
    on peer_source.id = peer.source_id
  where peer.id <> v_candidate.id
    and peer.starts_at = v_candidate.starts_at
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
        and (
          (
            coalesce(v_candidate.raw_description, '') ilike '%eventbrite.com%'
            and position(
              peer.external_event_id
              in coalesce(v_candidate.raw_description, '')
            ) > 0
          )
          or
          (
            coalesce(v_candidate.source_url, '') ilike '%eventbrite.com%'
            and position(
              peer.external_event_id
              in coalesce(v_candidate.source_url, '')
            ) > 0
          )
          or
          (
            coalesce(v_candidate.raw_payload::text, '') ilike '%eventbrite.com%'
            and position(
              peer.external_event_id
              in coalesce(v_candidate.raw_payload::text, '')
            ) > 0
          )
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
        and (
          (
            coalesce(peer.raw_description, '') ilike '%eventbrite.com%'
            and position(
              v_candidate.external_event_id
              in coalesce(peer.raw_description, '')
            ) > 0
          )
          or
          (
            coalesce(peer.source_url, '') ilike '%eventbrite.com%'
            and position(
              v_candidate.external_event_id
              in coalesce(peer.source_url, '')
            ) > 0
          )
          or
          (
            coalesce(peer.raw_payload::text, '') ilike '%eventbrite.com%'
            and position(
              v_candidate.external_event_id
              in coalesce(peer.raw_payload::text, '')
            ) > 0
          )
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


-- ============================================================
-- ADMIN REVIEW QUEUE
-- ============================================================

create or replace function
public.admin_list_event_occurrence_reviews()
returns table(
  id uuid,
  source_id uuid,
  source_name text,
  external_event_id text,
  source_url text,
  raw_title text,
  raw_description text,
  starts_at timestamptz,
  ends_at timestamptz,
  venue_id uuid,
  venue_name text,
  confidence_score numeric,
  canonical_event_id uuid,
  last_seen_at timestamptz,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  ) then
    raise exception 'Admin access required';
  end if;

  return query
  select
    c.id,
    c.source_id,
    s.name,
    c.external_event_id,
    c.source_url,
    c.raw_title,
    c.raw_description,
    c.starts_at,
    c.ends_at,
    c.venue_id,
    v.name,
    c.confidence_score,
    c.canonical_event_id,
    c.last_seen_at,
    c.created_at
  from public.event_harvest_candidates c
  join public.event_harvest_sources s
    on s.id = c.source_id
  join public.venues v
    on v.id = c.venue_id
  where c.status = 'needs_review'
    and coalesce(
      (c.raw_payload -> 'occurrenceReview' ->> 'requiresReview')::boolean,
      false
    ) = true
  order by
    c.starts_at asc,
    c.created_at asc;
end;
$$;


-- ============================================================
-- ADMIN REVIEW ACTION
-- ============================================================

create or replace function
public.admin_review_event_occurrence(
  p_candidate_id uuid,
  p_approve boolean
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_candidate public.event_harvest_candidates%rowtype;
  v_event_id uuid;
begin
  if auth.uid() is null or not exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  ) then
    raise exception 'Admin access required.';
  end if;

  select *
  into v_candidate
  from public.event_harvest_candidates
  where id = p_candidate_id
  for update;

  if not found then
    raise exception 'Harvest candidate not found';
  end if;

  if v_candidate.status <> 'needs_review' then
    raise exception 'Harvest candidate is not awaiting review';
  end if;

  if coalesce(
    (
      v_candidate.raw_payload
      -> 'occurrenceReview'
      ->> 'requiresReview'
    )::boolean,
    false
  ) <> true then
    raise exception 'Candidate is not an occurrence-review candidate';
  end if;

  if p_approve then
    v_event_id :=
      public.graduate_harvest_candidate(
        p_candidate_id,
        auth.uid()
      );

    update public.event_harvest_candidates
    set
      raw_payload =
        jsonb_set(
          coalesce(raw_payload, '{}'::jsonb),
          '{occurrenceReview}',
          coalesce(
            raw_payload -> 'occurrenceReview',
            '{}'::jsonb
          )
          ||
          jsonb_build_object(
            'requiresReview', false,
            'decision', 'approved',
            'reviewedAt', now()
          ),
          true
        ),
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      updated_at = now()
    where id = p_candidate_id;

    return v_event_id;
  end if;

  /*
   * Reject the first-party representation without retracting a
   * canonical event that is also protected by Ticketmaster provenance.
   */
  if v_candidate.canonical_event_id is not null
     and not exists (
       select 1
       from public.event_source_links esl
       join public.event_harvest_sources s
         on s.id = esl.source_id
       where esl.event_id = v_candidate.canonical_event_id
         and s.provider = 'ticketmaster'
     ) then
    update public.events
    set status = 'draft'
    where id = v_candidate.canonical_event_id
      and status = 'published';
  end if;

  update public.event_harvest_candidates
  set
    status = 'ignored',
    raw_payload =
      jsonb_set(
        coalesce(raw_payload, '{}'::jsonb),
        '{occurrenceReview}',
        coalesce(
          raw_payload -> 'occurrenceReview',
          '{}'::jsonb
        )
        ||
        jsonb_build_object(
          'requiresReview', false,
          'decision', 'rejected',
          'reviewedAt', now()
        ),
        true
      ),
    reviewed_by = auth.uid(),
    reviewed_at = now(),
    updated_at = now()
  where id = p_candidate_id;

  return null;
end;
$$;


-- ============================================================
-- SECURITY
-- ============================================================

revoke all
on function
public.flag_event_harvest_occurrence_review(uuid)
from public, anon, authenticated;

grant execute
on function
public.flag_event_harvest_occurrence_review(uuid)
to service_role;


revoke all
on function
public.admin_list_event_occurrence_reviews()
from public, anon;

grant execute
on function
public.admin_list_event_occurrence_reviews()
to authenticated;


revoke all
on function
public.admin_review_event_occurrence(uuid, boolean)
from public, anon;

grant execute
on function
public.admin_review_event_occurrence(uuid, boolean)
to authenticated;
