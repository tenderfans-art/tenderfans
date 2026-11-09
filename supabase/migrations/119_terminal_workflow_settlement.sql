-- 119: Durable Workflow identity and terminal-run settlement.
-- Extends the existing shared dispatcher and reservation lifecycle.
-- No capacity, scheduling, cron, source eligibility, or publication changes.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '90s';

-- Each Workflow run may own at most one shared reservation.
-- Historical reservations without a recorded run remain untouched.
create unique index
  event_processing_reservations_workflow_run_unique
on public.event_processing_dispatch_reservations(workflow_run_id)
where workflow_run_id is not null;


create function public.bind_shared_harvester_workflow_run(
  p_market_id uuid,
  p_reservation_id uuid,
  p_run_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $bind_run$
declare
  v_bound uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  if p_market_id is null
     or p_reservation_id is null
     or nullif(trim(p_run_id), '') is null
     or length(p_run_id) > 256
  then
    return false;
  end if;

  -- Preserve global pool -> reservation lock ordering.
  perform 1
  from public.event_processing_pool_config
  where singleton = true
  for update;

  if not found then
    raise exception 'Shared pool configuration missing';
  end if;

  update public.event_processing_dispatch_reservations r
  set workflow_run_id = p_run_id
  where r.id = p_reservation_id
    and r.market_id = p_market_id
    and r.status in ('reserved', 'claimed')
    and r.expires_at > clock_timestamp()
    and (
      r.workflow_run_id is null
      or r.workflow_run_id = p_run_id
    )
  returning r.id into v_bound;

  return v_bound is not null;
end;
$bind_run$;


-- Called ONLY by the trusted dispatcher after the Workflow SDK
-- independently confirms that the bound run is terminal.
--
-- The original work/lease pair is authoritative. A superseded
-- lease, a completed item, or work owned by another execution
-- cannot be changed by terminal-run settlement.
--
-- Work settlement and reservation release are ONE transaction.
create function public.settle_terminal_shared_harvester_run(
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

  -- Safe, idempotent terminal replay.
  if v_reservation.status in ('released', 'expired') then
    return 0;
  end if;

  if v_reservation.status not in ('reserved', 'claimed') then
    raise exception 'Invalid reservation state';
  end if;

  v_now := clock_timestamp();

  -- Same failed-work retry/backoff policy as the existing
  -- fail_event_processing_work RPC.
  --
  -- Do not require the old lease's expiry: the Workflow
  -- provider has definitively ended the owning execution.
  -- Do require its exact original lease token.
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
    and w.lease_token = a.lease_token;

  get diagnostics v_settled = row_count;

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


revoke all on function
  public.bind_shared_harvester_workflow_run(uuid,uuid,text)
from public, anon, authenticated;

revoke all on function
  public.settle_terminal_shared_harvester_run(uuid,text,text)
from public, anon, authenticated;

grant execute on function
  public.bind_shared_harvester_workflow_run(uuid,uuid,text)
to service_role;

grant execute on function
  public.settle_terminal_shared_harvester_run(uuid,text,text)
to service_role;

commit;
