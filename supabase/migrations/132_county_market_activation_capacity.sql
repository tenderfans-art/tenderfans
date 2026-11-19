-- County Market creation keeps its standard 2-Workflow / 16-job allocation.
-- Enable expands the shared admission ceiling to cover enabled baselines.
-- Disabled Markets do not reserve fleet capacity. Existing spare capacity and
-- transport limits are preserved; no runs, work, sources or schedules are started.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '90s';

do $baseline$
begin
  if (select md5(replace(prosrc,E'\r\n',E'\n')) from pg_catalog.pg_proc
      where oid='public.set_market_processing_enabled(uuid,boolean)'::regprocedure)
     is distinct from '031c2a65fabfd9ec09429327e65d7761' then
    raise exception '132: Market activation differs from the verified baseline';
  end if;
end;
$baseline$;

-- These ceilings describe the aggregate fleet, not one Market's budget.
-- The original single-pool upper bounds would block the ninth standard
-- Market. Per-Market and transport caps keep their existing constraints.
alter table public.event_processing_pool_config
  drop constraint event_processing_pool_config_max_concurrent_batches_check,
  drop constraint event_processing_pool_config_max_concurrent_sources_check,
  add constraint event_processing_pool_config_max_concurrent_batches_check
    check(max_concurrent_batches>=1),
  add constraint event_processing_pool_config_max_concurrent_sources_check
    check(max_concurrent_sources>=1);

-- Preserve the five-argument RPC for older callers. The admin creation form
-- supplies an explicit local schedule zone to this atomic overload.
create function public.create_market_with_county(
  p_name text, p_key text, p_country_code text, p_state_region text,
  p_county_name text, p_schedule_timezone text
) returns uuid
language plpgsql security definer set search_path='' as $create$
declare v_market_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_schedule_timezone is null or not exists (
    select 1 from pg_catalog.pg_timezone_names where name=p_schedule_timezone
  ) then raise exception 'Valid Market schedule time zone required'; end if;

  v_market_id:=public.create_market_with_county(
    trim(p_county_name),p_key,p_country_code,p_state_region,p_county_name
  );
  update public.event_processing_markets
  set max_concurrent_batches=2,max_concurrent_sources=16,
      schedule_timezone=p_schedule_timezone,updated_at=clock_timestamp()
  where id=v_market_id;
  return v_market_id;
end;
$create$;

revoke all on function public.create_market_with_county(text,text,text,text,text,text)
from public,anon,authenticated;
grant execute on function public.create_market_with_county(text,text,text,text,text,text)
to service_role;

create or replace function public.set_market_processing_enabled(
  p_market_id uuid,p_enabled boolean
) returns boolean
language plpgsql security definer set search_path='' as $enable$
declare
  m record;
  pool record;
  v_now timestamptz;
  v_required_sources bigint;
  v_required_workflows bigint;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  if p_market_id is null or p_enabled is null then return false; end if;

  -- Follow admission's global-pool -> Market lock order. Concurrent enables
  -- serialize here, so neither loses the other's required fleet capacity.
  select * into pool from public.event_processing_pool_config
  where singleton=true for update;
  if not found then raise exception 'Shared pool configuration missing'; end if;
  select * into m from public.event_processing_markets
  where id=p_market_id for update;
  if not found then return false; end if;
  v_now:=clock_timestamp();
  if p_enabled then
    if not exists (select 1 from public.event_processing_market_venues
                   where market_id=p_market_id) then
      raise exception 'Assign Spots before enabling Market';
    end if;
    select sum(greatest(max_concurrent_sources,16)),sum(greatest(max_concurrent_batches,2))
    into v_required_sources,v_required_workflows
    from public.event_processing_markets
    where is_enabled or id=p_market_id;

    update public.event_processing_pool_config
    set max_concurrent_sources=greatest(pool.max_concurrent_sources,v_required_sources),
        max_concurrent_batches=greatest(pool.max_concurrent_batches,v_required_workflows),
        updated_at=v_now
    where singleton=true
      and (max_concurrent_sources<v_required_sources
           or max_concurrent_batches<v_required_workflows);

    update public.event_processing_markets
    set is_enabled=true,schedule_enabled=true,
        max_concurrent_sources=greatest(m.max_concurrent_sources,16),
        max_concurrent_batches=greatest(m.max_concurrent_batches,2),
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
$enable$;

commit;
