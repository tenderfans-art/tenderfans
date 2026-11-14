-- 125: Daily scheduled Market cycles, dormant until explicit activation.
-- No changes to worker/lease/ingestion/attribution or pool capacity.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '90s';

-- Refuse to cut over a Market ahead of the dispatcher deployment.
do $preflight$
begin
  if exists (select 1 from public.event_processing_markets
             where schedule_enabled = true) then
    raise exception '125: Unexpected already-active scheduled Market';
  end if;
end;
$preflight$;

create index event_processing_cycle_unfinished_market_idx
on public.event_processing_work(market_id,status)
where status in ('pending','retry','leased');

create index event_processing_cycle_live_reservation_idx
on public.event_processing_dispatch_reservations(market_id,status)
where status in ('reserved','claimed');

create index event_processing_cycle_running_time_idx
on public.event_processing_market_cycles(started_at,id)
where status='running';

-- The next local wall-clock occurrence, DST-safe for 09:30.
create function public.next_market_schedule_after(
  p_zone text, p_time time, p_after timestamptz
) returns timestamptz
language plpgsql stable security definer set search_path=''
as $f$
declare d date; v_next timestamptz;
begin
  if p_zone is null or p_time is null or p_after is null
     or not exists (select 1 from pg_catalog.pg_timezone_names
                    where name=p_zone) then
    raise exception 'Invalid Market schedule';
  end if;
  d := (p_after at time zone p_zone)::date;
  v_next := (d+p_time) at time zone p_zone;
  if v_next <= p_after then
    v_next := (d+1+p_time) at time zone p_zone;
  end if;
  return v_next;
end;
$f$;

-- Explicitly activate an already-enabled legacy Market ONLY after
-- the new dispatcher deployment has been verified live.
create function public.activate_market_daily_schedule(p_market_id uuid)
returns timestamptz
language plpgsql security definer set search_path=''
as $f$
declare m record; v_next timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;
  select * into m from public.event_processing_markets
  where id=p_market_id for update;
  if not found or not m.is_enabled then
    raise exception 'Market must exist and be enabled';
  end if;
  if m.schedule_enabled and m.next_scheduled_at is not null then
    return m.next_scheduled_at;
  end if;
  v_next := public.next_market_schedule_after(
    m.schedule_timezone,m.schedule_local_time,clock_timestamp()
  );
  update public.event_processing_markets
  set schedule_enabled=true,next_scheduled_at=v_next,
      updated_at=clock_timestamp()
  where id=m.id;
  return v_next;
end;
$f$;

-- Existing Admin Enable/Disable now uses scheduling on re-enable.
-- Disabling never deletes jobs or releases live worker ownership.
create function public.set_market_processing_enabled(
  p_market_id uuid, p_enabled boolean
) returns boolean
language plpgsql security definer set search_path=''
as $f$
declare m record; v_now timestamptz := clock_timestamp();
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_market_id is null or p_enabled is null then return false; end if;
  select * into m from public.event_processing_markets
  where id=p_market_id for update;
  if not found then return false; end if;
  if p_enabled then
    if not exists (select 1 from public.event_processing_market_venues
                   where market_id=p_market_id) then
      raise exception 'Assign Spots before enabling Market';
    end if;
    update public.event_processing_markets
    set is_enabled=true, schedule_enabled=true,
        next_scheduled_at=case
          when m.schedule_enabled and m.next_scheduled_at>v_now
            then m.next_scheduled_at
          else public.next_market_schedule_after(
            m.schedule_timezone,m.schedule_local_time,v_now)
        end,
        updated_at=v_now
    where id=p_market_id;
  else
    update public.event_processing_markets
    set is_enabled=false,updated_at=v_now
    where id=p_market_id;
  end if;
  return true;
end;
$f$;

-- A Market gets one complete, atomic cohort snapshot per schedule.
-- Index-backed candidate selection excludes already-running/busy
-- Markets BEFORE LIMIT to prevent starvation with many Markets.
create function public.start_due_market_cycles(
  p_market_id uuid default null, p_limit integer default 16
) returns integer
language plpgsql security definer set search_path=''
as $f$
declare
  m record; v_now timestamptz; v_id uuid;
  v_expected integer; v_inserted integer;
  v_spots integer; v_shared integer;
  v_archives integer; v_provider integer;
  v_started integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_limit is null or p_limit not between 1 and 16 then
    raise exception 'Invalid cycle limit';
  end if;
  for m in
    select * from public.event_processing_markets em
    where em.is_enabled=true and em.schedule_enabled=true
      and em.next_scheduled_at <= clock_timestamp()
      and (p_market_id is null or em.id=p_market_id)
      and not exists (
        select 1 from public.event_processing_market_cycles c
        where c.market_id=em.id and c.status='running'
      )
      and not exists (
        select 1 from public.event_processing_work w
        where w.market_id=em.id and w.status in ('pending','retry','leased')
      )
      and not exists (
        select 1 from public.event_processing_dispatch_reservations r
        where r.market_id=em.id and r.status in ('reserved','claimed')
      )
    order by em.next_scheduled_at, em.id
    limit p_limit for update of em skip locked
  loop
    v_now := clock_timestamp();

    -- Recheck after acquiring Market lock; keep the no-overlap rule.
    if exists (select 1 from public.event_processing_market_cycles c
               where c.market_id=m.id and c.status='running')
       or exists (select 1 from public.event_processing_work w
                  where w.market_id=m.id
                    and w.status in ('pending','retry','leased'))
       or exists (select 1 from public.event_processing_dispatch_reservations r
                  where r.market_id=m.id
                    and r.status in ('reserved','claimed')) then
      continue;
    end if;

    -- An overlong prior cycle skips any already-missed daily slot.
    if exists (select 1 from public.event_processing_market_cycles c
               where c.market_id=m.id
                 and c.finished_at >= m.next_scheduled_at) then
      update public.event_processing_markets
      set next_scheduled_at=public.next_market_schedule_after(
        m.schedule_timezone,m.schedule_local_time,v_now
      ),updated_at=v_now where id=m.id;
      continue;
    end if;

    v_id := null;
    insert into public.event_processing_market_cycles(
      market_id,scheduled_for,started_at
    ) values (m.id,m.next_scheduled_at,v_now)
    on conflict(market_id,scheduled_for) do nothing
    returning id into v_id;
    if v_id is null then
      raise exception 'Duplicate Market occurrence: %',m.id;
    end if;

    with eligible as materialized (
      -- One Spot work item owns both original execution stages.
      select 'detect_spot'::text as work_type,
             v.id as venue_id,null::uuid as source_id,
             v_now as due_at
      from public.event_processing_market_venues mv
      join public.venues v on v.id=mv.venue_id
      where mv.market_id=m.id and v.status='active'
        and (
          nullif(trim(v.website_url),'') is not null
          or exists (
            select 1 from public.event_harvest_sources s
            where s.venue_id=v.id and s.provider='first_party'
              and s.is_enabled=true
              and public.event_processing_source_in_market(s.id,m.id)
          )
        )
        and not exists (
          select 1 from public.event_harvest_archive a
          where a.venue_id=v.id and a.restored_at is null
        )
      union all
      -- Ownerless approved publishers; one Market assignment/source.
      select 'harvest_source',null::uuid,s.id,v_now
      from public.event_processing_shared_source_markets sm
      join public.event_harvest_sources s on s.id=sm.source_id
      where sm.market_id=m.id and s.venue_id is null
        and s.provider='first_party' and s.is_enabled=true
      union all
      -- Archive rechecks only when original archive time is due.
      select 'archive_recheck',a.venue_id,null::uuid,min(a.next_check_at)
      from public.event_harvest_archive a
      join public.event_processing_market_venues mv
        on mv.venue_id=a.venue_id
      join public.venues v on v.id=a.venue_id
      where mv.market_id=m.id and a.restored_at is null
        and a.next_check_at<=v_now and v.status='active'
        and nullif(trim(v.website_url),'') is not null
      group by a.venue_id
      union all
      -- Ticketmaster remains globally serialized by existing claims.
      select 'harvest_provider',null::uuid,null::uuid,v_now
      where exists (
        select 1 from public.event_harvest_sources s
        where s.provider='ticketmaster'
          and s.external_source_id='discovery-v2'
          and s.is_enabled=true
      ) and exists (
        select 1 from public.event_processing_market_venues mv
        join public.venues v on v.id=mv.venue_id
        where mv.market_id=m.id and v.status='active'
      )
    ), inserted as (
      insert into public.event_processing_work(
        market_id,market_cycle_id,work_type,venue_id,source_id,due_at
      )
      select m.id,v_id,e.work_type,e.venue_id,e.source_id,e.due_at
      from eligible e
      where true
      on conflict do nothing
      returning work_type
    )
    select
      (select count(*)::integer from eligible),
      (select count(*)::integer from inserted),
      (select count(*)::integer from inserted where work_type='detect_spot'),
      (select count(*)::integer from inserted where work_type='harvest_source'),
      (select count(*)::integer from inserted where work_type='archive_recheck'),
      (select count(*)::integer from inserted where work_type='harvest_provider')
    into v_expected,v_inserted,v_spots,v_shared,v_archives,v_provider;

    if v_inserted<>v_expected then
      raise exception 'Market % incomplete cohort: expected %, queued %',
        m.id,v_expected,v_inserted;
    end if;

    update public.event_processing_market_cycles
    set expected_spots=v_spots,expected_shared_sources=v_shared,
        expected_archive_checks=v_archives,expected_provider_jobs=v_provider,
        last_observed_at=v_now
    where id=v_id;

    update public.event_processing_markets
    set last_scheduled_at=m.next_scheduled_at,
        next_scheduled_at=public.next_market_schedule_after(
          m.schedule_timezone,m.schedule_local_time,v_now
        ),updated_at=v_now
    where id=m.id;

    if v_inserted=0 then
      update public.event_processing_market_cycles
      set status='completed',finished_at=clock_timestamp()
      where id=v_id;
    end if;

    v_started := v_started+1;
  end loop;
  return v_started;
end;
$f$;

-- Observational reconciler: no forced lease/lock release, no
-- skipping retries, no arbitrary cancellation of ineligible work.
create function public.reconcile_running_market_cycles(
  p_market_id uuid default null, p_limit integer default 32
) returns integer
language plpgsql security definer set search_path=''
as $f$
declare
  c record; v_now timestamptz;
  v_unfinished integer; v_failed integer;
  v_reservations integer; v_sources integer;
  v_finished integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_limit is null or p_limit not between 1 and 64 then
    raise exception 'Invalid cycle reconciliation limit';
  end if;
  for c in
    select * from public.event_processing_market_cycles
    where status='running'
      and (p_market_id is null or market_id=p_market_id)
    order by started_at,id
    limit p_limit for update skip locked
  loop
    v_now := clock_timestamp();

    -- Non-leased retries that already exhausted attempts cannot
    -- be reclaimed. Do not override expired leased ownership here.
    update public.event_processing_work w
    set status='failed',last_finished_at=v_now,
        last_error=coalesce(w.last_error,'Attempt budget exhausted'),
        updated_at=v_now
    where w.market_cycle_id=c.id
      and w.status in ('pending','retry')
      and w.attempts>=w.max_attempts;

    select
      count(*) filter(where status in ('pending','retry','leased'))::integer,
      count(*) filter(where status in ('failed','cancelled'))::integer,
      count(*) filter(where status='leased' and leased_until>v_now)::integer
    into v_unfinished,v_failed,v_sources
    from public.event_processing_work where market_cycle_id=c.id;

    select count(*)::integer into v_reservations
    from public.event_processing_dispatch_reservations r
    where r.market_id=c.market_id
      and r.status in ('reserved','claimed');

    update public.event_processing_market_cycles
    set peak_active_sources=greatest(peak_active_sources,v_sources),
        peak_active_workflows=greatest(peak_active_workflows,v_reservations),
        last_observed_at=v_now
    where id=c.id;

    if v_unfinished=0 and v_reservations=0 then
      update public.event_processing_market_cycles
      set status=case when v_failed>0
          then 'completed_with_failures' else 'completed' end,
          finished_at=clock_timestamp(),last_observed_at=clock_timestamp()
      where id=c.id and status='running';
      v_finished := v_finished+1;
    end if;
  end loop;
  return v_finished;
end;
$f$;

revoke all on function
  public.next_market_schedule_after(text,time,timestamptz),
  public.activate_market_daily_schedule(uuid),
  public.set_market_processing_enabled(uuid,boolean),
  public.start_due_market_cycles(uuid,integer),
  public.reconcile_running_market_cycles(uuid,integer)
from public,anon,authenticated;

grant execute on function
  public.next_market_schedule_after(text,time,timestamptz),
  public.activate_market_daily_schedule(uuid),
  public.set_market_processing_enabled(uuid,boolean),
  public.start_due_market_cycles(uuid,integer),
  public.reconcile_running_market_cycles(uuid,integer)
to service_role;

-- Original rolling queues are restricted to unscheduled Markets.
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
      and schedule_enabled = false
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

create or replace function public.enqueue_due_market_supplemental_processing(
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
      and schedule_enabled = false
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

commit;
