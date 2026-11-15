-- Reuse successful Facebook inventories within one scheduled Market cycle.
-- Every original source/Spot job still runs its own ingestion and review flow.
-- This disposable cache has no pending claims, browser ownership, or wait loop.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '90s';

create table public.market_facebook_inventories (
  market_cycle_id uuid not null,
  market_id uuid not null,
  page_url text not null check (
    length(page_url) between 1 and 1024
    and page_url ~ '^https://(www[.]|m[.]|mbasic[.])?facebook[.]com/[^[:space:]]+$'
  ),
  validate_page_identity boolean not null,
  format_version smallint not null default 1 check (format_version = 1),
  events jsonb not null check (
    jsonb_typeof(events) = 'array'
    and octet_length(events::text) <= 4194304
  ),
  producer_work_id uuid not null
    references public.event_processing_work(id) on delete cascade,
  -- Provenance only: source-independent inventory must not own source history.
  producer_source_id uuid,
  producer_venue_id uuid,
  fetched_at timestamptz not null default clock_timestamp(),
  primary key (
    market_cycle_id, page_url, validate_page_identity, format_version
  ),
  foreign key (market_cycle_id, market_id)
    references public.event_processing_market_cycles(id, market_id)
    on delete cascade
);

create index market_facebook_inventories_fetched_idx
  on public.market_facebook_inventories(fetched_at);

alter table public.market_facebook_inventories enable row level security;
revoke all on public.market_facebook_inventories
  from public, anon, authenticated, service_role;
grant select on public.market_facebook_inventories to service_role;

create function public.market_facebook_inventory(
  p_work_id uuid,
  p_lease_token uuid,
  p_page_url text,
  p_validate_page_identity boolean,
  p_events jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $inventory$
declare
  v_work record;
  v_events jsonb;
  v_inserted boolean := false;
begin
  -- Invalid/unavailable cache context is a miss, never a source outcome.
  if p_work_id is null or p_lease_token is null
     or p_validate_page_identity is null
     or p_page_url is null
     or length(p_page_url) not between 1 and 1024
     or p_page_url !~ '^https://(www[.]|m[.]|mbasic[.])?facebook[.]com/[^[:space:]]+$'
     or (p_events is not null and (
       jsonb_typeof(p_events) <> 'array'
       or octet_length(p_events::text) > 4194304
     )) then
    return null;
  end if;

  -- Work always locks before cache rows. The immutable assignment deadline
  -- cannot be extended by ordinary work-lease renewal or an SDK replay.
  select w.id, w.market_id, w.market_cycle_id,
         w.source_id, w.venue_id, w.leased_until,
         a.claimed_leased_until as execution_deadline
  into v_work
  from public.event_processing_work w
  join public.shared_harvester_source_assignments a
    on a.work_id = w.id and a.lease_token = w.lease_token
  join public.event_processing_market_cycles c
    on c.id = w.market_cycle_id and c.market_id = w.market_id
  where w.id = p_work_id
    and w.lease_token = p_lease_token
    and w.status = 'leased'
    and w.work_type in ('detect_spot', 'harvest_source', 'archive_recheck')
    and w.leased_until > clock_timestamp()
    and a.claimed_leased_until > clock_timestamp()
    and c.status = 'running'
  for update of w;

  if not found then return null; end if;

  -- A read never creates a row or changes another caller's inventory.
  if p_events is null then
    select i.events into v_events
    from public.market_facebook_inventories i
    where i.market_cycle_id = v_work.market_cycle_id
      and i.page_url = p_page_url
      and i.validate_page_identity = p_validate_page_identity
      and i.format_version = 1
    for update;
  else
    -- Only successful raw arrays are offered here. Concurrent successes
    -- preserve the first committed inventory; there is no fetch reservation.
    insert into public.market_facebook_inventories (
      market_cycle_id, market_id, page_url, validate_page_identity,
      format_version, events, producer_work_id,
      producer_source_id, producer_venue_id
    ) values (
      v_work.market_cycle_id, v_work.market_id,
      p_page_url, p_validate_page_identity,
      1, p_events, v_work.id, v_work.source_id, v_work.venue_id
    ) on conflict (
      market_cycle_id, page_url, validate_page_identity, format_version
    ) do nothing;

    v_inserted := found;

    select i.events into v_events
    from public.market_facebook_inventories i
    where i.market_cycle_id = v_work.market_cycle_id
      and i.page_url = p_page_url
      and i.validate_page_identity = p_validate_page_identity
      and i.format_version = 1
    for update;
  end if;

  -- Cache-row/unique-index waits may cross a live lease's hard deadline.
  -- A stale publisher may remove only the row it just inserted itself.
  if v_work.leased_until <= clock_timestamp()
     or v_work.execution_deadline <= clock_timestamp()
     or not exists (
       select 1 from public.event_processing_market_cycles c
       where c.id = v_work.market_cycle_id
         and c.market_id = v_work.market_id and c.status = 'running'
     ) then
    if v_inserted then
      delete from public.market_facebook_inventories i
      where i.market_cycle_id = v_work.market_cycle_id
        and i.page_url = p_page_url
        and i.validate_page_identity = p_validate_page_identity
        and i.format_version = 1
        and i.producer_work_id = v_work.id;
    end if;
    return null;
  end if;

  if v_inserted then
    -- Bounded maintenance of disposable successes only. No active-cycle
    -- inventory is removed, and locked rows never delay cache publication.
    delete from public.market_facebook_inventories i
    using (
      select old.market_cycle_id, old.page_url,
             old.validate_page_identity, old.format_version
      from public.market_facebook_inventories old
      join public.event_processing_market_cycles c
        on c.id = old.market_cycle_id and c.market_id = old.market_id
      where c.status <> 'running'
        and c.finished_at < clock_timestamp() - interval '7 days'
      order by old.fetched_at
      limit 16
      for update of old skip locked
    ) expired
    where i.market_cycle_id = expired.market_cycle_id
      and i.page_url = expired.page_url
      and i.validate_page_identity = expired.validate_page_identity
      and i.format_version = expired.format_version;
  end if;

  return v_events;
end;
$inventory$;

revoke all on function public.market_facebook_inventory(
  uuid, uuid, text, boolean, jsonb
) from public, anon, authenticated;
grant execute on function public.market_facebook_inventory(
  uuid, uuid, text, boolean, jsonb
) to service_role;

commit;
