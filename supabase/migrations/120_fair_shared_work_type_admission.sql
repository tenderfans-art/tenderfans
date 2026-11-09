-- 120: Fair work-type selection within existing Market admission.
-- Preserve the global pool, original lease/assignment lifecycle,
-- Market fairness, provider exclusivity and eligibility.
-- Does not activate Markets, alter capacities or touch work rows.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '90s';

-- Indexed historical selection for each eligible work type.
create index
  event_processing_reservation_market_type_history_idx
on public.event_processing_dispatch_reservations
  (market_id, work_type, reserved_at desc);

create or replace function public.reserve_shared_harvester_batch_scoped(p_requested_market_id uuid)
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
  v_legacy_workflows integer;
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

  -- Existing direct Market batches also occupy Workflow
  -- capacity. Do not count each durable shared assignment
  -- as an independent legacy batch.
  select count(*)::integer
    into v_legacy_workflows
  from (
    select distinct w.market_id, w.batch_id
    from public.event_processing_work w
    where w.work_type in ('harvest_source', 'detect_spot', 'archive_recheck', 'harvest_provider')
      and w.status = 'leased'
      and w.leased_until > v_now
      and w.batch_id is not null
      and not exists (
        select 1
        from public.shared_harvester_source_assignments a
        where a.work_id = w.id
          and a.lease_token = w.lease_token
      )
  ) legacy;

  v_live_workflows := v_live_workflows + v_legacy_workflows;

  if v_live_workflows >= v_workflow_limit then
    return;
  end if;

  -- Source capacity includes legacy market work.
  select count(*)::integer
    into v_live_sources
  from public.event_processing_work w
  where w.work_type in ('harvest_source', 'detect_spot', 'archive_recheck', 'harvest_provider')
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
    m.market_key,
    eligible.work_type
  into v_market
  from public.event_processing_markets m
  join lateral (
    select w.work_type, min(w.due_at) as oldest_due
    from public.event_processing_work w
    where w.market_id = m.id
      and w.work_type in ('harvest_source', 'detect_spot', 'archive_recheck', 'harvest_provider')
      and w.attempts < w.max_attempts
      -- One Ticketmaster provider execution globally.
      -- Count both pending reservations and live provider leases.
      and (
        w.work_type <> 'harvest_provider'
        or (
          not exists (
            select 1
            from public.event_processing_dispatch_reservations pr
            where pr.work_type = 'harvest_provider'
              and pr.status in ('reserved', 'claimed')
              and pr.expires_at > v_now
          )
          and not exists (
            select 1
            from public.event_processing_work pw
            where pw.work_type = 'harvest_provider'
              and pw.status = 'leased'
              and pw.leased_until > v_now
          )
        )
      )
      and (
      (w.status in ('pending', 'retry')
       and w.due_at <= v_now)
      or
      (w.status = 'leased'
       and w.leased_until <= v_now)
    )
      and public.shared_market_work_eligible(m.id, w.work_type, w.venue_id, w.source_id, v_now)
    group by w.work_type
  ) eligible on true
  left join lateral (
    select count(*)::integer as n
    from public.event_processing_work w
    where w.market_id = m.id
      and w.work_type in ('harvest_source', 'detect_spot', 'archive_recheck', 'harvest_provider')
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
  -- Fair work-type admission inside each Market.
  -- A recently selected type yields to other ready types.
  left join lateral (
    select max(r.reserved_at) as last_type_reserved
    from public.event_processing_dispatch_reservations r
    where r.market_id = m.id
      and r.work_type = eligible.work_type
  ) type_history on true
  join lateral public.market_shared_harvester_entitlement(
    m.id
  ) entitlement on true
  where m.is_enabled = true
    and (p_requested_market_id is null or m.id = p_requested_market_id)
    and coalesce(active_sources.n, 0)
      < entitlement.allowed_sources
    and coalesce(active_workflows.n, 0)
      < entitlement.allowed_workflows
  order by
    -- Preserve the existing Market-first fairness policy.
    history.last_reserved asc nulls first,
    -- Within a Market, give the least-recently-served
    -- eligible work type the next reservation.
    type_history.last_type_reserved asc nulls first,
    -- Existing queue age remains the next priority.
    eligible.oldest_due asc,
    m.id asc,
    -- Deterministic final tie breaker.
    eligible.work_type asc
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
    v_market.work_type,
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

commit;
