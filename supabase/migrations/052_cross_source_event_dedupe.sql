-- ============================================================
-- 052_cross_source_event_dedupe.sql
--
-- Attach a harvested candidate to an already-existing
-- canonical event when another harvested source has already
-- published the exact same real-world occurrence.
--
-- Identity is intentionally strict:
--   same TenderFans Spot + exact event fingerprint.
--
-- No fuzzy matching is performed here.
-- ============================================================

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
   * Find another harvested candidate representing the exact
   * same occurrence that already owns a canonical event.
   *
   * Prefer a published canonical event if more than one legacy
   * match somehow exists.
   */
  select c.canonical_event_id
  into existing_event_id
  from public.event_harvest_candidates c
  join public.events e
    on e.id = c.canonical_event_id
  where c.id <> p_candidate_id
    and c.venue_id = candidate_record.venue_id
    and c.event_fingerprint =
      candidate_record.event_fingerprint
    and c.canonical_event_id is not null
  order by
    case when e.status = 'published' then 0 else 1 end,
    c.created_at asc
  limit 1
  for update of c;

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
  );

  update public.event_harvest_candidates
  set
    canonical_event_id = existing_event_id,
    status = 'published',
    updated_at = now()
  where id = p_candidate_id;

  return existing_event_id;
end;
$$;

revoke all
on function public.link_harvest_candidate_to_existing_event(uuid)
from public;

grant execute
on function public.link_harvest_candidate_to_existing_event(uuid)
to service_role;
