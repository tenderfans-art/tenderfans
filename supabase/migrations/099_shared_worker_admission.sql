-- 099: Shared worker admission foundation.
-- No cron changes, market activation, or existing RPC replacement.
-- Reservations are provisional until Workflow integration.
-- Do not invoke reserve_shared_harvester_batch operationally yet.

create table public.event_processing_pool_config (
  singleton boolean primary key default true
    check (singleton = true),
  max_concurrent_batches integer not null default 2
    check (max_concurrent_batches between 1 and 100),
  updated_at timestamptz not null default now()
);

insert into public.event_processing_pool_config (singleton)
values (true);

create table public.event_processing_dispatch_reservations (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null
    references public.event_processing_markets(id)
    on delete restrict,
  work_type text not null
    check (work_type = 'harvest_source'),
  status text not null default 'reserved'
    check (status in (
      'reserved', 'claimed', 'released', 'expired'
    )),
  reserved_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  released_at timestamptz,
  workflow_run_id text,
  batch_id uuid,
  constraint reservation_expiry_valid
    check (expires_at > reserved_at)
);

create index event_processing_reservation_active_idx
  on public.event_processing_dispatch_reservations
    (status, expires_at, market_id);

create index event_processing_reservation_market_idx
  on public.event_processing_dispatch_reservations
    (market_id, reserved_at desc);

alter table public.event_processing_pool_config
  enable row level security;

alter table public.event_processing_dispatch_reservations
  enable row level security;

revoke all on public.event_processing_pool_config
  from public, anon, authenticated;

revoke all on public.event_processing_dispatch_reservations
  from public, anon, authenticated;

-- Reserve one shared batch slot atomically.
--
-- All callers of this RPC serialize on the singleton config row.
-- Existing active work batches and outstanding reservations
-- both count toward global and per-market capacity.
--
-- This does not yet integrate the reservation with the Workflow.
-- It must not be used for production dispatch until that integration
-- atomically consumes or releases each reservation.

alter table public.event_processing_pool_config
  add column max_concurrent_sources integer not null default 16
    check (max_concurrent_sources between 1 and 128),
  add column max_http_sources integer not null default 16
    check (max_http_sources between 1 and 128),
  add column max_browser_sources integer not null default 4
    check (max_browser_sources between 1 and 128),
  add column max_recovery_sources integer not null default 2
    check (max_recovery_sources between 1 and 128);

alter table public.event_processing_markets
  add column max_concurrent_sources integer not null default 8
    check (max_concurrent_sources between 1 and 128);

create function public.reserve_shared_harvester_batch()
returns table (
  reservation_id uuid,
  selected_market_id uuid,
  selected_market_key text,
  reservation_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $reserve_shared$
declare
  v_workflow_limit integer;
  v_source_limit integer;
  v_live_workflows integer;
  v_live_sources integer;
  v_market record;
  v_now timestamptz;
  v_reservation_id uuid;
  v_expires_at timestamptz;
begin
  -- Serialize all shared reservation admissions.
  select
    c.max_concurrent_batches,
    c.max_concurrent_sources
  into
    v_workflow_limit,
    v_source_limit
  from public.event_processing_pool_config c
  where c.singleton = true
  for update;

  if not found then
    raise exception 'Shared worker pool configuration missing';
  end if;

  v_now := clock_timestamp();

  -- An unclaimed reservation can expire without having
  -- acquired any source work.
  update public.event_processing_dispatch_reservations r
  set status = 'expired',
      released_at = v_now
  where r.status = 'reserved'
    and r.expires_at <= v_now;

  -- Workflow admission is independent of source capacity.
  -- Count both pending starts and claimed live ownership.
  select count(*)::integer
    into v_live_workflows
  from public.event_processing_dispatch_reservations r
  where r.status in ('reserved', 'claimed')
    and r.expires_at > v_now;

  if v_live_workflows >= v_workflow_limit then
    return;
  end if;

  -- Source capacity includes legacy market work.
  select count(*)::integer
    into v_live_sources
  from public.event_processing_work w
  where w.work_type = 'harvest_source'
    and w.status = 'leased'
    and w.leased_until > v_now;

  if v_live_sources >= v_source_limit then
    return;
  end if;

  -- Prefer markets least recently given shared admission.
  -- Require actual eligible, unlocked source work and
  -- remaining per-market source AND Workflow capacity.
  select
    m.id,
    m.market_key
  into v_market
  from public.event_processing_markets m
  join lateral (
    select min(w.due_at) as oldest_due
    from public.event_processing_work w
    join public.event_harvest_sources s
      on s.id = w.source_id
    join public.event_processing_market_venues mv
      on mv.venue_id = s.venue_id
     and mv.market_id = m.id
    where w.market_id = m.id
      and w.work_type = 'harvest_source'
      and w.attempts < w.max_attempts
      and s.provider = 'first_party'
      and s.is_enabled = true
      and (
        (
          w.status in ('pending', 'retry')
          and w.due_at <= v_now
        )
        or (
          w.status = 'leased'
          and w.leased_until <= v_now
        )
      )
      and not exists (
        select 1
        from public.first_party_source_executions e
        where e.source_id = w.source_id
      )
  ) eligible on eligible.oldest_due is not null
  left join lateral (
    select count(*)::integer as n
    from public.event_processing_work w
    where w.market_id = m.id
      and w.work_type = 'harvest_source'
      and w.status = 'leased'
      and w.leased_until > v_now
  ) active_sources on true
  left join lateral (
    select count(*)::integer as n
    from public.event_processing_dispatch_reservations r
    where r.market_id = m.id
      and r.status in ('reserved', 'claimed')
      and r.expires_at > v_now
  ) active_workflows on true
  left join lateral (
    select max(r.reserved_at) as last_reserved
    from public.event_processing_dispatch_reservations r
    where r.market_id = m.id
  ) history on true
  where m.is_enabled = true
    and coalesce(active_sources.n, 0)
      < m.max_concurrent_sources
    and coalesce(active_workflows.n, 0)
      < m.max_concurrent_batches
  order by
    history.last_reserved asc nulls first,
    eligible.oldest_due asc,
    m.id asc
  limit 1;

  if not found then
    return;
  end if;

  -- This short initial deadline protects failed starts.
  -- Claimed Workflow ownership has a separate renewal
  -- lifecycle, which must be completed before activation.
  v_expires_at := v_now + interval '10 minutes';

  insert into public.event_processing_dispatch_reservations (
    market_id,
    work_type,
    expires_at
  )
  values (
    v_market.id,
    'harvest_source',
    v_expires_at
  )
  returning id into v_reservation_id;

  return query
  select
    v_reservation_id,
    v_market.id,
    v_market.market_key,
    v_expires_at;
end;
$reserve_shared$;

revoke all on function public.reserve_shared_harvester_batch()
from public, anon, authenticated;

grant execute on function public.reserve_shared_harvester_batch()
to service_role;


-- Release only an unconsumed reservation.
-- A claimed reservation cannot be cancelled by a delayed
-- HTTP dispatcher after the Workflow has begun.

create function public.release_shared_harvester_reservation(
  p_reservation_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_reservation_id is null then
    return false;
  end if;

  perform 1
  from public.event_processing_pool_config
  where singleton = true
  for update;

  update public.event_processing_dispatch_reservations
  set status = 'released',
      released_at = clock_timestamp()
  where id = p_reservation_id
    and status = 'reserved';

  return found;
end;
$$;

revoke all on function
public.release_shared_harvester_reservation(uuid)
from public, anon, authenticated;

grant execute on function
public.release_shared_harvester_reservation(uuid)
to service_role;


-- Finalize a claimed reservation only when none of its
-- individual work items retain a live lease.
-- Expired work remains eligible for fenced recovery.

create function public.finalize_shared_harvester_reservation(
  p_reservation_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $finalize$
declare
  v_status text;
begin
  if p_reservation_id is null then
    return false;
  end if;

  perform 1
  from public.event_processing_pool_config
  where singleton = true
  for update;

  if not found then
    raise exception 'Shared pool configuration missing';
  end if;

  select r.status
    into v_status
  from public.event_processing_dispatch_reservations r
  where r.id = p_reservation_id
  for update;

  if not found then
    return false;
  end if;

  if v_status in ('released', 'expired') then
    return true;
  end if;

  if v_status not in ('reserved', 'claimed') then
    return false;
  end if;

  -- Do not release Workflow admission while an original
  -- assignment still owns a live source lease.
  -- A superseded lease token does not block finalization.
  if exists (
    select 1
    from public.shared_harvester_source_assignments a
    join public.event_processing_work w
      on w.id = a.work_id
    where a.reservation_id = p_reservation_id
      and w.status = 'leased'
      and w.lease_token = a.lease_token
      and w.leased_until > clock_timestamp()
  ) then
    return false;
  end if;

  -- Source execution ownership and write fencing are unchanged.
  update public.event_processing_dispatch_reservations r
  set status = 'released',
      released_at = clock_timestamp()
  where r.id = p_reservation_id
    and r.status in ('reserved', 'claimed');

  return found;
end;
$finalize$;

revoke all on function
public.finalize_shared_harvester_reservation(uuid)
from public, anon, authenticated;

grant execute on function
public.finalize_shared_harvester_reservation(uuid)
to service_role;


-- ============================================================
-- Fenced market-lock recovery.
-- ============================================================

-- Automatic recovery is strictly limited to market-bound locks.
-- Standalone executions (market_work_id IS NULL) are never touched.
--
-- Work row is locked first, then execution row, matching the
-- transactional fencing order in migration 097.
--
-- A stale worker may still perform network I/O, but its protected
-- writes cannot succeed after its work lease expires.

create function public.recover_expired_market_source_executions(
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = ''
as $recover$
declare
  v_candidate record;
  v_work record;
  v_execution record;
  v_recovered integer := 0;
begin
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'Invalid recovery limit';
  end if;

  for v_candidate in
    select e.source_id, e.market_work_id
    from public.first_party_source_executions e
    where e.market_work_id is not null
    order by e.started_at, e.source_id
    limit p_limit
  loop
    -- Do not wait on an active protected write transaction.
    select w.id, w.source_id, w.status,
           w.lease_token, w.leased_until
      into v_work
    from public.event_processing_work w
    where w.id = v_candidate.market_work_id
    for update skip locked;

    if not found then
      continue;
    end if;

    select e.source_id, e.execution_token,
           e.market_work_id, e.market_lease_token
      into v_execution
    from public.first_party_source_executions e
    where e.source_id = v_candidate.source_id
    for update skip locked;

    if not found then
      continue;
    end if;

    if v_execution.market_work_id is distinct from v_work.id
       or v_execution.market_work_id is null then
      continue;
    end if;

    -- Valid owners are never recovered.
    if v_work.source_id = v_execution.source_id
       and v_work.status = 'leased'
       and v_work.lease_token =
           v_execution.market_lease_token
       and v_work.leased_until > clock_timestamp() then
      continue;
    end if;

    delete from public.first_party_source_executions e
    where e.source_id = v_execution.source_id
      and e.execution_token = v_execution.execution_token
      and e.market_work_id = v_execution.market_work_id
      and e.market_lease_token =
          v_execution.market_lease_token;

    if found then
      insert into public.first_party_execution_recoveries (
        source_id,
        previous_execution_token,
        reason
      )
      values (
        v_execution.source_id,
        v_execution.execution_token,
        'automatic_market_lease_invalid'
      );

      v_recovered := v_recovered + 1;
    end if;
  end loop;

  return v_recovered;
end;
$recover$;

revoke all on function
  public.recover_expired_market_source_executions(integer)
from public, anon, authenticated;

grant execute on function
  public.recover_expired_market_source_executions(integer)
to service_role;


-- ============================================================
-- Shared reservation reconciliation.
-- ============================================================

-- Only reconciles reservation metadata.
-- It does not delete source locks or alter work ownership.
-- Claimed reservations expire only after their ownership
-- deadline and after all original source leases are inactive.
-- Expiry never changes source work ownership or fencing.

create function public.reconcile_shared_harvester_reservations()
returns table (
  expired_reservations integer,
  released_reservations integer
)
language plpgsql
security definer
set search_path = ''
as $reconcile$
declare
  v_now timestamptz;
begin
  perform 1
  from public.event_processing_pool_config
  where singleton = true
  for update;

  if not found then
    raise exception 'Shared pool configuration missing';
  end if;

  v_now := clock_timestamp();

  update public.event_processing_dispatch_reservations r
  set status = 'expired',
      released_at = v_now
  where r.status = 'reserved'
    and r.expires_at <= v_now;

  get diagnostics expired_reservations = row_count;

  -- Expire abandoned Workflow admission only after its
  -- original source assignments no longer own live leases.
  -- Never alter work ownership or lease tokens here.
  update public.event_processing_dispatch_reservations r
  set status = 'expired',
      released_at = v_now
  where r.status = 'claimed'
    and r.expires_at <= v_now
    and not exists (
      select 1
      from public.shared_harvester_source_assignments a
      join public.event_processing_work w
        on w.id = a.work_id
      where a.reservation_id = r.id
        and w.status = 'leased'
        and w.lease_token = a.lease_token
        and w.leased_until > v_now
    );

  -- Retain the existing RPC return shape for dispatcher
  -- compatibility. This count includes expired claimed
  -- reservations, not only explicitly released ones.
  get diagnostics released_reservations = row_count;

  return next;
end;
$reconcile$;

revoke all on function
  public.reconcile_shared_harvester_reservations()
from public, anon, authenticated;

grant execute on function
  public.reconcile_shared_harvester_reservations()
to service_role;


-- Shared source-execution capacity configuration.
-- Configuration only: no worker admission behavior changes here.
-- Future source-level admission must enforce these limits
-- transactionally under the existing shared pool lock.



comment on column
  public.event_processing_pool_config.max_concurrent_sources
is 'Global simultaneous source-execution ceiling; initially 16, configurable through 128.';

comment on column
  public.event_processing_markets.max_concurrent_sources
is 'Per-market simultaneous source-execution ceiling; initially 8.';

-- Resource-specific ceilings are independent safeguards.
-- They must not be interpreted as additional global capacity.

-- Source-level shared worker admission (just-in-time).
--
-- This is an additive RPC. It does not replace the legacy
-- claim_event_processing_batch function or activate scheduling.
--
-- Every successful invocation claims exactly ONE eligible source.
-- The global pool row serializes competing shared-pool admissions.
-- Existing live harvester leases count against capacity, including
-- leases created by the legacy market dispatcher.
--
-- The legacy dispatcher does not acquire this global pool lock,
-- so mixed legacy/shared operation is not yet a strict global
-- concurrency guarantee. Do not enable shared production dispatch
-- until all relevant admission paths are coordinated.

create function public.claim_shared_harvester_source(
  p_market_id uuid,
  p_lease_minutes integer default 180
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
as $claim_source$
declare
  v_global_limit integer;
  v_market_limit integer;
  v_global_active integer;
  v_market_active integer;
  v_now timestamptz;
  v_batch_id uuid := gen_random_uuid();
begin
  if p_market_id is null
     or p_lease_minutes is null
     or p_lease_minutes not between 1 and 180
  then
    raise exception 'Invalid shared source claim arguments';
  end if;

  -- Serialize all shared source admissions globally.
  select config.max_concurrent_sources
    into v_global_limit
  from public.event_processing_pool_config config
  where config.singleton = true
  for update;

  if not found then
    raise exception 'Shared pool configuration missing';
  end if;

  v_now := clock_timestamp();

  -- Preserve market-level serialization and enabled gating.
  select market.max_concurrent_sources
    into v_market_limit
  from public.event_processing_markets market
  where market.id = p_market_id
    and market.is_enabled = true
  for update;

  if not found then
    return;
  end if;

  -- Count all currently leased harvest sources, including
  -- legacy claims, without relying on batch identity.
  select count(*)::integer
    into v_global_active
  from public.event_processing_work w
  where w.work_type = 'harvest_source'
    and w.status = 'leased'
    and w.leased_until > v_now;

  if v_global_active >= v_global_limit then
    return;
  end if;

  select count(*)::integer
    into v_market_active
  from public.event_processing_work w
  where w.market_id = p_market_id
    and w.work_type = 'harvest_source'
    and w.status = 'leased'
    and w.leased_until > v_now;

  if v_market_active >= v_market_limit then
    return;
  end if;

  -- Claim exactly one due, eligible, unlocked source.
  -- Eligibility and source-lock exclusion mirror the
  -- existing market claim RPC in migration 095.
  return query
  with selected as materialized (
    select w.id
    from public.event_processing_work w
    join public.event_harvest_sources src
      on src.id = w.source_id
    join public.event_processing_market_venues mv
      on mv.venue_id = src.venue_id
     and mv.market_id = p_market_id
    where w.market_id = p_market_id
      and w.work_type = 'harvest_source'
      and w.attempts < w.max_attempts
      and src.provider = 'first_party'
      and src.is_enabled = true
      and not exists (
        select 1
        from public.first_party_source_executions execution
        where execution.source_id = w.source_id
      )
      and (
        (
          w.status in ('pending', 'retry')
          and w.due_at <= v_now
        )
        or (
          w.status = 'leased'
          and w.leased_until <= v_now
        )
      )
    order by w.priority asc, w.due_at asc, w.id asc
    limit 1
    for update of w skip locked
  ),
  claimed as (
    update public.event_processing_work w
    set status = 'leased',
        batch_id = v_batch_id,
        lease_token = gen_random_uuid(),
        leased_until =
          v_now + make_interval(mins => p_lease_minutes),
        attempts = w.attempts + 1,
        last_started_at = v_now,
        last_finished_at = null,
        last_error = null,
        updated_at = v_now
    from selected s
    where w.id = s.id
    returning
      w.id,
      w.batch_id,
      w.lease_token,
      w.attempts,
      w.venue_id,
      w.source_id,
      w.leased_until
  )
  select
    c.id,
    c.batch_id,
    c.lease_token,
    c.attempts,
    c.venue_id,
    c.source_id,
    c.leased_until
  from claimed c;
end;
$claim_source$;

revoke all on function
  public.claim_shared_harvester_source(uuid, integer)
from public, anon, authenticated;

grant execute on function
  public.claim_shared_harvester_source(uuid, integer)
to service_role;

-- Durable source-level Workflow assignments.
-- A reservation can own multiple source execution slots.
-- Each slot has one immutable work/lease-token assignment.
-- Replaying the same slot returns its original assignment.

create table public.shared_harvester_source_assignments (
  reservation_id uuid not null
    references public.event_processing_dispatch_reservations(id)
    on delete restrict,

  slot_number integer not null
    check (slot_number >= 0),

  work_id uuid not null
    references public.event_processing_work(id)
    on delete restrict,

  lease_token uuid not null,
  claimed_batch_id uuid not null,
  claimed_attempt integer not null,
  claimed_venue_id uuid,
  claimed_source_id uuid,
  claimed_leased_until timestamptz not null,

  assigned_at timestamptz not null default now(),

  primary key (reservation_id, slot_number),

  unique (work_id, lease_token)
);

create index shared_harvester_source_assignments_work_idx
  on public.shared_harvester_source_assignments(work_id);

alter table public.shared_harvester_source_assignments
  enable row level security;

revoke all on public.shared_harvester_source_assignments
  from public, anon, authenticated;

grant select on public.shared_harvester_source_assignments
  to service_role;

-- This function serializes replay checks on the reservation.
-- It does not yet claim work: the source-claim RPC must be
-- integrated into this same transaction in the next patch.
-- Keeping this boundary explicit prevents a false claim
-- of atomic replay safety before integration.

create function public.get_shared_harvester_source_assignment(
  p_reservation_id uuid,
  p_slot_number integer
)
returns table (
  work_id uuid,
  lease_token uuid
)
language plpgsql
security definer
set search_path = ''
as $get_assignment$
begin
  if p_reservation_id is null
     or p_slot_number is null
     or p_slot_number < 0
  then
    raise exception 'Invalid shared source assignment arguments';
  end if;

  perform 1
  from public.event_processing_dispatch_reservations r
  where r.id = p_reservation_id
  for update;

  if not found then
    raise exception 'Shared reservation not found';
  end if;

  return query
  select a.work_id, a.lease_token
  from public.shared_harvester_source_assignments a
  where a.reservation_id = p_reservation_id
    and a.slot_number = p_slot_number;
end;
$get_assignment$;

revoke all on function
  public.get_shared_harvester_source_assignment(uuid, integer)
from public, anon, authenticated;

grant execute on function
  public.get_shared_harvester_source_assignment(uuid, integer)
to service_role;

-- Renew Workflow admission ownership between execution groups.
-- This never extends an individual source execution lease.
-- Lock ordering matches shared assignment: pool, reservation.
create function public.renew_shared_harvester_reservation(
  p_reservation_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $renew_reservation$
declare
  v_now timestamptz;
begin
  if p_reservation_id is null then
    return false;
  end if;

  perform 1
  from public.event_processing_pool_config
  where singleton = true
  for update;

  if not found then
    raise exception 'Shared pool configuration missing';
  end if;

  v_now := clock_timestamp();

  update public.event_processing_dispatch_reservations r
  set expires_at = v_now + interval '4 hours'
  where r.id = p_reservation_id
    and r.status in ('reserved', 'claimed')
    and r.expires_at > v_now;

  return found;
end;
$renew_reservation$;

revoke all on function
  public.renew_shared_harvester_reservation(uuid)
from public, anon, authenticated;

grant execute on function
  public.renew_shared_harvester_reservation(uuid)
to service_role;

-- Atomic reservation-scoped source assignment.
-- Replays return the original assignment, never a new claim.
-- The entire operation executes within one PostgreSQL transaction.

create function public.claim_shared_harvester_assignment(
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

  -- Reuse the source-level admission RPC in the same transaction.
  -- PostgreSQL function calls share the caller's transaction.
  select *
    into v_claim
  from public.claim_shared_harvester_source(
    v_reservation.market_id,
    180
  );

  if not found then
    return;
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

revoke all on function
  public.claim_shared_harvester_assignment(uuid, integer)
from public, anon, authenticated;

grant execute on function
  public.claim_shared_harvester_assignment(uuid, integer)
to service_role;


-- ============================================================
-- Coordinated legacy/shared harvester source admission.
--
-- Replaces only the existing batch-claim implementation.
-- Detector work keeps its original admission behavior.
-- Both harvester claim paths now lock the shared pool before
-- acquiring market locks and counting live source leases.
--
-- This does not enable shared scheduling or change cron.
-- ============================================================

create or replace function public.claim_event_processing_batch(
  p_market_id uuid,
  p_work_type text,
  p_lease_minutes integer default 30
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
as $$
declare
  v_market public.event_processing_markets%rowtype;
  v_now timestamptz := clock_timestamp();
  v_batch_id uuid := gen_random_uuid();
  v_batch_size integer;
  v_active_batches integer;
  v_global_source_limit integer;
  v_global_active_sources integer;
  v_market_active_sources integer;
begin
  if p_market_id is null
     or p_work_type not in (
       'detect_spot',
       'harvest_source'
     )
     or p_work_type is null
     or p_lease_minutes is null
     or p_lease_minutes not between 1 and 180
  then
    raise exception 'Invalid batch claim arguments';
  end if;

  -- Harvest-source claims share the global admission lock
  -- with the new source-level worker pool.
  --
  -- Detector claims retain their original market-only path.
  -- Global pool lock MUST precede the market row lock.
  if p_work_type = 'harvest_source' then
    select c.max_concurrent_sources
      into v_global_source_limit
    from public.event_processing_pool_config c
    where c.singleton = true
    for update;

    if not found then
      raise exception 'Shared pool configuration missing';
    end if;
  end if;

  -- Serializes batch admission within this market.
  select *
    into v_market
  from public.event_processing_markets
  where id = p_market_id
  for update;

  if not found then
    raise exception 'Market not found';
  end if;

  if not v_market.is_enabled then
    return;
  end if;

  v_batch_size :=
    case
      when p_work_type = 'harvest_source'
        then v_market.harvester_batch_size
      else v_market.detector_batch_size
    end;

  -- Expired leases that exhausted their attempt budget
  -- must not remain indefinitely in leased status.
  update public.event_processing_work w
  set status = 'failed',
      lease_token = null,
      leased_until = null,
      batch_id = null,
      last_finished_at = v_now,
      last_error = coalesce(
        w.last_error,
        'Lease expired after maximum attempts'
      ),
      updated_at = v_now
  where w.market_id = p_market_id
    and w.status = 'leased'
    and w.leased_until <= v_now
    and w.attempts >= w.max_attempts
    and (
      w.work_type <> 'harvest_source'
      or not exists (
        select 1
        from public.first_party_source_executions execution
        where execution.source_id = w.source_id
      )
    );

  -- Count distinct live batches across ALL work types.
  -- An expired batch does not consume capacity.
  select count(distinct w.batch_id)::integer
    into v_active_batches
  from public.event_processing_work w
  where w.market_id = p_market_id
    and w.status = 'leased'
    and w.leased_until > v_now
    and w.batch_id is not null;

  if v_active_batches >= v_market.max_concurrent_batches then
    return;
  end if;

  -- Legacy harvester batches must obey the same live-source
  -- ceiling as shared source-level claims. Detector capacity
  -- remains governed by its existing batch rules.
  if p_work_type = 'harvest_source' then
    v_now := clock_timestamp();

    select count(*)::integer
      into v_global_active_sources
    from public.event_processing_work w
    where w.work_type = 'harvest_source'
      and w.status = 'leased'
      and w.leased_until > v_now;

    select count(*)::integer
      into v_market_active_sources
    from public.event_processing_work w
    where w.market_id = p_market_id
      and w.work_type = 'harvest_source'
      and w.status = 'leased'
      and w.leased_until > v_now;

    v_batch_size := least(
      v_batch_size,
      greatest(
        0,
        v_global_source_limit - v_global_active_sources
      ),
      greatest(
        0,
        v_market.max_concurrent_sources
          - v_market_active_sources
      )
    );

    if v_batch_size <= 0 then
      return;
    end if;
  end if;

  -- Row locks prevent overlapping claims, even when
  -- another process is finishing an individual work item.
  return query
  with selected as materialized (
    select w.id
    from public.event_processing_work w
    where w.market_id = p_market_id
      and w.work_type = p_work_type
      and w.attempts < w.max_attempts
      and (
        (
          p_work_type = 'detect_spot'
          and exists (
            select 1
            from public.event_processing_market_venues mv
            join public.venues v
              on v.id = mv.venue_id
            where mv.venue_id = w.venue_id
              and mv.market_id = p_market_id
              and v.status = 'active'
              and not exists (
                select 1
                from public.event_harvest_archive a
                where a.venue_id = v.id
                  and a.restored_at is null
              )
          )
        )
        or (
          p_work_type = 'harvest_source'
          and exists (
            select 1
            from public.event_harvest_sources src
            join public.event_processing_market_venues mv
              on mv.venue_id = src.venue_id
            where src.id = w.source_id
              and src.provider = 'first_party'
              and src.is_enabled = true
              and mv.market_id = p_market_id
          )
        )
      )
      and (
        (
          w.status in ('pending', 'retry')
          and w.due_at <= v_now
          and (
            w.work_type <> 'harvest_source'
            or not exists (
              select 1
              from public.first_party_source_executions execution
              where execution.source_id = w.source_id
            )
          )
        )
        or (
          w.status = 'leased'
          and w.leased_until <= v_now
          and (
            w.work_type <> 'harvest_source'
            or not exists (
              select 1
              from public.first_party_source_executions execution
              where execution.source_id = w.source_id
            )
          )
        )
      )
    order by w.priority asc, w.due_at asc, w.id asc
    limit v_batch_size
    for update skip locked
  ),
  claimed as (
    update public.event_processing_work w
    set status = 'leased',
        batch_id = v_batch_id,
        lease_token = gen_random_uuid(),
        leased_until =
          v_now + make_interval(mins => p_lease_minutes),
        attempts = w.attempts + 1,
        last_started_at = v_now,
        last_finished_at = null,
        last_error = null,
        updated_at = v_now
    from selected s
    where w.id = s.id
    returning
      w.id,
      w.batch_id,
      w.lease_token,
      w.attempts,
      w.venue_id,
      w.source_id,
      w.leased_until
  )
  select
    c.id,
    c.batch_id,
    c.lease_token,
    c.attempts,
    c.venue_id,
    c.source_id,
    c.leased_until
  from claimed c;
end;
$$;

revoke all on function
  public.claim_event_processing_batch(uuid, text, integer)
from public, anon, authenticated;

grant execute on function
  public.claim_event_processing_batch(uuid, text, integer)
to service_role;


-- TRANSPORT CAPACITY PERMITS V1
--
-- Independent, globally coordinated transport capacity.
-- These permits do not replace source execution locks or leases.
-- All acquisition and renewal operations serialize on the
-- singleton pool configuration row.


create table public.event_processing_transport_acquisition_cancellations (
  acquisition_key uuid primary key,
  transport_kind text not null
    check (transport_kind in ('http', 'browser', 'recovery')),
  source_id uuid,
  canceled_at timestamptz not null default clock_timestamp()
);

alter table public.event_processing_transport_acquisition_cancellations
  enable row level security;

revoke all on public.event_processing_transport_acquisition_cancellations
  from public, anon, authenticated;

grant select, insert
  on public.event_processing_transport_acquisition_cancellations
  to service_role;

create table public.event_processing_transport_permits (
  id uuid primary key default gen_random_uuid(),
  transport_kind text not null
    check (transport_kind in ('http', 'browser', 'recovery')),
  acquisition_key uuid not null unique,
  owner_token uuid not null default gen_random_uuid(),
  source_id uuid,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  released_at timestamptz,
  constraint transport_permit_expiry_valid
    check (expires_at > acquired_at)
);

create index event_processing_transport_permits_active_idx
  on public.event_processing_transport_permits
    (transport_kind, expires_at)
  where released_at is null;

alter table public.event_processing_transport_permits
  enable row level security;

revoke all on public.event_processing_transport_permits
  from public, anon, authenticated;

grant select, insert, update, delete
  on public.event_processing_transport_permits
  to service_role;


create function public.acquire_event_processing_transport_permit(
  p_transport_kind text,
  p_source_id uuid default null,
  p_lease_seconds integer default 120,
  p_acquisition_key uuid default null
)
returns table (
  permit_id uuid,
  permit_token uuid,
  permit_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_config public.event_processing_pool_config%rowtype;
  v_limit integer;
  v_active integer;
  v_id uuid;
  v_token uuid;
  v_expires timestamptz;
  v_existing public.event_processing_transport_permits%rowtype;
begin
  if p_acquisition_key is null then
    raise exception 'Transport acquisition key is required';
  end if;
  if p_transport_kind not in ('http', 'browser', 'recovery')
     or p_transport_kind is null then
    raise exception 'Invalid transport kind';
  end if;

  if p_lease_seconds not between 30 and 3600
     or p_lease_seconds is null then
    raise exception 'Invalid transport permit lease duration';
  end if;

  select *
  into strict v_config
  from public.event_processing_pool_config
  where singleton = true
  for update;

  /*
   * Cancellation is durable. A cleanup that reaches PostgreSQL
   * before an earlier acquisition prevents that acquisition from
   * granting capacity later.
   */
  if exists (
    select 1
    from public.event_processing_transport_acquisition_cancellations
    where acquisition_key = p_acquisition_key
  ) then
    return;
  end if;

  /*
   * The pool configuration row serializes all acquisition attempts.
   * A retry with the same key must never reserve a second permit.
   *
   * An expired or released acquisition is terminal: it cannot be
   * resurrected by a delayed retry using the same identity.
   */
  select *
  into v_existing
  from public.event_processing_transport_permits
  where acquisition_key = p_acquisition_key;

  if found then
    if v_existing.transport_kind <> p_transport_kind
       or v_existing.source_id is distinct from p_source_id then
      raise exception 'Transport acquisition key reused with different scope';
    end if;

    if v_existing.released_at is null
       and v_existing.expires_at > clock_timestamp() then
      permit_id := v_existing.id;
      permit_token := v_existing.owner_token;
      permit_expires_at := v_existing.expires_at;
      return next;
    end if;

    return;
  end if;

  select count(*)::integer
  into v_active
  from public.event_processing_transport_permits
  where transport_kind = p_transport_kind
    and released_at is null
    and expires_at > clock_timestamp();

  v_limit := case p_transport_kind
    when 'http' then v_config.max_http_sources
    when 'browser' then v_config.max_browser_sources
    when 'recovery' then v_config.max_recovery_sources
  end;

  if v_active >= v_limit then
    return;
  end if;

  insert into public.event_processing_transport_permits (
    transport_kind,
    source_id,
    acquisition_key,
    expires_at
  )
  values (
    p_transport_kind,
    p_source_id,
    p_acquisition_key,
    clock_timestamp() + make_interval(secs => p_lease_seconds)
  )
  returning id, owner_token, expires_at
  into v_id, v_token, v_expires;

  permit_id := v_id;
  permit_token := v_token;
  permit_expires_at := v_expires;
  return next;
end;
$$;


create function public.renew_event_processing_transport_permit(
  p_permit_id uuid,
  p_permit_token uuid,
  p_lease_seconds integer default 120
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_renewed uuid;
begin
  if p_lease_seconds not between 30 and 3600
     or p_lease_seconds is null then
    raise exception 'Invalid transport permit lease duration';
  end if;

  perform 1
  from public.event_processing_pool_config
  where singleton = true
  for update;

  update public.event_processing_transport_permits
  set expires_at =
    clock_timestamp() + make_interval(secs => p_lease_seconds)
  where id = p_permit_id
    and owner_token = p_permit_token
    and released_at is null
    and expires_at > clock_timestamp()
  returning id into v_renewed;

  return v_renewed is not null;
end;
$$;


create function public.release_event_processing_transport_permit(
  p_permit_id uuid,
  p_permit_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_released uuid;
begin
  perform 1
  from public.event_processing_pool_config
  where singleton = true
  for update;

  update public.event_processing_transport_permits
  set released_at = clock_timestamp()
  where id = p_permit_id
    and owner_token = p_permit_token
    and released_at is null
  returning id into v_released;

  return v_released is not null;
end;
$$;


revoke all on function
  public.acquire_event_processing_transport_permit(text, uuid, integer, uuid)
  from public, anon, authenticated;

revoke all on function
  public.renew_event_processing_transport_permit(uuid, uuid, integer)
  from public, anon, authenticated;

revoke all on function
  public.release_event_processing_transport_permit(uuid, uuid)
  from public, anon, authenticated;

grant execute on function
  public.acquire_event_processing_transport_permit(text, uuid, integer, uuid)
  to service_role;

grant execute on function
  public.renew_event_processing_transport_permit(uuid, uuid, integer)
  to service_role;

grant execute on function
  public.release_event_processing_transport_permit(uuid, uuid)
  to service_role;

create function public.release_event_processing_transport_acquisition(
  p_acquisition_key uuid,
  p_transport_kind text,
  p_source_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_released uuid;
begin
  if p_acquisition_key is null then
    raise exception 'Transport acquisition key is required';
  end if;

  if p_transport_kind not in ('http', 'browser', 'recovery')
     or p_transport_kind is null then
    raise exception 'Invalid transport kind';
  end if;

  /*
   * Serialize cleanup against acquisition and renewal.
   * An acquisition still waiting on this lock cannot commit
   * ahead of cleanup unnoticed.
   */
  perform 1
  from public.event_processing_pool_config
  where singleton = true
  for update;

  insert into
    public.event_processing_transport_acquisition_cancellations (
      acquisition_key,
      transport_kind,
      source_id
    )
  values (
    p_acquisition_key,
    p_transport_kind,
    p_source_id
  )
  on conflict (acquisition_key) do nothing;

  if exists (
    select 1
    from public.event_processing_transport_acquisition_cancellations
    where acquisition_key = p_acquisition_key
      and (
        transport_kind <> p_transport_kind
        or source_id is distinct from p_source_id
      )
  ) then
    raise exception
      'Transport acquisition cancellation key reused with different scope';
  end if;

  update public.event_processing_transport_permits
  set released_at = clock_timestamp()
  where acquisition_key = p_acquisition_key
    and transport_kind = p_transport_kind
    and source_id is not distinct from p_source_id
    and released_at is null
  returning id into v_released;

  return v_released is not null;
end;
$$;

revoke all on function
  public.release_event_processing_transport_acquisition(
    uuid, text, uuid
  )
  from public, anon, authenticated;

grant execute on function
  public.release_event_processing_transport_acquisition(
    uuid, text, uuid
  )
  to service_role;
