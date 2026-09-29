-- ============================================================
-- 054_first_party_bootstrap_graduation.sql
--
-- Publish an initial first-party calendar inventory without
-- manufacturing follower notifications for pre-existing events.
--
-- This is intentionally separate from graduate_harvest_candidate().
-- Normal harvested events continue through publish_event() and
-- retain the existing notification contract.
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

  /*
   * Bootstrap publication is restricted to enabled, Spot-bound
   * first-party sources. Other providers must use the normal
   * graduation path.
   */
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

  /*
   * If this candidate already owns a canonical event, bootstrap
   * must not silently republish or alter that existing lifecycle.
   */
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

  /*
   * Deliberately DO NOT call publish_event().
   *
   * The canonical event is already published above, but no
   * spot.event_published notification is created for inventory
   * that existed before TenderFans began monitoring this source.
   */
  return created_event_id;
end;
$$;

revoke all
on function public.bootstrap_first_party_harvest_candidate(uuid)
from public;

grant execute
on function public.bootstrap_first_party_harvest_candidate(uuid)
to service_role;
