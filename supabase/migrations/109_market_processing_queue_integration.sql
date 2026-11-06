-- 109: Market processing queue integration.
-- No Market activation or automatic scheduling changes.
-- Preserve existing detectors and harvesting lifecycles.

create index if not exists
  event_processing_work_detector_history_idx
on public.event_processing_work
  (venue_id, created_at desc)
where work_type = 'detect_spot';

create index if not exists
  event_processing_work_source_history_idx
on public.event_processing_work
  (source_id, created_at desc)
where work_type = 'harvest_source';

create function public.enqueue_due_market_processing(
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
    join public.event_processing_market_venues mv
      on mv.venue_id = s.venue_id
    join public.venues v
      on v.id = mv.venue_id
    where mv.market_id = m.id
      and s.provider = 'first_party'
      and s.is_enabled = true
      and v.status = 'active'
      and not exists (
        select 1
        from public.event_harvest_archive a
        where a.venue_id = v.id
          and a.restored_at is null
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

revoke all on function
  public.enqueue_due_market_processing(uuid)
from public, anon, authenticated;

grant execute on function
  public.enqueue_due_market_processing(uuid)
to service_role;


-- Read-only discovery of Markets with eligible detector jobs.
-- Actual work claims remain controlled by the existing
-- claim_event_processing_batch RPC.

create function public.list_due_market_detector_work()
returns table (
  market_id uuid,
  market_key text
)
language sql
security definer
set search_path = ''
stable
as $due$
  select m.id, m.market_key
  from public.event_processing_markets m
  where m.is_enabled = true
    and exists (
      select 1
      from public.event_processing_work w
      join public.event_processing_market_venues mv
        on mv.venue_id = w.venue_id
       and mv.market_id = m.id
      join public.venues v
        on v.id = w.venue_id
      where w.market_id = m.id
        and w.work_type = 'detect_spot'
        and w.attempts < w.max_attempts
        and v.status = 'active'
        and v.website_url is not null
        and (
          (
            w.status in ('pending', 'retry')
            and w.due_at <= clock_timestamp()
          )
          or (
            w.status = 'leased'
            and w.leased_until <= clock_timestamp()
          )
        )
        and not exists (
          select 1
          from public.event_harvest_archive a
          where a.venue_id = v.id
            and a.restored_at is null
        )
    )
    and (
      select count(distinct active.batch_id)
      from public.event_processing_work active
      where active.market_id = m.id
        and active.status = 'leased'
        and active.leased_until > clock_timestamp()
    ) < m.max_concurrent_batches
  order by m.market_key
  limit 10;
$due$;

revoke all on function
  public.list_due_market_detector_work()
from public, anon, authenticated;

grant execute on function
  public.list_due_market_detector_work()
to service_role;
