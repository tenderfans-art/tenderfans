-- Migration 091
-- Generic cross-source occurrence guard.
-- Preserve migration 089 behavior for all other cases.
-- Never retract an established published event merely
-- because another source presents a plausible duplicate.
--
-- Deploy before rerunning affected first-party sources.

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
   * CROSS-SOURCE OCCURRENCE SAFETY GUARD
   *
   * A different publisher feed may describe the same event
   * using a different title and fingerprint.
   *
   * Require:
   *   - identical publishing Spot
   *   - identical occurrence start
   *   - different source identity
   *   - existing published canonical event
   *   - strong title containment OR substantial matching
   *     description opening
   *
   * Do not automatically merge fuzzy identities.
   * Do not retract the existing published event.
   * Only the incoming candidate enters Event Review.
   */
  if v_candidate.canonical_event_id is null
     and exists (
       select 1
       from public.event_harvest_candidates peer
       join public.events established
         on established.id = peer.canonical_event_id
       where peer.id <> v_candidate.id
         and peer.source_id <> v_candidate.source_id
         and peer.venue_id = v_candidate.venue_id
         and peer.starts_at = v_candidate.starts_at
         and established.venue_id = v_candidate.venue_id
         and established.status = 'published'
         and peer.status not in (
           'ignored', 'suppressed', 'stale', 'cancelled'
         )
         and (
           (
             length(trim(coalesce(
               v_candidate.normalized_title, ''
             ))) >= 25
             and length(trim(coalesce(
               peer.normalized_title, ''
             ))) >= 25
             and (
               position(
                 lower(v_candidate.normalized_title)
                 in lower(peer.normalized_title)
               ) > 0
               or position(
                 lower(peer.normalized_title)
                 in lower(v_candidate.normalized_title)
               ) > 0
             )
           )
           or
           (
             length(trim(coalesce(
               v_candidate.normalized_title, ''
             ))) >= 18
             and length(trim(coalesce(
               peer.normalized_title, ''
             ))) >= 18
             and similarity(
               lower(v_candidate.normalized_title),
               lower(peer.normalized_title)
             ) >= 0.55
           )
           or
           (
             /*
              * Generic cross-source title-prefix comparison.
              * Detect minor spelling variations in identifying
              * prefixes without requiring promotional suffixes
              * to match.
              */
             position(
               ':' in coalesce(v_candidate.normalized_title, '')
             ) > 0
             and position(
               ':' in coalesce(peer.normalized_title, '')
             ) > 0
             and length(trim(split_part(
               v_candidate.normalized_title, ':', 1
             ))) >= 8
             and length(trim(split_part(
               peer.normalized_title, ':', 1
             ))) >= 8
             and similarity(
               lower(trim(split_part(
                 v_candidate.normalized_title, ':', 1
               ))),
               lower(trim(split_part(
                 peer.normalized_title, ':', 1
               )))
             ) >= 0.75
           )
           or
           (
             length(trim(coalesce(
               v_candidate.raw_description, ''
             ))) >= 140
             and length(trim(coalesce(
               peer.raw_description, ''
             ))) >= 140
             and left(
               regexp_replace(
                 lower(
                   regexp_replace(
                     coalesce(v_candidate.raw_description, ''),
                     '^\s*event information\s*',
                     '',
                     'i'
                   )
                 ),
                 '[^a-z0-9]+', ' ', 'g'
               ),
               100
             ) =
             left(
               regexp_replace(
                 lower(
                   regexp_replace(
                     coalesce(peer.raw_description, ''),
                     '^\s*event information\s*',
                     '',
                     'i'
                   )
                 ),
                 '[^a-z0-9]+', ' ', 'g'
               ),
               100
             )
           )
         )
     )
  then
    update public.event_harvest_candidates
    set
      status = 'needs_review',
      raw_payload =
        coalesce(raw_payload, '{}'::jsonb)
        ||
        jsonb_build_object(
          'occurrenceReview',
          jsonb_build_object(
            'requiresReview', true,
            'reason', 'possible_cross_source_duplicate',
            'flaggedAt', now()
          )
        ),
      updated_at = now()
    where id = p_candidate_id;

    return true;
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
