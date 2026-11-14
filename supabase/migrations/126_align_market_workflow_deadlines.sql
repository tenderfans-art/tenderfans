-- 126: Align Workflow admission, per-item execution and settlement.
-- No work/source rows, eligibility, capacity or original pipelines changed.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '90s';

-- Refuse to overwrite an unrecorded production function change.
do $preflight$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
      where p.oid = 'public.claim_shared_harvester_assignment(uuid,integer)'::regprocedure)
      is distinct from '1e60f31404f62bc69346449442c1bb7a' then
    raise exception '126: Assignment function differs from verified baseline';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
      where p.oid = 'public.tf_cap_workflow_reservation_deadline()'::regprocedure)
      is distinct from 'ea48a4716657c725a8fdce4ae15106d3' then
    raise exception '126: Reservation deadline function differs from verified baseline';
  end if;
end;
$preflight$;

-- 20 minutes admission + 30 minutes per item + 5 minutes settlement.
-- Existing rows are not extended or reopened by this migration.
create or replace function public.tf_cap_workflow_reservation_deadline()
returns trigger
language plpgsql
set search_path = ''
as $deadline$
begin
  if TG_OP = 'UPDATE'
     and old.workflow_run_id is not null
     and old.status in ('reserved', 'claimed')
     and new.status = 'expired' then
    return null;
  end if;

  if new.status in ('reserved', 'claimed') then
    new.expires_at := least(
      new.expires_at,
      new.reserved_at + interval '55 minutes'
    );
  end if;

  return new;
end;
$deadline$;

create or replace function public.claim_shared_harvester_assignment(
  p_reservation_id uuid,
  p_slot_number integer
)
returns table (
  work_id uuid,
  claimed_batch_id uuid,
  claimed_lease_token uuid,
  claimed_attempt integer,
  claimed_venue_id uuid,
  claimed_source_id uuid,
  claimed_leased_until timestamptz
)
language plpgsql
security definer
set search_path = ''
as $assignment$
declare
  v_reservation public.event_processing_dispatch_reservations%rowtype;
  v_assignment public.shared_harvester_source_assignments%rowtype;
  v_claim record;
  v_now timestamptz;
  v_global_limit integer;
  v_market_limit integer;
  v_global_active integer;
  v_market_active integer;
  v_batch_id uuid := gen_random_uuid();
begin
  if p_reservation_id is null
     or p_slot_number is null
     or p_slot_number < 0
  then
    raise exception 'Invalid assignment arguments';
  end if;

  -- Global lock precedes reservation and market locks.
  perform 1
  from public.event_processing_pool_config
  where singleton = true
  for update;

  if not found then
    raise exception 'Shared pool configuration missing';
  end if;

  select *
    into v_reservation
  from public.event_processing_dispatch_reservations r
  where r.id = p_reservation_id
  for update;

  if not found then
    raise exception 'Shared reservation not found';
  end if;

  -- Durable replay path.
  select *
    into v_assignment
  from public.shared_harvester_source_assignments a
  where a.reservation_id = p_reservation_id
    and a.slot_number = p_slot_number;

  if found then
    -- Immutable historical claim snapshot. Execution fencing
    -- independently rejects expired or superseded leases.
    return query
    select
      v_assignment.work_id,
      v_assignment.claimed_batch_id,
      v_assignment.lease_token,
      v_assignment.claimed_attempt,
      v_assignment.claimed_venue_id,
      v_assignment.claimed_source_id,
      v_assignment.claimed_leased_until;

    return;
  end if;

  -- Existing snapshots were handled above. New assignments
  -- require a live reservation, regardless of whether the
  -- reservation has already claimed earlier sources.
  if v_reservation.status not in ('reserved', 'claimed')
     or v_reservation.expires_at <= clock_timestamp()
  then
    raise exception 'Shared reservation unavailable or expired';
  end if;

  -- Replays above remain immutable. New admission is checked only
  -- after pool -> reservation -> Market locking has completed.
  perform 1
  from public.event_processing_markets m
  where m.id = v_reservation.market_id
    and m.is_enabled = true
  for update;

  if not found then
    return;
  end if;

  if clock_timestamp() >=
       v_reservation.reserved_at + interval '20 minutes'
     or v_reservation.expires_at <= clock_timestamp() then
    return;
  end if;

  if v_reservation.work_type = 'harvest_source' then
    -- Preserve the exact original source claim path.
    select *
      into v_claim
    from public.claim_shared_harvester_source(
      v_reservation.market_id,
      180
    );

    if not found then
      return;
    end if;

  elsif v_reservation.work_type in (
    'detect_spot', 'archive_recheck', 'harvest_provider'
  ) then
    select c.max_concurrent_sources
      into v_global_limit
    from public.event_processing_pool_config c
    where c.singleton = true;

    select e.allowed_sources
      into v_market_limit
    from public.market_shared_harvester_entitlement(
      v_reservation.market_id
    ) e;

    if not found then
      return;
    end if;

    v_now := clock_timestamp();

    select count(*)::integer
      into v_global_active
    from public.event_processing_work w
    where w.work_type in ('harvest_source', 'detect_spot', 'archive_recheck', 'harvest_provider')
      and w.status = 'leased'
      and w.leased_until > v_now;

    select count(*)::integer
      into v_market_active
    from public.event_processing_work w
    where w.market_id = v_reservation.market_id
      and w.work_type in ('harvest_source', 'detect_spot', 'archive_recheck', 'harvest_provider')
      and w.status = 'leased'
      and w.leased_until > v_now;

    if v_global_active >= v_global_limit
       or v_market_active >= v_market_limit
    then
      return;
    end if;

    -- Provider admission is exclusive globally and has one slot
    -- per reservation. The global pool lock is still held here.
    if v_reservation.work_type = 'harvest_provider' then
      if p_slot_number <> 0
         or exists (
           select 1
           from public.event_processing_work provider_work
           where provider_work.work_type = 'harvest_provider'
             and provider_work.status = 'leased'
             and provider_work.leased_until > v_now
         )
      then
        return;
      end if;
    end if;

    -- One eligible work item per immutable assignment slot.
    -- Replays above returned the original snapshot already.
    with selected as materialized (
        select w.id
        from public.event_processing_work w
        where w.market_id = v_reservation.market_id
          and w.work_type = v_reservation.work_type
          and w.attempts < w.max_attempts
          and (
      (w.status in ('pending', 'retry')
       and w.due_at <= v_now)
      or
      (w.status = 'leased'
       and w.leased_until <= v_now)
    )
          and public.shared_market_work_eligible(v_reservation.market_id, w.work_type, w.venue_id, w.source_id, v_now)
        order by w.priority asc, w.due_at asc, w.id asc
        limit 1
        for update of w skip locked
      ),
      claimed as (
        update public.event_processing_work w
        set status = 'leased',
            batch_id = v_batch_id,
            lease_token = gen_random_uuid(),
            leased_until = v_now + interval '180 minutes',
            attempts = w.attempts + 1,
            last_started_at = v_now,
            last_finished_at = null,
            last_error = null,
            updated_at = v_now
        from selected s
        where w.id = s.id
        returning w.*
      )
      select
        c.id as work_id,
        c.batch_id as claimed_batch_id,
        c.lease_token as claimed_lease_token,
        c.attempts as claimed_attempt,
        c.venue_id as claimed_venue_id,
        c.source_id as claimed_source_id,
        c.leased_until as claimed_leased_until
      into v_claim
      from claimed c;

    if not found then
      return;
    end if;

  else
    raise exception 'Invalid shared reservation work type';
  end if;

  insert into public.shared_harvester_source_assignments (
    reservation_id,
    slot_number,
    work_id,
    lease_token,
    claimed_batch_id,
    claimed_attempt,
    claimed_venue_id,
    claimed_source_id,
    claimed_leased_until
  )
  values (
    p_reservation_id,
    p_slot_number,
    v_claim.work_id,
    v_claim.claimed_lease_token,
    v_claim.claimed_batch_id,
    v_claim.claimed_attempt,
    v_claim.claimed_venue_id,
    v_claim.claimed_source_id,
    v_claim.claimed_leased_until
  );

  update public.event_processing_dispatch_reservations r
  set status = 'claimed',
      claimed_at = coalesce(r.claimed_at, clock_timestamp()),
      expires_at = clock_timestamp() + interval '4 hours'
  where r.id = p_reservation_id
    and r.status in ('reserved', 'claimed');

  return query
  select
    v_claim.work_id,
    v_claim.claimed_batch_id,
    v_claim.claimed_lease_token,
    v_claim.claimed_attempt,
    v_claim.claimed_venue_id,
    v_claim.claimed_source_id,
    v_claim.claimed_leased_until;
end;
$assignment$;

revoke all on function public.claim_shared_harvester_assignment(uuid,integer)
from public,anon,authenticated;
grant execute on function public.claim_shared_harvester_assignment(uuid,integer)
to service_role;

commit;
