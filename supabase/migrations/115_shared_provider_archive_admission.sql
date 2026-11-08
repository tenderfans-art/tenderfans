-- 115: Provider/archive admission into the existing shared pool.
-- No Market activation or legacy cron changes.
begin;

alter table public.event_processing_dispatch_reservations
  drop constraint event_processing_dispatch_reservations_work_type_check;
alter table public.event_processing_dispatch_reservations
  add constraint event_processing_dispatch_reservations_work_type_check
  check (work_type in (
    'harvest_source', 'detect_spot',
    'archive_recheck', 'harvest_provider'
  ));


-- One eligibility contract shared by entitlement, reservation
-- discovery and durable assignment claims.
-- Original source/detector rules are preserved.
create function public.shared_market_work_eligible(
  p_market_id uuid,
  p_work_type text,
  p_venue_id uuid,
  p_source_id uuid,
  p_now timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $eligible$
  select case
    when p_work_type = 'harvest_source' then exists (
      select 1
      from public.event_harvest_sources src
      where src.id = p_source_id
        and src.provider = 'first_party'
        and src.is_enabled = true
        and public.event_processing_source_in_market(
          src.id, p_market_id
        )
        and not exists (
          select 1
          from public.first_party_source_executions e
          where e.source_id = src.id
        )
    )

    when p_work_type = 'detect_spot' then exists (
      select 1
      from public.event_processing_market_venues mv
      join public.venues v on v.id = mv.venue_id
      where mv.market_id = p_market_id
        and mv.venue_id = p_venue_id
        and v.status = 'active'
        and nullif(trim(v.website_url), '') is not null
        and not exists (
          select 1
          from public.event_harvest_archive a
          where a.venue_id = v.id
            and a.restored_at is null
        )
    )

    when p_work_type = 'archive_recheck' then exists (
      select 1
      from public.event_harvest_archive a
      join public.venues v on v.id = a.venue_id
      join public.event_processing_market_venues mv
        on mv.venue_id = a.venue_id
      where a.venue_id = p_venue_id
        and mv.market_id = p_market_id
        and a.restored_at is null
        and a.next_check_at <= p_now
        and v.status = 'active'
        and nullif(trim(v.website_url), '') is not null
    )

    when p_work_type = 'harvest_provider' then
      exists (
        select 1
        from public.event_harvest_sources src
        where src.provider = 'ticketmaster'
          and src.external_source_id = 'discovery-v2'
          and src.is_enabled = true
      )
      and exists (
        select 1
        from public.event_processing_market_venues mv
        join public.venues v on v.id = mv.venue_id
        where mv.market_id = p_market_id
          and v.status = 'active'
      )

    else false
  end;
$eligible$;

revoke all on function
  public.shared_market_work_eligible(
    uuid,text,uuid,uuid,timestamptz
  )
from public, anon, authenticated;

grant execute on function
  public.shared_market_work_eligible(
    uuid,text,uuid,uuid,timestamptz
  )
to service_role;



-- Add provider/archive work to the SAME Market work table.
-- No independent dispatcher or worker pool.
create function public.enqueue_due_market_supplemental_processing(
  p_market_id uuid default null
)
returns table (
  out_market_id uuid,
  provider_queued integer,
  archive_queued integer
)
language plpgsql
security definer
set search_path = ''
as $supplemental_queue$
declare
  m record;
  v_now timestamptz := clock_timestamp();
  v_provider integer;
  v_archive integer;
begin
  for m in
    select *
    from public.event_processing_markets
    where is_enabled = true
      and (p_market_id is null or id = p_market_id)
    order by id
    for update
  loop
    -- One Market-scoped provider pass on the normal
    -- harvester interval. The claim system serializes
    -- Ticketmaster executions across all Markets.
    insert into public.event_processing_work (
      market_id, work_type, due_at
    )
    select m.id, 'harvest_provider', v_now
    where exists (
      select 1
      from public.event_harvest_sources src
      where src.provider = 'ticketmaster'
        and src.external_source_id = 'discovery-v2'
        and src.is_enabled = true
    )
      and exists (
        select 1
        from public.event_processing_market_venues mv
        join public.venues v on v.id = mv.venue_id
        where mv.market_id = m.id
          and v.status = 'active'
      )
      and not exists (
        select 1
        from public.event_processing_work w
        where w.work_type = 'harvest_provider'
          and w.market_id = m.id
          and (
            w.status in ('pending', 'retry', 'leased')
            or (
              w.status in ('completed', 'failed')
              and coalesce(w.last_finished_at, w.created_at)
                > v_now - make_interval(
                  mins => m.harvester_interval_minutes
                )
            )
          )
      )
    on conflict do nothing;

    get diagnostics v_provider = row_count;

    -- Existing archive.next_check_at remains authoritative.
    insert into public.event_processing_work (
      market_id, work_type, venue_id, due_at
    )
    select
      m.id, 'archive_recheck', a.venue_id, a.next_check_at
    from public.event_harvest_archive a
    join public.event_processing_market_venues mv
      on mv.venue_id = a.venue_id
    join public.venues v on v.id = a.venue_id
    where mv.market_id = m.id
      and a.restored_at is null
      and a.next_check_at <= v_now
      and v.status = 'active'
      and nullif(trim(v.website_url), '') is not null
      and not exists (
        select 1
        from public.event_processing_work w
        where w.work_type = 'archive_recheck'
          and w.venue_id = a.venue_id
          and (
            w.status in ('pending', 'retry', 'leased')
            or (
              w.status in ('completed', 'failed')
              and coalesce(w.last_finished_at, w.created_at)
                > v_now - interval '1 hour'
            )
          )
      )
    on conflict do nothing;

    get diagnostics v_archive = row_count;

    out_market_id := m.id;
    provider_queued := v_provider;
    archive_queued := v_archive;
    return next;
  end loop;
end;
$supplemental_queue$;

revoke all on function
  public.enqueue_due_market_supplemental_processing(uuid)
from public, anon, authenticated;

grant execute on function
  public.enqueue_due_market_supplemental_processing(uuid)
to service_role;


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
    and w.work_type in ('harvest_source', 'detect_spot', 'archive_recheck', 'harvest_provider')
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
  where w.market_id = p_market_id
    and w.work_type in ('harvest_source', 'detect_spot', 'archive_recheck', 'harvest_provider')
    and w.attempts < w.max_attempts
    and (
      (w.status in ('pending', 'retry')
       and w.due_at <= v_now)
      or
      (w.status = 'leased'
       and w.leased_until <= v_now)
    )
    and public.shared_market_work_eligible(p_market_id, w.work_type, w.venue_id, w.source_id, v_now);

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
          and live.work_type in ('harvest_source', 'detect_spot', 'archive_recheck', 'harvest_provider')
          and live.status = 'leased'
          and live.leased_until > v_now
      ) < other_market.max_concurrent_sources
      and exists (
        select 1
        from public.event_processing_work waiting
        where waiting.market_id = other_market.id
          and waiting.work_type in ('harvest_source', 'detect_spot', 'archive_recheck', 'harvest_provider')
          and waiting.attempts < waiting.max_attempts
          and (
      (waiting.status in ('pending', 'retry')
       and waiting.due_at <= v_now)
      or
      (waiting.status = 'leased'
       and waiting.leased_until <= v_now)
    )
          and public.shared_market_work_eligible(other_market.id, waiting.work_type, waiting.venue_id, waiting.source_id, v_now)
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


-- One canonical reservation algorithm, with an optional
-- Market preference. Preserve the original zero-argument RPC.
create or replace function public.reserve_shared_harvester_batch()
returns table (
  reservation_id uuid,
  selected_market_id uuid,
  selected_market_key text,
  reservation_expires_at timestamptz
)
language sql
security definer
set search_path = ''
as $reserve_all$
  select *
  from public.reserve_shared_harvester_batch_scoped(null::uuid);
$reserve_all$;

create function public.reserve_shared_harvester_batch_for_market(
  p_market_id uuid
)
returns table (
  reservation_id uuid,
  selected_market_id uuid,
  selected_market_key text,
  reservation_expires_at timestamptz
)
language sql
security definer
set search_path = ''
as $reserve_one$
  select *
  from public.reserve_shared_harvester_batch_scoped(p_market_id);
$reserve_one$;

revoke all on function
  public.reserve_shared_harvester_batch_scoped(uuid),
  public.reserve_shared_harvester_batch_for_market(uuid)
from public, anon, authenticated;

grant execute on function
  public.reserve_shared_harvester_batch_scoped(uuid),
  public.reserve_shared_harvester_batch_for_market(uuid)
to service_role;


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
  where w.work_type in ('harvest_source', 'detect_spot', 'archive_recheck', 'harvest_provider')
    and w.status = 'leased'
    and w.leased_until > v_now;

  if v_global_active >= v_global_limit then
    return;
  end if;

  select count(*)::integer
    into v_market_active
  from public.event_processing_work w
  where w.market_id = p_market_id
    and w.work_type in ('harvest_source', 'detect_spot', 'archive_recheck', 'harvest_provider')
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
  v_reserved_batches integer;
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
  if p_work_type in ('harvest_source', 'detect_spot', 'archive_recheck', 'harvest_provider') then
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

  v_now := clock_timestamp();

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
  select count(*)::integer
    into v_active_batches
  from (
    select distinct w.batch_id
    from public.event_processing_work w
    where w.market_id = p_market_id
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

  select count(*)::integer
    into v_reserved_batches
  from public.event_processing_dispatch_reservations r
  where r.market_id = p_market_id
    and r.status in ('reserved', 'claimed')
    and r.expires_at > v_now;

  v_active_batches := v_active_batches + v_reserved_batches;

  if v_active_batches >= v_market.max_concurrent_batches then
    return;
  end if;

  -- Legacy harvester batches must obey the same live-source
  -- ceiling as shared source-level claims. Detector capacity
  -- remains governed by its existing batch rules.
  if p_work_type in ('harvest_source', 'detect_spot', 'archive_recheck', 'harvest_provider') then
    v_now := clock_timestamp();

    select count(*)::integer
      into v_global_active_sources
    from public.event_processing_work w
    where w.work_type in ('harvest_source', 'detect_spot', 'archive_recheck', 'harvest_provider')
      and w.status = 'leased'
      and w.leased_until > v_now;

    select count(*)::integer
      into v_market_active_sources
    from public.event_processing_work w
    where w.market_id = p_market_id
      and w.work_type in ('harvest_source', 'detect_spot', 'archive_recheck', 'harvest_provider')
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
              and nullif(trim(v.website_url), '') is not null
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
    -- Global pool row and reservation are already locked.
    -- The Market lock follows the same established ordering.
    perform 1
    from public.event_processing_markets m
    where m.id = v_reservation.market_id
      and m.is_enabled = true
    for update;

    if not found then
      return;
    end if;

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


-- A scoped Workflow must claim precisely its assigned archive
-- Spot, and must still own its Market work lease.
create function public.claim_market_event_harvest_archive_target(
  p_market_id uuid,
  p_venue_id uuid,
  p_work_id uuid,
  p_work_lease_token uuid
)
returns table (
  venue_id uuid,
  lease_token uuid
)
language plpgsql
security definer
set search_path = ''
as $archive_target$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  if p_market_id is null
     or p_venue_id is null
     or p_work_id is null
     or p_work_lease_token is null
  then
    raise exception 'Invalid archive target arguments';
  end if;

  perform 1
  from public.event_processing_work w
  join public.event_processing_markets m
    on m.id = w.market_id
  where w.id = p_work_id
    and w.market_id = p_market_id
    and w.venue_id = p_venue_id
    and w.work_type = 'archive_recheck'
    and w.status = 'leased'
    and w.lease_token = p_work_lease_token
    and w.leased_until > clock_timestamp()
    and m.is_enabled = true
  for update of w;

  if not found then
    raise exception 'Archive Market work lease is not owned';
  end if;

  return query
  with due as materialized (
    select a.venue_id
    from public.event_harvest_archive a
    join public.venues v on v.id = a.venue_id
    join public.event_processing_market_venues mv
      on mv.venue_id = a.venue_id
    where a.venue_id = p_venue_id
      and mv.market_id = p_market_id
      and a.restored_at is null
      and a.next_check_at <= now()
      and v.status = 'active'
      and v.website_url is not null
    for update of a skip locked
  ),
  claimed as (
    update public.event_harvest_archive a
    set next_check_at = now() + interval '2 hours',
        archive_lease_token = gen_random_uuid()
    from due
    where a.venue_id = due.venue_id
    returning a.venue_id, a.archive_lease_token
  )
  select c.venue_id, c.archive_lease_token
  from claimed c;
end;
$archive_target$;

-- Preserve the original restoration function while fencing
-- its use to the specific shared Market work lease.
create function public.finish_market_event_harvest_archive_target(
  p_venue_id uuid,
  p_scan_succeeded boolean,
  p_archive_lease_token uuid,
  p_work_id uuid,
  p_work_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $finish_archive_target$
declare
  v_restored boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  perform 1
  from public.event_processing_work w
  where w.id = p_work_id
    and w.venue_id = p_venue_id
    and w.work_type = 'archive_recheck'
    and w.status = 'leased'
    and w.lease_token = p_work_lease_token
    and w.leased_until > clock_timestamp()
  for update;

  if not found then
    raise exception 'Archive completion lost Market work ownership';
  end if;

  select public.finish_event_harvest_archive_recheck(
    p_venue_id,
    p_scan_succeeded,
    p_archive_lease_token
  ) into v_restored;

  return v_restored;
end;
$finish_archive_target$;

revoke all on function
  public.claim_market_event_harvest_archive_target(
    uuid,uuid,uuid,uuid
  ),
  public.finish_market_event_harvest_archive_target(
    uuid,boolean,uuid,uuid,uuid
  )
from public, anon, authenticated;

grant execute on function
  public.claim_market_event_harvest_archive_target(
    uuid,uuid,uuid,uuid
  ),
  public.finish_market_event_harvest_archive_target(
    uuid,boolean,uuid,uuid,uuid
  )
to service_role;


commit;
