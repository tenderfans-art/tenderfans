-- 110: Route EXISTING approved shared publisher sources into Market scheduling.
-- No additional dispatcher, worker pool, adapter, validation or attribution.
-- NULL venue_id sources still publish to Spots via event-level attribution.
-- The source -> market association is only for scheduling ONE source run.
-- Guard the confirmed 102/5 Pinellas baseline against unexpected changes.
begin;

create table public.event_processing_shared_source_markets (
  source_id uuid primary key
    references public.event_harvest_sources(id) on delete cascade,
  market_id uuid not null
    references public.event_processing_markets(id) on delete restrict,
  assigned_at timestamptz not null default now()
);

create index event_processing_shared_source_market_idx
  on public.event_processing_shared_source_markets(market_id, source_id);
alter table public.event_processing_shared_source_markets
  enable row level security;
revoke all on public.event_processing_shared_source_markets
  from public, anon, authenticated;
grant select, insert, update, delete
  on public.event_processing_shared_source_markets to service_role;

-- One-time routing backfill. No source/event modifications.
do $cohort$
declare
  v_facebook integer;
  v_woocommerce integer;
begin
  if not exists (
    select 1 from public.event_processing_markets
    where market_key = 'pinellas-county'
  ) then
    raise exception 'Pinellas Market absent; refusing source backfill';
  end if;
  select
    count(*) filter (where source_type = 'facebook_events'),
    count(*) filter (where source_type = 'woocommerce_events')
  into v_facebook, v_woocommerce
  from public.event_harvest_sources
  where provider = 'first_party'
    and venue_id is null
    and is_enabled = true
    and source_type in ('facebook_events', 'woocommerce_events');
  if v_facebook <> 102 or v_woocommerce <> 5 then
    raise exception 'Shared publisher cohort changed: Facebook %, WooCommerce %; expected 102/5',
      v_facebook, v_woocommerce;
  end if;
end;
$cohort$;

insert into public.event_processing_shared_source_markets (
  source_id, market_id
)
select s.id, m.id
from public.event_harvest_sources s
cross join public.event_processing_markets m
where s.provider = 'first_party'
  and s.venue_id is null
  and s.is_enabled = true
  and s.source_type in ('facebook_events', 'woocommerce_events')
  and m.market_key = 'pinellas-county'
on conflict (source_id) do nothing;

-- Central eligibility predicate: Spot-bound sources follow Spot membership;
-- NULL-venue publisher sources follow their explicit scheduling assignment.
-- Registered-source approval is STILL the existing provider/is_enabled gate.
create function public.event_processing_source_in_market(
  p_source_id uuid, p_market_id uuid
)
returns boolean
language sql stable security definer
set search_path = ''
as $source_scope$
  select exists (
    select 1
    from public.event_harvest_sources s
    where s.id = p_source_id
      and (
        exists (
          select 1 from public.event_processing_market_venues mv
          where mv.venue_id = s.venue_id
            and mv.market_id = p_market_id
        )
        or (
          s.venue_id is null
          and exists (
            select 1 from public.event_processing_shared_source_markets link
            where link.source_id = s.id
              and link.market_id = p_market_id
          )
        )
      )
  );
$source_scope$;
revoke all on function
  public.event_processing_source_in_market(uuid, uuid)
from public, anon, authenticated;
grant execute on function
  public.event_processing_source_in_market(uuid, uuid)
to service_role;

-- Only source/Market eligibility joins change below; original claim,
-- reservation, capacity, retry, lease, and disabled Market logic is intact.

create or replace function public.enqueue_due_market_processing(
  p_market_id uuid default null
)
returns table (
  out_market_id uuid,
  detector_queued integer,
  source_queued integer
)
language plpgsql
security definer
set search_path = ''
as $queue$
declare
  m record;
  v_now timestamptz := clock_timestamp();
  v_detectors integer;
  v_sources integer;
begin
  -- Market locking serializes queue generation.
  -- Disabled Markets receive no new work.
  for m in
    select *
    from public.event_processing_markets
    where is_enabled = true
      and (
        p_market_id is null
        or id = p_market_id
      )
    order by id
    for update
  loop

    -- Use the existing active/non-archived Spot criteria.
    insert into public.event_processing_work (
      market_id,
      work_type,
      venue_id,
      due_at
    )
    select
      m.id,
      'detect_spot',
      v.id,
      v_now
    from public.event_processing_market_venues mv
    join public.venues v
      on v.id = mv.venue_id
    where mv.market_id = m.id
      and v.status = 'active'
      and nullif(trim(v.website_url), '') is not null
      and not exists (
        select 1
        from public.event_harvest_archive a
        where a.venue_id = v.id
          and a.restored_at is null
      )
      and not exists (
        select 1
        from public.event_processing_work w
        where w.work_type = 'detect_spot'
          and w.venue_id = v.id
          and (
            w.status in ('pending', 'retry', 'leased')
            or (
              w.status in ('completed', 'failed')
              and coalesce(
                w.last_finished_at,
                w.created_at
              ) > v_now - make_interval(
                mins => m.detector_interval_minutes
              )
            )
          )
      )
    on conflict do nothing;

    get diagnostics v_detectors = row_count;

    -- Enqueue enabled Spot-owned first-party sources.
    -- Global shared publishers retain their existing identity;
    -- their Market admission requires a separate routing lane.
    insert into public.event_processing_work (
      market_id,
      work_type,
      source_id,
      due_at
    )
    select
      m.id,
      'harvest_source',
      s.id,
      v_now
    from public.event_harvest_sources s
    left join public.venues v
      on v.id = s.venue_id
    where public.event_processing_source_in_market(s.id, m.id)
      and s.provider = 'first_party'
      and s.is_enabled = true
      and (
        s.venue_id is null
        or (
          v.status = 'active'
          and not exists (
            select 1
            from public.event_harvest_archive a
            where a.venue_id = v.id
              and a.restored_at is null
          )
        )
      )
      and not exists (
        select 1
        from public.event_processing_work w
        where w.work_type = 'harvest_source'
          and w.source_id = s.id
          and (
            w.status in ('pending', 'retry', 'leased')
            or (
              w.status in ('completed', 'failed')
              and coalesce(
                w.last_finished_at,
                w.created_at
              ) > v_now - make_interval(
                mins => m.harvester_interval_minutes
              )
            )
          )
      )
    on conflict do nothing;

    get diagnostics v_sources = row_count;

    out_market_id := m.id;
    detector_queued := v_detectors;
    source_queued := v_sources;

    return next;
  end loop;
end;
$queue$;

-- Existing 099 shared admission

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

-- Existing 099 shared source claim

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

-- Existing 099 coordinated legacy claim

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
            where src.id = w.source_id
              and src.provider = 'first_party'
              and src.is_enabled = true
              and public.event_processing_source_in_market(src.id, p_market_id)
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

commit;
