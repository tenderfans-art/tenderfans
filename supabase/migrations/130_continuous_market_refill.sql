-- 130: Continuously refill the existing scheduled Market Workflow lanes.
-- Existing runs keep their original deadlines; original executors and work
-- budgets, eligibility, source locks, retry policies and capacities are unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '90s';

do $baseline$
begin
  if (select md5(replace(prosrc,E'\r\n',E'\n')) from pg_catalog.pg_proc
      where oid='public.tf_cap_workflow_reservation_deadline()'::regprocedure)
     is distinct from '77c54377a0ce5085d3d3a516331cc71f' then
    raise exception '130: Reservation deadline guard differs from verified baseline';
  end if;
end;
$baseline$;

-- Bound runs continue to occupy Workflow capacity until SDK-confirmed
-- settlement, even when their admission heartbeat has expired.
do $capacity$
declare definition text;
begin
  if (select md5(replace(prosrc,E'\r\n',E'\n')) from pg_catalog.pg_proc
      where oid='public.reserve_shared_harvester_batch_scoped(uuid)'::regprocedure)
     is distinct from 'b1577e7100ff401d9284540f60a63768' then
    raise exception '130: Shared admission differs from verified baseline';
  end if;
  definition:=replace(pg_get_functiondef('public.reserve_shared_harvester_batch_scoped(uuid)'::regprocedure),E'\r\n',E'\n');
  definition:=replace(definition,'and r.expires_at > v_now',
    'and (r.expires_at > v_now or r.workflow_run_id is not null)');
  definition:=replace(definition,'and pr.expires_at > v_now',
    'and (pr.expires_at > v_now or pr.workflow_run_id is not null)');
  execute definition;
end;
$capacity$;

alter table public.event_processing_dispatch_reservations
  drop constraint event_processing_dispatch_reservations_work_type_check;
alter table public.event_processing_dispatch_reservations
  add constraint event_processing_dispatch_reservations_work_type_check
  check (work_type in ('harvest_source','detect_spot','archive_recheck','harvest_provider','market_scan')),
  add column refill_cycle_id uuid,
  add column refill_stopped_at timestamptz,
  add column refill_cancel_at timestamptz,
  add constraint refill_cycle_scope foreign key (refill_cycle_id,market_id)
    references public.event_processing_market_cycles(id,market_id),
  add constraint refill_reservation_shape check (
    (work_type='market_scan') = (refill_cycle_id is not null)
    and (refill_stopped_at is null) = (refill_cancel_at is null)
  );
alter table public.shared_harvester_source_assignments
  add column claimed_work_type text check (
    claimed_work_type in ('detect_spot','harvest_source','archive_recheck','harvest_provider')
  );

create or replace function public.tf_cap_workflow_reservation_deadline()
returns trigger language plpgsql set search_path='' as $deadline$
begin
  -- A bound run is released only through verified terminal settlement or
  -- acknowledged finalization, including when its admission heartbeat expires.
  if TG_OP='UPDATE' and old.workflow_run_id is not null
     and old.status in ('reserved','claimed') and new.status='expired' then
    return null;
  end if;
  if new.status in ('reserved','claimed') then
    if new.work_type='market_scan' then
      -- A successful claim/poll keeps a healthy durable run alive. Each item
      -- still has its original independent 30-minute hard deadline.
      new.expires_at := least(new.expires_at,clock_timestamp()+interval '35 minutes');
      if new.refill_cancel_at is not null then
        new.expires_at := least(new.expires_at,new.refill_cancel_at);
      end if;
    else
      -- Do not change the policy of already-running, deployment-pinned runs.
      new.expires_at := least(new.expires_at,new.reserved_at+interval '55 minutes');
    end if;
  end if;
  return new;
end;
$deadline$;

-- Only an unstarted, unassigned reservation may opt into the new protocol.
-- Its cycle is immutable, so an idle run cannot consume tomorrow's cohort.
create function public.prepare_shared_market_refill(p_reservation_id uuid)
returns boolean language plpgsql security definer set search_path='' as $prepare$
declare r public.event_processing_dispatch_reservations%rowtype; v_cycle uuid;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform 1 from public.event_processing_pool_config where singleton=true for update;
  select * into r from public.event_processing_dispatch_reservations
    where id=p_reservation_id for update;
  if not found or r.status<>'reserved' or r.workflow_run_id is not null
     or r.expires_at<=clock_timestamp()
     or exists(select 1 from public.shared_harvester_source_assignments a where a.reservation_id=r.id) then
    return false;
  end if;
  select c.id into v_cycle
  from public.event_processing_market_cycles c
  join public.event_processing_markets m on m.id=c.market_id
  where c.market_id=r.market_id and c.status='running'
    and m.is_enabled and m.schedule_enabled;
  if not found then return false; end if;
  update public.event_processing_dispatch_reservations
  set work_type='market_scan',refill_cycle_id=v_cycle,
      expires_at=least(expires_at,clock_timestamp()+interval '10 minutes')
  where id=r.id;
  return true;
end;
$prepare$;

-- Internal helper. Seal new admission BEFORE choosing a cancellation time.
-- No active item loses its full immutable execution window plus cleanup margin.
create function public.stop_shared_market_refill(p_reservation_id uuid)
returns timestamptz language plpgsql security definer set search_path='' as $stop$
declare r public.event_processing_dispatch_reservations%rowtype; v_last_deadline timestamptz;
begin
  perform 1 from public.event_processing_pool_config where singleton=true for update;
  select * into r from public.event_processing_dispatch_reservations
    where id=p_reservation_id and work_type='market_scan' for update;
  if not found then raise exception 'Continuous reservation not found'; end if;
  if r.refill_cancel_at is not null then return r.refill_cancel_at; end if;
  select max(a.claimed_leased_until) into v_last_deadline
  from public.shared_harvester_source_assignments a
  join public.event_processing_work w on w.id=a.work_id and w.lease_token=a.lease_token
  where a.reservation_id=r.id and w.status='leased';
  update public.event_processing_dispatch_reservations
  set refill_stopped_at=clock_timestamp(),
      refill_cancel_at=greatest(clock_timestamp(),v_last_deadline)+interval '5 minutes',
      expires_at=greatest(clock_timestamp(),v_last_deadline)+interval '5 minutes'
  where id=r.id returning refill_cancel_at into v_last_deadline;
  return v_last_deadline;
end;
$stop$;

-- Called by the existing dispatcher only after obtaining the bound SDK run.
-- A healthy run may last through the whole finite cycle. Expired/unacknowledged
-- assignments or a dead admission heartbeat seal it for bounded recovery.
create function public.reconcile_shared_market_refill(p_reservation_id uuid,p_run_id text)
returns timestamptz language plpgsql security definer set search_path='' as $monitor$
declare r public.event_processing_dispatch_reservations%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform 1 from public.event_processing_pool_config where singleton=true for update;
  select * into r from public.event_processing_dispatch_reservations
    where id=p_reservation_id and workflow_run_id=p_run_id and work_type='market_scan' for update;
  if not found then raise exception 'Reservation does not belong to continuous Workflow'; end if;
  if r.status not in ('reserved','claimed') then return null; end if;
  if r.refill_cancel_at is not null then return r.refill_cancel_at; end if;
  if r.expires_at<=clock_timestamp() or exists (
    select 1 from public.shared_harvester_source_assignments a
    join public.event_processing_work w on w.id=a.work_id and w.lease_token=a.lease_token
    where a.reservation_id=r.id and w.status='leased' and w.leased_until<=clock_timestamp()
  ) then return public.stop_shared_market_refill(r.id); end if;
  return null;
end;
$monitor$;

create function public.claim_refilling_market_assignment(p_reservation_id uuid,p_slot_number integer)
returns jsonb language plpgsql security definer set search_path='' as $claim$
declare
  r public.event_processing_dispatch_reservations%rowtype;
  a public.shared_harvester_source_assignments%rowtype;
  picked public.event_processing_work%rowtype;
  v_now timestamptz; v_global_limit integer; v_workflow_limit integer;
  v_market_limit integer; v_global_active integer; v_market_active integer;
  v_next_due timestamptz; v_delay_ms integer:=60000;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_reservation_id is null or p_slot_number is null or p_slot_number<0 then
    raise exception 'Invalid assignment arguments';
  end if;
  select max_concurrent_sources,max_concurrent_batches into v_global_limit,v_workflow_limit
  from public.event_processing_pool_config where singleton=true for update;
  if not found then raise exception 'Shared pool configuration missing'; end if;
  select * into r from public.event_processing_dispatch_reservations
    where id=p_reservation_id and work_type='market_scan' for update;
  if not found or r.workflow_run_id is null then raise exception 'Bound continuous reservation required'; end if;

  -- Immutable replay comes before every clock, state and queue check.
  select * into a from public.shared_harvester_source_assignments
    where reservation_id=r.id and slot_number=p_slot_number;
  if found then
    return jsonb_build_object('kind','work','item',jsonb_build_object(
      'work_id',a.work_id,'claimed_work_type',a.claimed_work_type,
      'claimed_batch_id',a.claimed_batch_id,'claimed_lease_token',a.lease_token,
      'claimed_attempt',a.claimed_attempt,'claimed_venue_id',a.claimed_venue_id,
      'claimed_source_id',a.claimed_source_id,'claimed_leased_until',a.claimed_leased_until));
  end if;
  if r.status not in ('reserved','claimed') or r.refill_stopped_at is not null then
    return jsonb_build_object('kind','stop');
  end if;
  perform 1 from public.event_processing_markets m
  join public.event_processing_market_cycles c on c.id=r.refill_cycle_id and c.market_id=m.id
  where m.id=r.market_id and m.is_enabled and c.status='running' for update of m;
  if not found then return jsonb_build_object('kind','stop'); end if;
  v_now:=clock_timestamp();
  if r.expires_at<=v_now or exists (
    select 1 from public.shared_harvester_source_assignments old_assignment
    join public.event_processing_work w on w.id=old_assignment.work_id and w.lease_token=old_assignment.lease_token
    where old_assignment.reservation_id=r.id and w.status='leased' and w.leased_until<=v_now
  ) then
    perform public.stop_shared_market_refill(r.id);
    return jsonb_build_object('kind','stop');
  end if;

  -- Preserve bounded access to the shared fleet for other due Markets.
  -- A lone busy Market never drains merely because its run reached 20 minutes.
  if r.reserved_at+interval '20 minutes'<=v_now
     and (select count(*) from public.event_processing_dispatch_reservations live
          where live.status in ('reserved','claimed') and live.expires_at>v_now)>=v_workflow_limit
     and exists (
       select 1 from public.event_processing_markets other
       where other.id<>r.market_id and other.is_enabled
         and (select count(*) from public.event_processing_dispatch_reservations live
              where live.market_id=other.id and live.status in ('reserved','claimed')
                and live.expires_at>v_now)<other.max_concurrent_batches
         and exists (
           select 1 from public.event_processing_work waiting
           where waiting.market_id=other.id and waiting.status in ('pending','retry')
             and waiting.attempts<waiting.max_attempts and waiting.due_at<=v_now
             and public.shared_market_work_eligible(other.id,waiting.work_type,waiting.venue_id,waiting.source_id,v_now)
         )
     ) then
    perform public.stop_shared_market_refill(r.id);
    return jsonb_build_object('kind','stop');
  end if;

  if not exists(select 1 from public.event_processing_work w
      where w.market_cycle_id=r.refill_cycle_id and w.status in ('pending','retry','leased')) then
    return jsonb_build_object('kind','stop');
  end if;
  select e.allowed_sources into v_market_limit
  from public.market_shared_harvester_entitlement(r.market_id) e;
  if not found then return jsonb_build_object('kind','stop'); end if;
  select count(*)::integer,count(*) filter(where w.market_id=r.market_id)::integer
  into v_global_active,v_market_active from public.event_processing_work w
  where w.work_type in ('detect_spot','harvest_source','archive_recheck','harvest_provider')
    and w.status='leased' and w.leased_until>v_now;

  if v_global_active<v_global_limit and v_market_active<v_market_limit then
    -- Work-type fairness remains inside the original Market pool. A free lane
    -- can take a Spot when shared sources are exhausted or waiting for backoff.
    with history as materialized (
      select claimed_work_type,max(assigned_at) as last_assigned
      from public.shared_harvester_source_assignments where reservation_id=r.id
      group by claimed_work_type
    ), selected as materialized (
      select w.id from public.event_processing_work w
      left join history h on h.claimed_work_type=w.work_type
      where w.market_id=r.market_id and w.market_cycle_id=r.refill_cycle_id
        and w.status in ('pending','retry') and w.due_at<=v_now and w.attempts<w.max_attempts
        and public.shared_market_work_eligible(r.market_id,w.work_type,w.venue_id,w.source_id,v_now)
        and (w.work_type<>'harvest_provider' or (
          not exists(select 1 from public.event_processing_work pw
            where pw.work_type='harvest_provider' and pw.status='leased' and pw.leased_until>v_now)
          and not exists(select 1 from public.event_processing_dispatch_reservations pr
            where pr.work_type='harvest_provider' and pr.status in ('reserved','claimed') and pr.expires_at>v_now)
        ))
      order by h.last_assigned asc nulls first,w.priority,w.due_at,w.id
      limit 1 for update of w skip locked
    )
    update public.event_processing_work w
    set status='leased',batch_id=gen_random_uuid(),lease_token=gen_random_uuid(),
        leased_until=v_now+interval '30 minutes',attempts=w.attempts+1,
        last_started_at=v_now,last_finished_at=null,last_error=null,updated_at=v_now
    from selected s where w.id=s.id returning w.* into picked;
    if found then
      insert into public.shared_harvester_source_assignments(
        reservation_id,slot_number,work_id,lease_token,claimed_batch_id,claimed_attempt,
        claimed_venue_id,claimed_source_id,claimed_leased_until,claimed_work_type
      ) values (r.id,p_slot_number,picked.id,picked.lease_token,picked.batch_id,picked.attempts,
        picked.venue_id,picked.source_id,picked.leased_until,picked.work_type);
      update public.event_processing_dispatch_reservations
      set status='claimed',claimed_at=coalesce(claimed_at,v_now),expires_at=v_now+interval '35 minutes'
      where id=r.id;
      return jsonb_build_object('kind','work','item',jsonb_build_object(
        'work_id',picked.id,'claimed_work_type',picked.work_type,'claimed_batch_id',picked.batch_id,
        'claimed_lease_token',picked.lease_token,'claimed_attempt',picked.attempts,
        'claimed_venue_id',picked.venue_id,'claimed_source_id',picked.source_id,
        'claimed_leased_until',picked.leased_until));
    end if;
  end if;
  -- Temporary capacity, locks, other in-flight items or future retry due times
  -- never permanently retire a lane. Durable sleep keeps polling bounded.
  update public.event_processing_dispatch_reservations
  set expires_at=v_now+interval '35 minutes' where id=r.id;
  select min(w.due_at) into v_next_due from public.event_processing_work w
  where w.market_cycle_id=r.refill_cycle_id and w.status in ('pending','retry')
    and w.attempts<w.max_attempts and w.due_at>v_now;
  if v_next_due is not null then
    v_delay_ms:=greatest(1000,least(60000,ceil(extract(epoch from(v_next_due-v_now))*1000)))::integer;
  end if;
  return jsonb_build_object('kind','wait','delay_ms',v_delay_ms);
end;
$claim$;

create function public.list_refilling_market_runs_to_reconcile(p_limit integer default 32)
returns table(id uuid,workflow_run_id text,reserved_at timestamptz,work_type text)
language sql security definer set search_path='' as $runs$
  select original.id,original.workflow_run_id,original.reserved_at,r.work_type
  from public.list_shared_harvester_runs_to_reconcile(p_limit) original
  join public.event_processing_dispatch_reservations r on r.id=original.id;
$runs$;

revoke all on function public.stop_shared_market_refill(uuid) from public,anon,authenticated,service_role;
revoke all on function public.prepare_shared_market_refill(uuid),
  public.reconcile_shared_market_refill(uuid,text),public.claim_refilling_market_assignment(uuid,integer),
  public.list_refilling_market_runs_to_reconcile(integer) from public,anon,authenticated;
grant execute on function public.prepare_shared_market_refill(uuid),
  public.reconcile_shared_market_refill(uuid,text),public.claim_refilling_market_assignment(uuid,integer),
  public.list_refilling_market_runs_to_reconcile(integer) to service_role;
notify pgrst,'reload schema';
commit;
