-- 129: Recover unacknowledged work belonging to closed Workflow reservations.
-- Scheduler accounting only. Existing source pipelines and retry budgets stay intact.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '90s';

do $$
declare expected record;
begin
  for expected in select * from (values
    ('public.finalize_shared_harvester_reservation(uuid)', 'c92b01505d4cf29874544b401675a8da'),
    ('public.settle_terminal_shared_harvester_run(uuid,text,text)', '9d1f7ef8bd460c5cfec76f2c807a93e5')
  ) as baseline(signature, body_hash) loop
    if (select md5(replace(prosrc, E'\r\n', E'\n')) from pg_catalog.pg_proc
        where oid = expected.signature::regprocedure) is distinct from expected.body_hash then
      raise exception '129: % differs from the verified baseline', expected.signature;
    end if;
  end loop;
end;
$$;

create or replace function public.finalize_shared_harvester_reservation(
  p_reservation_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $finalize$
declare
  v_status text;
begin
  if p_reservation_id is null then
    return false;
  end if;

  perform 1
  from public.event_processing_pool_config
  where singleton = true
  for update;

  if not found then
    raise exception 'Shared pool configuration missing';
  end if;

  select r.status
    into v_status
  from public.event_processing_dispatch_reservations r
  where r.id = p_reservation_id
  for update;

  if not found then
    return false;
  end if;

  if v_status in ('released', 'expired') then
    return true;
  end if;

  if v_status not in ('reserved', 'claimed') then
    return false;
  end if;

  -- Keep admission until every original assignment is acknowledged,
  -- including an expired lease that still needs terminal-run settlement.
  -- A superseded lease token does not block finalization.
  if exists (
    select 1
    from public.shared_harvester_source_assignments a
    join public.event_processing_work w
      on w.id = a.work_id
    where a.reservation_id = p_reservation_id
      and w.status = 'leased'
      and w.lease_token = a.lease_token
  ) then
    return false;
  end if;

  -- Source execution ownership and write fencing are unchanged.
  update public.event_processing_dispatch_reservations r
  set status = 'released',
      released_at = clock_timestamp()
  where r.id = p_reservation_id
    and r.status in ('reserved', 'claimed');

  return found;
end;
$finalize$;

create or replace function public.settle_terminal_shared_harvester_run(
  p_reservation_id uuid,
  p_run_id text,
  p_terminal_status text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $terminal_settlement$
declare
  v_reservation public.event_processing_dispatch_reservations%rowtype;
  v_now timestamptz;
  v_settled integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  if p_reservation_id is null
     or nullif(trim(p_run_id), '') is null
     or p_terminal_status not in (
       'completed', 'failed', 'cancelled', 'canceled'
     )
  then
    raise exception 'Invalid terminal Workflow settlement';
  end if;

  -- Same serialization order as admission and finalization.
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
    and r.workflow_run_id = p_run_id
  for update;

  if not found then
    raise exception 'Reservation does not belong to Workflow run';
  end if;

  -- Closed reservations may still own unacknowledged expired work.
  if v_reservation.status not in ('reserved', 'claimed', 'released', 'expired') then
    raise exception 'Invalid reservation state';
  end if;

  v_now := clock_timestamp();

  -- Same failed-work retry/backoff policy as the existing
  -- fail_event_processing_work RPC.
  --
  -- The trusted dispatcher first verifies terminal status with the SDK.
  -- Closed reservations additionally require lease expiry. Every case
  -- still requires the exact immutable assignment lease token.
  update public.event_processing_work w
  set
    status = case
      when w.attempts >= w.max_attempts
        then 'failed'
      else 'retry'
    end,
    due_at = case
      when w.attempts >= w.max_attempts
        then w.due_at
      else v_now + make_interval(
        mins => least(
          60,
          power(
            2::numeric,
            least(w.attempts - 1, 6)
          )::integer
        )
      )
    end,
    lease_token = null,
    leased_until = null,
    last_finished_at = v_now,
    last_error = left(
      'Workflow ' || p_run_id || ' reached terminal status ' ||
      p_terminal_status ||
      ' before work acknowledgement',
      2000
    ),
    updated_at = v_now
  from public.shared_harvester_source_assignments a
  where a.reservation_id = v_reservation.id
    and a.work_id = w.id
    and w.status = 'leased'
    and w.lease_token = a.lease_token
    and (v_reservation.status in ('reserved', 'claimed') or w.leased_until <= v_now);

  get diagnostics v_settled = row_count;

  -- Preserve the original closure timestamp on an orphan recovery or replay.
  if v_reservation.status in ('released', 'expired') then
    return v_settled;
  end if;

  -- This update is intentionally AFTER work settlement and
  -- inside the SAME transaction.
  update public.event_processing_dispatch_reservations r
  set
    status = 'released',
    released_at = v_now
  where r.id = v_reservation.id
    and r.workflow_run_id = p_run_id
    and r.status in ('reserved', 'claimed');

  if not found then
    raise exception 'Atomic reservation release failed';
  end if;

  return v_settled;
end;
$terminal_settlement$;

-- The expired-work index drives orphan discovery; closed reservation history
-- is not scanned on every tick. No provider status is inferred here.
create function public.list_shared_harvester_runs_to_reconcile(p_limit integer default 32)
returns table(id uuid, workflow_run_id text, reserved_at timestamptz)
language plpgsql security definer set search_path = '' as $runs$
declare v_now timestamptz := clock_timestamp();
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  if p_limit is null or p_limit not between 1 and 64 then
    raise exception 'Invalid Workflow reconciliation limit';
  end if;
  return query
  with candidates as (
    select r.id, r.workflow_run_id, r.reserved_at, false as closed
    from public.event_processing_dispatch_reservations r
    where r.status in ('reserved', 'claimed') and r.workflow_run_id is not null
    union all
    select distinct r.id, r.workflow_run_id, r.reserved_at, true as closed
    from public.event_processing_work w
    join public.shared_harvester_source_assignments a
      on a.work_id = w.id and a.lease_token = w.lease_token
    join public.event_processing_dispatch_reservations r on r.id = a.reservation_id
    where w.status = 'leased' and w.leased_until <= v_now
      and r.status in ('released', 'expired') and r.workflow_run_id is not null
  )
  select c.id, c.workflow_run_id, c.reserved_at from candidates c
  order by c.closed, c.reserved_at, c.id limit p_limit;
end;
$runs$;

revoke all on function public.list_shared_harvester_runs_to_reconcile(integer)
from public, anon, authenticated;
grant execute on function public.list_shared_harvester_runs_to_reconcile(integer) to service_role;

notify pgrst, 'reload schema';
commit;
