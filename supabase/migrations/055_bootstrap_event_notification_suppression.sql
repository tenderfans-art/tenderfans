-- ============================================================
-- 055_bootstrap_event_notification_suppression.sql
--
-- Give initial harvested inventory a truthful terminal queue
-- state. A suppressed publication occupies the same dedupe
-- identity as a normal spot.event_published notification, so a
-- later publish_event() retry cannot notify followers about an
-- event that predated source monitoring.
-- ============================================================

do $$
declare
  v_constraint text;
begin
  select c.conname
  into v_constraint
  from pg_constraint c
  where c.conrelid =
      'public.notification_events'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%status%'
    and pg_get_constraintdef(c.oid) ilike '%pending%'
    and pg_get_constraintdef(c.oid) ilike '%processing%'
    and pg_get_constraintdef(c.oid) ilike '%sent%'
    and pg_get_constraintdef(c.oid) ilike '%failed%'
  limit 1;

  if v_constraint is not null then
    execute format(
      'alter table public.notification_events drop constraint %I',
      v_constraint
    );
  end if;
end;
$$;

alter table public.notification_events
  add constraint notification_events_status_check
  check (
    status in (
      'pending',
      'processing',
      'sent',
      'failed',
      'expired',
      'suppressed'
    )
  );


create or replace function public.suppress_event_publication_notification(
  p_event_id uuid,
  p_reason text default 'initial_source_bootstrap'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  event_venue_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  select e.venue_id
  into event_venue_id
  from public.events e
  where e.id = p_event_id
  for update;

  if event_venue_id is null then
    raise exception 'Event not found';
  end if;

  insert into public.notification_events (
    entity_kind,
    venue_id,
    event_type,
    source_kind,
    source_id,
    metadata,
    status,
    processed_at
  )
  values (
    'venue',
    event_venue_id,
    'spot.event_published',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_id', p_event_id,
      'suppressed', true,
      'suppression_reason', coalesce(
        nullif(trim(p_reason), ''),
        'initial_source_bootstrap'
      )
    ),
    'suppressed',
    now()
  )
  on conflict do nothing;
end;
$$;

revoke all
on function public.suppress_event_publication_notification(uuid, text)
from public;

grant execute
on function public.suppress_event_publication_notification(uuid, text)
to service_role;


-- Bootstrap graduation already publishes without calling
-- publish_event(). Extend it so the suppression identity is
-- reserved atomically in the same transaction.

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
