-- Market Spot-first processing using original detector and harvester.
-- Retains source ownership, fencing, reviews, and publishing.
-- Does not modify existing work rows, enabled Markets, or pool settings.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '90s';

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
      and (
        nullif(trim(v.website_url), '') is not null
        or exists (
          select 1
          from public.event_harvest_sources approved
          where approved.venue_id = v.id
            and approved.provider = 'first_party'
            and approved.is_enabled = true
            and public.event_processing_source_in_market(
              approved.id, m.id
            )
        )
      )
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
      and s.venue_id is null
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

create or replace function public.shared_market_work_eligible(
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
        and src.venue_id is null
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
        and (
          nullif(trim(v.website_url), '') is not null
          or exists (
            select 1
            from public.event_harvest_sources approved
            where approved.venue_id = v.id
              and approved.provider = 'first_party'
              and approved.is_enabled = true
              and public.event_processing_source_in_market(
                approved.id, p_market_id
              )
          )
        )
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
      and src.venue_id is null
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
              and (
                nullif(trim(v.website_url), '') is not null
                or exists (
                  select 1
                  from public.event_harvest_sources approved
                  where approved.venue_id = v.id
                    and approved.provider = 'first_party'
                    and approved.is_enabled = true
                    and public.event_processing_source_in_market(
                      approved.id, p_market_id
                    )
                )
              )
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
              and src.venue_id is null
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

create or replace function
public.claim_market_first_party_source_execution(
  p_source_id uuid,
  p_work_id uuid,
  p_lease_token uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token uuid := gen_random_uuid();
  v_work_source_id uuid;
  v_work_venue_id uuid;
  v_work_market_id uuid;
  v_work_type text;
  v_work_status text;
  v_work_lease_token uuid;
  v_work_leased_until timestamptz;
begin
  if p_source_id is null
     or p_work_id is null
     or p_lease_token is null then
    raise exception
      'Market source claim requires source, work, and lease token';
  end if;

  /*
   * Lock the work row first.
   *
   * This serializes the claim against lease renewal,
   * completion, failure, and reassignment.
   */
  select
    w.source_id,
    w.venue_id,
    w.market_id,
    w.work_type,
    w.status,
    w.lease_token,
    w.leased_until
  into
    v_work_source_id,
    v_work_venue_id,
    v_work_market_id,
    v_work_type,
    v_work_status,
    v_work_lease_token,
    v_work_leased_until
  from public.event_processing_work w
  where w.id = p_work_id
    and w.work_type in ('harvest_source', 'detect_spot')
  for update;

  if not found
     or not (
       (
         v_work_type = 'harvest_source'
         and v_work_source_id = p_source_id
       )
       or (
         v_work_type = 'detect_spot'
         and exists (
           select 1
           from public.event_harvest_sources src
           where src.id = p_source_id
             and src.venue_id = v_work_venue_id
             and src.provider = 'first_party'
             and src.is_enabled = true
             and public.event_processing_source_in_market(
               src.id, v_work_market_id
             )
         )
       )
     )
     or v_work_status is distinct from 'leased'
     or v_work_lease_token is distinct from p_lease_token
     or v_work_leased_until is null
     or v_work_leased_until <= clock_timestamp() then
    raise exception
      'Market work lease ownership invalid for work %',
      p_work_id;
  end if;

  /*
   * Preserve the existing one-execution-per-source
   * exclusion using the source_id primary key.
   *
   * Never replace an existing execution automatically.
   */
  insert into public.first_party_source_executions (
    source_id,
    execution_token,
    market_work_id,
    market_lease_token
  )
  values (
    p_source_id,
    v_token,
    p_work_id,
    p_lease_token
  )
  on conflict (source_id) do nothing;

  if found then
    return v_token;
  end if;

  return null;
end;
$$;

create or replace function public.execute_fenced_first_party_write(
  p_source_id uuid,
  p_execution_token uuid,
  p_operation text,
  p_args jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fence$
declare
  v_execution record;
  v_work record;
  v_result jsonb;
begin
  if p_source_id is null
     or p_execution_token is null
     or p_operation is null
     or p_args is null
     or jsonb_typeof(p_args) <> 'object' then
    raise exception 'Invalid first-party write request';
  end if;

  -- Read the binding before acquiring locks, then verify it
  -- again after locking. Market work is always locked first.
  select e.market_work_id, e.market_lease_token
  into v_execution
  from public.first_party_source_executions e
  where e.source_id = p_source_id
    and e.execution_token = p_execution_token;

  if not found then
    raise exception 'First-party execution ownership lost';
  end if;

  if v_execution.market_work_id is not null then
    select w.source_id, w.venue_id, w.market_id,
           w.work_type, w.status,
           w.lease_token, w.leased_until
    into v_work
    from public.event_processing_work w
    where w.id = v_execution.market_work_id
    for update;

    if not found
       or not (
         (
           v_work.work_type = 'harvest_source'
           and v_work.source_id = p_source_id
         )
         or (
           v_work.work_type = 'detect_spot'
           and exists (
             select 1
             from public.event_harvest_sources src
             where src.id = p_source_id
               and src.venue_id = v_work.venue_id
               and src.provider = 'first_party'
               and src.is_enabled = true
               and public.event_processing_source_in_market(
                 src.id, v_work.market_id
               )
           )
         )
       )
       or v_work.status is distinct from 'leased'
       or v_work.lease_token is distinct from
          v_execution.market_lease_token
       or v_work.leased_until <= clock_timestamp() then
      raise exception 'First-party market lease ownership lost';
    end if;
  end if;

  perform public.assert_first_party_execution_ownership(
    p_source_id, p_execution_token
  );

  -- Recheck the execution binding after acquiring its row lock.
  perform 1
  from public.first_party_source_executions e
  where e.source_id = p_source_id
    and e.execution_token = p_execution_token
    and e.market_work_id is not distinct from
        v_execution.market_work_id
    and e.market_lease_token is not distinct from
        v_execution.market_lease_token;

  if not found then
    raise exception 'First-party execution binding changed';
  end if;

  -- Recheck expiry after all lock waits.
  if v_execution.market_work_id is not null then
    perform 1
    from public.event_processing_work w
    where w.id = v_execution.market_work_id
      and w.status = 'leased'
      and w.lease_token = v_execution.market_lease_token
      and w.leased_until > clock_timestamp();

    if not found then
      raise exception 'First-party market lease expired';
    end if;
  end if;

  if p_operation = 'resolve_pending_facebook_review' then
    update public.event_harvest_unresolved_venues
    set status = 'resolved',
        resolved_venue_id =
          (p_args ->> 'p_resolved_venue_id')::uuid,
        updated_at = clock_timestamp()
    where source_id = p_source_id
      and external_event_id =
          p_args ->> 'p_external_event_id'
      and status = 'pending';

    return null;
  elsif p_operation = 'upsert_event_harvest_unresolved_venue' then

    if (p_args ->> 'p_source_id')::uuid
       is distinct from p_source_id then
      raise exception 'Source argument does not match execution';
    end if;
    return to_jsonb(public.upsert_event_harvest_unresolved_venue(
        p_source_id => (p_args ->> 'p_source_id')::uuid,
        p_external_event_id => (p_args ->> 'p_external_event_id')::text,
        p_source_url => (p_args ->> 'p_source_url')::text,
        p_raw_title => (p_args ->> 'p_raw_title')::text,
        p_raw_starts_at => (p_args ->> 'p_raw_starts_at')::text,
        p_raw_ends_at => (p_args ->> 'p_raw_ends_at')::text,
        p_publisher_venue_name => (p_args ->> 'p_publisher_venue_name')::text,
        p_publisher_address => (p_args ->> 'p_publisher_address')::text,
        p_publisher_city => (p_args ->> 'p_publisher_city')::text,
        p_publisher_state_region => (p_args ->> 'p_publisher_state_region')::text,
        p_publisher_postal_code => (p_args ->> 'p_publisher_postal_code')::text,
        p_suggested_venue_id => (p_args ->> 'p_suggested_venue_id')::uuid,
        p_confidence_score => (p_args ->> 'p_confidence_score')::numeric,
        p_evidence => p_args -> 'p_evidence',
        p_raw_payload => p_args -> 'p_raw_payload'
      ));
  elsif p_operation = 'upsert_event_harvest_candidate' then

    if (p_args ->> 'p_source_id')::uuid
       is distinct from p_source_id then
      raise exception 'Source argument does not match execution';
    end if;
    return to_jsonb(public.upsert_event_harvest_candidate(
        p_source_id => (p_args ->> 'p_source_id')::uuid,
        p_external_event_id => (p_args ->> 'p_external_event_id')::text,
        p_source_url => (p_args ->> 'p_source_url')::text,
        p_raw_title => (p_args ->> 'p_raw_title')::text,
        p_raw_venue_name => (p_args ->> 'p_raw_venue_name')::text,
        p_raw_address => (p_args ->> 'p_raw_address')::text,
        p_raw_description => (p_args ->> 'p_raw_description')::text,
        p_raw_starts_at => (p_args ->> 'p_raw_starts_at')::text,
        p_raw_ends_at => (p_args ->> 'p_raw_ends_at')::text,
        p_normalized_title => (p_args ->> 'p_normalized_title')::text,
        p_starts_at => (p_args ->> 'p_starts_at')::timestamptz,
        p_ends_at => (p_args ->> 'p_ends_at')::timestamptz,
        p_venue_id => (p_args ->> 'p_venue_id')::uuid,
        p_confidence_score => (p_args ->> 'p_confidence_score')::numeric,
        p_event_fingerprint => (p_args ->> 'p_event_fingerprint')::text,
        p_raw_payload => p_args -> 'p_raw_payload'
      ));
  elsif p_operation = 'mark_harvest_candidate_for_review' then

    perform 1
    from public.event_harvest_candidates c
    where c.id = (p_args ->> 'p_candidate_id')::uuid
      and c.source_id = p_source_id;

    if not found then
      raise exception 'Candidate does not belong to source execution';
    end if;
    perform public.mark_harvest_candidate_for_review(
        p_candidate_id => (p_args ->> 'p_candidate_id')::uuid
      );
      return null;
  elsif p_operation = 'link_harvest_candidate_to_existing_event' then

    perform 1
    from public.event_harvest_candidates c
    where c.id = (p_args ->> 'p_candidate_id')::uuid
      and c.source_id = p_source_id;

    if not found then
      raise exception 'Candidate does not belong to source execution';
    end if;
    return to_jsonb(public.link_harvest_candidate_to_existing_event(
        p_candidate_id => (p_args ->> 'p_candidate_id')::uuid
      ));
  elsif p_operation = 'flag_event_harvest_occurrence_review' then

    perform 1
    from public.event_harvest_candidates c
    where c.id = (p_args ->> 'p_candidate_id')::uuid
      and c.source_id = p_source_id;

    if not found then
      raise exception 'Candidate does not belong to source execution';
    end if;
    return to_jsonb(public.flag_event_harvest_occurrence_review(
        p_candidate_id => (p_args ->> 'p_candidate_id')::uuid
      ));
  elsif p_operation = 'graduate_harvest_candidate' then

    perform 1
    from public.event_harvest_candidates c
    where c.id = (p_args ->> 'p_candidate_id')::uuid
      and c.source_id = p_source_id;

    if not found then
      raise exception 'Candidate does not belong to source execution';
    end if;
    return to_jsonb(public.graduate_harvest_candidate(
        p_candidate_id => (p_args ->> 'p_candidate_id')::uuid,
        p_reviewed_by => (p_args ->> 'p_reviewed_by')::uuid
      ));
  elsif p_operation = 'sync_first_party_event' then

    perform 1
    from public.event_harvest_candidates c
    where c.id = (p_args ->> 'p_candidate_id')::uuid
      and c.source_id = p_source_id;

    if not found then
      raise exception 'Candidate does not belong to source execution';
    end if;
    return to_jsonb(public.sync_first_party_event(
        p_candidate_id => (p_args ->> 'p_candidate_id')::uuid,
        p_source_url => (p_args ->> 'p_source_url')::text,
        p_raw_title => (p_args ->> 'p_raw_title')::text,
        p_raw_description => (p_args ->> 'p_raw_description')::text,
        p_raw_starts_at => (p_args ->> 'p_raw_starts_at')::text,
        p_raw_ends_at => (p_args ->> 'p_raw_ends_at')::text,
        p_normalized_title => (p_args ->> 'p_normalized_title')::text,
        p_starts_at => (p_args ->> 'p_starts_at')::timestamptz,
        p_ends_at => (p_args ->> 'p_ends_at')::timestamptz,
        p_event_fingerprint => (p_args ->> 'p_event_fingerprint')::text,
        p_flyer_url => (p_args ->> 'p_flyer_url')::text,
        p_raw_payload => p_args -> 'p_raw_payload'
      ));
  elsif p_operation = 'reconcile_first_party_source_absences' then

    if (p_args ->> 'p_source_id')::uuid
       is distinct from p_source_id then
      raise exception 'Source argument does not match execution';
    end if;
    select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
      into v_result
      from public.reconcile_first_party_source_absences(
        p_source_id => (p_args ->> 'p_source_id')::uuid,
        p_scan_started_at => (p_args ->> 'p_scan_started_at')::timestamptz
      ) r;
      return v_result;
  else
    raise exception 'Unsupported first-party operation: %',
      p_operation;
  end if;
end;
$fence$;

create or replace function public.recover_expired_market_source_executions(
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
    select w.id, w.source_id, w.venue_id,
           w.market_id, w.work_type, w.status,
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
    if (
         (
           v_work.work_type = 'harvest_source'
           and v_work.source_id = v_execution.source_id
         )
         or (
           v_work.work_type = 'detect_spot'
           and exists (
             select 1
             from public.event_harvest_sources src
             where src.id = v_execution.source_id
               and src.venue_id = v_work.venue_id
               and src.provider = 'first_party'
               and src.is_enabled = true
               and public.event_processing_source_in_market(
                 src.id, v_work.market_id
               )
           )
         )
       )
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

commit;
