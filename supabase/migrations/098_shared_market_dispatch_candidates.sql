-- 098: Shared-market harvester dispatch discovery.
-- Read-only candidate selection. No scheduling or market activation.
-- Actual work admission remains in claim_event_processing_batch.

create function public.list_shared_harvester_markets()
returns table (
  market_id uuid,
  market_key text,
  available_batch_slots integer,
  ready_items bigint,
  oldest_due_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with active as (
    select
      w.market_id,
      count(distinct w.batch_id)::integer as active_batches
    from public.event_processing_work w
    where w.status = 'leased'
      and w.leased_until > clock_timestamp()
      and w.batch_id is not null
    group by w.market_id
  ),
  ready as (
    select
      w.market_id,
      count(*) as ready_items,
      min(w.due_at) as oldest_due_at
    from public.event_processing_work w
    join public.event_harvest_sources s
      on s.id = w.source_id
    join public.event_processing_market_venues mv
      on mv.venue_id = s.venue_id
     and mv.market_id = w.market_id
    where w.work_type = 'harvest_source'
      and w.attempts < w.max_attempts
      and s.provider = 'first_party'
      and s.is_enabled = true
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
        from public.first_party_source_executions e
        where e.source_id = w.source_id
      )
    group by w.market_id
  )
  select
    m.id,
    m.market_key,
    (m.max_concurrent_batches -
      coalesce(a.active_batches, 0))::integer,
    r.ready_items,
    r.oldest_due_at
  from public.event_processing_markets m
  join ready r on r.market_id = m.id
  left join active a on a.market_id = m.id
  where m.is_enabled = true
    and m.max_concurrent_batches >
      coalesce(a.active_batches, 0)
  order by
    r.oldest_due_at asc,
    r.ready_items desc,
    m.id asc;
$$;

revoke all on function public.list_shared_harvester_markets()
from public, anon, authenticated;

grant execute on function public.list_shared_harvester_markets()
to service_role;
