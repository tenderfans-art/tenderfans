-- 112: Demand-driven Market overflow on the existing pool.
--
-- Standard Market source allocation stays at 16.
-- Borrowed capacity is optional and bounded.
-- The shared global pool and transport limits remain authoritative.
-- No Market activation, source rewriting or cron changes.
--
-- Existing global pool/Market locks serialize admission.
-- Borrowing never preempts a running source execution.
-- A waiting Market below its standard source allocation
-- takes priority over another Market requesting overflow.
--
-- The initial overload signal is an eligible backlog
-- waiting at least 30 minutes while the Market's standard
-- 16-source allocation is fully occupied.
-- Later measurement-based forecasting can refine that policy.
--
-- These are logical allocations, not dedicated worker processes.

begin;

alter table public.event_processing_markets
  add column max_borrowed_sources integer not null
    default 16
    check (max_borrowed_sources between 0 and 128),
  add column max_borrowed_workflows integer not null
    default 2
    check (max_borrowed_workflows between 0 and 20),
  add column overflow_queue_wait_minutes integer not null
    default 30
    check (overflow_queue_wait_minutes between 0 and 10080);

comment on column
  public.event_processing_markets.max_concurrent_sources
is 'Standard Market source allocation, initially 16. '
   'Borrowing requires verified idle global capacity '
   'and gives priority to other Markets below baseline.';

comment on column
  public.event_processing_markets.max_borrowed_sources
is 'Maximum additional source slots obtainable from spare '
   'global capacity while no other enabled Market has '
   'eligible work waiting below its standard allocation.';

comment on column
  public.event_processing_markets.max_borrowed_workflows
is 'Maximum extra shared Workflows for justified overflow. '
   'The global Workflow ceiling remains authoritative.';

-- Shared admission entitlement, not a second dispatcher.
--
-- Called only by the existing reservation and source
-- admission functions while they hold the global pool lock.
-- This function does not itself claim or modify work.
create or replace function
  public.market_shared_harvester_entitlement(
    p_market_id uuid
  )
returns table (
  allowed_sources integer,
  allowed_workflows integer
)
language plpgsql
security definer
set search_path = ''
as $entitlement$
declare
  v_market record;
  v_pool record;
  v_now timestamptz := clock_timestamp();
  v_active_sources integer;
  v_oldest_due timestamptz;
begin
  select *
    into v_market
  from public.event_processing_markets m
  where m.id = p_market_id
    and m.is_enabled = true;

  if not found then
    return;
  end if;

  select
    c.max_concurrent_sources,
    c.max_concurrent_batches
  into v_pool
  from public.event_processing_pool_config c
  where c.singleton = true;

  if not found then
    raise exception 'Shared pool configuration missing';
  end if;

  -- Every enabled Market begins with its standard allocation.
  allowed_sources := v_market.max_concurrent_sources;
  allowed_workflows := v_market.max_concurrent_batches;

  -- No lending when configured infrastructure cannot
  -- exceed this Market's standard allocation.
  if v_market.max_borrowed_sources = 0
     or v_market.max_borrowed_workflows = 0
     or v_pool.max_concurrent_sources <= allowed_sources
     or v_pool.max_concurrent_batches <= allowed_workflows
  then
    return next;
    return;
  end if;

  select count(*)::integer
    into v_active_sources
  from public.event_processing_work w
  where w.market_id = p_market_id
    and w.work_type = 'harvest_source'
    and w.status = 'leased'
    and w.leased_until > v_now;

  -- A Market cannot borrow while its normal desks
  -- are still available.
  if v_active_sources < allowed_sources then
    return next;
    return;
  end if;

  -- Count only eligible first-party work that the original
  -- Market routing and source locks would allow to run.
  select min(w.due_at)
    into v_oldest_due
  from public.event_processing_work w
  join public.event_harvest_sources s
    on s.id = w.source_id
  where w.market_id = p_market_id
    and w.work_type = 'harvest_source'
    and w.attempts < w.max_attempts
    and s.provider = 'first_party'
    and s.is_enabled = true
    and public.event_processing_source_in_market(
      s.id, p_market_id
    )
    and (
      (w.status in ('pending', 'retry')
       and w.due_at <= v_now)
      or
      (w.status = 'leased'
       and w.leased_until <= v_now)
    )
    and not exists (
      select 1
      from public.first_party_source_executions e
      where e.source_id = w.source_id
    );

  if v_oldest_due is null
     or v_oldest_due > v_now - make_interval(
       mins => v_market.overflow_queue_wait_minutes
     )
  then
    return next;
    return;
  end if;

  -- A Market requesting its standard allocation outranks
  -- another Market seeking borrowed capacity.
  -- No active worker is interrupted; future claims are gated.
  if exists (
    select 1
    from public.event_processing_markets other_market
    where other_market.id <> p_market_id
      and other_market.is_enabled = true
      and (
        select count(*)::integer
        from public.event_processing_work live
        where live.market_id = other_market.id
          and live.work_type = 'harvest_source'
          and live.status = 'leased'
          and live.leased_until > v_now
      ) < other_market.max_concurrent_sources
      and exists (
        select 1
        from public.event_processing_work waiting
        join public.event_harvest_sources s
          on s.id = waiting.source_id
        where waiting.market_id = other_market.id
          and waiting.work_type = 'harvest_source'
          and waiting.attempts < waiting.max_attempts
          and s.provider = 'first_party'
          and s.is_enabled = true
          and public.event_processing_source_in_market(
            s.id, other_market.id
          )
          and (
            (waiting.status in ('pending', 'retry')
             and waiting.due_at <= v_now)
            or
            (waiting.status = 'leased'
             and waiting.leased_until <= v_now)
          )
          and not exists (
            select 1
            from public.first_party_source_executions e
            where e.source_id = waiting.source_id
          )
      )
  ) then
    return next;
    return;
  end if;

  -- Spare fleet capacity may be borrowed, never exceeding
  -- the configured global or per-Market overflow ceilings.
  allowed_sources := least(
    v_pool.max_concurrent_sources,
    v_market.max_concurrent_sources
      + v_market.max_borrowed_sources
  );

  allowed_workflows := least(
    v_pool.max_concurrent_batches,
    v_market.max_concurrent_batches
      + v_market.max_borrowed_workflows
  );

  return next;
end;
$entitlement$;

revoke all on function
  public.market_shared_harvester_entitlement(uuid)
from public, anon, authenticated;

-- Existing shared reservation admission, with entitlement.
create or replace function public.reserve_shared_harvester_batch()
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
    where w.market_id = m.id
      and public.event_processing_source_in_market(s.id, m.id)
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
  join lateral public.market_shared_harvester_entitlement(
    m.id
  ) entitlement on true
  where m.is_enabled = true
    and coalesce(active_sources.n, 0)
      < entitlement.allowed_sources
    and coalesce(active_workflows.n, 0)
      < entitlement.allowed_workflows
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

-- Existing shared source admission, with entitlement.
create or replace function public.claim_shared_harvester_source(
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
  -- Preserve the original Market row lock.
  perform 1
  from public.event_processing_markets market
  where market.id = p_market_id
    and market.is_enabled = true
  for update;

  if not found then
    return;
  end if;

  -- Standard or borrowed capacity is evaluated atomically
  -- under the existing global pool admission lock.
  select entitlement.allowed_sources
    into v_market_limit
  from public.market_shared_harvester_entitlement(
    p_market_id
  ) entitlement;

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
    where w.market_id = p_market_id
      and w.work_type = 'harvest_source'
      and w.attempts < w.max_attempts
      and src.provider = 'first_party'
      and src.is_enabled = true
      and public.event_processing_source_in_market(src.id, p_market_id)
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

commit;
