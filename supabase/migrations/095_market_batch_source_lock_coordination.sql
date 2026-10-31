-- TenderFans market-batch/source-lock coordination.
-- Requires migrations 092, 093 and 094.
-- Replaces only claim_event_processing_batch.
-- Does not enable scheduling or automatically clear source locks.
--
-- A source lock blocks new harvester admission and protects expired
-- work from premature failure/reclaim. A crashed execution requires
-- separate, verified lock recovery.

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

-- Renew an individual lease while a legitimate worker
-- is still processing. A stale worker cannot renew.
