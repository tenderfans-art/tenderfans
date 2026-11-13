-- 122: Hard execution ownership ceilings and safe stale-lock recovery.
-- One work item and one Workflow reservation: maximum 30 minutes.
-- No changes to event inventory, candidates, approvals or publication.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '90s';

do $preflight$
begin
  if exists (
    select 1
    from public.event_processing_work
    where status = 'leased'
      and last_started_at is null
  ) then
    raise exception
      '122: leased work without original start time';
  end if;

  if not exists (
    select 1
    from public.event_processing_markets
    where market_key = 'pinellas-county'
  ) then
    raise exception '122: Pinellas Market missing';
  end if;
end;
$preflight$;

-- Authoritative deadline: renewal cannot extend a work item
-- beyond 30 minutes from its original claim.
create function public.tf_cap_work_execution_deadline()
returns trigger
language plpgsql
set search_path = ''
as $deadline$
begin
  if new.status = 'leased' then
    if new.last_started_at is null
       or new.leased_until is null then
      raise exception
        'Leased work requires start and expiry';
    end if;

    new.leased_until := least(
      new.leased_until,
      new.last_started_at + interval '30 minutes'
    );
  end if;

  return new;
end;
$deadline$;

create trigger tf_cap_work_execution_deadline
before insert or update
on public.event_processing_work
for each row
execute function public.tf_cap_work_execution_deadline();

-- A Workflow cannot retain admission for four hours.
-- Cap ALL reservations, including those created by older RPCs.
create function public.tf_cap_workflow_reservation_deadline()
returns trigger
language plpgsql
set search_path = ''
as $deadline$
begin
  if TG_OP = 'UPDATE'
     and old.workflow_run_id is not null
     and old.status in ('reserved', 'claimed')
     and new.status = 'expired' then
    return null;
  end if;

  if new.status in ('reserved', 'claimed') then
    new.expires_at := least(
      new.expires_at,
      new.reserved_at + interval '30 minutes'
    );
  end if;

  return new;
end;
$deadline$;

create trigger tf_cap_workflow_reservation_deadline
before insert or update
on public.event_processing_dispatch_reservations
for each row
execute function public.tf_cap_workflow_reservation_deadline();

-- Apply both guards to existing live ownership.
-- Expiry alone does not delete work or source inventory.
update public.event_processing_work
set leased_until = least(
  leased_until,
  last_started_at + interval '30 minutes'
)
where status = 'leased'
  and leased_until >
    last_started_at + interval '30 minutes';

update public.event_processing_dispatch_reservations
set expires_at = least(
  expires_at,
  reserved_at + interval '30 minutes'
)
where status in ('reserved', 'claimed')
  and expires_at >
    reserved_at + interval '30 minutes';

-- Every fenced source write, including standalone ingestion,
-- must prove that its original source execution is still live.
--
-- Lock first, then check current time: recovery cannot revoke
-- ownership during a protected write transaction.
create or replace function
public.assert_first_party_execution_ownership(
  p_source_id uuid,
  p_execution_token uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $ownership$
declare
  v_started_at timestamptz;
begin
  if p_source_id is null
     or p_execution_token is null then
    raise exception
      'First-party execution ownership requires source and token';
  end if;

  select e.started_at
    into v_started_at
  from public.first_party_source_executions e
  where e.source_id = p_source_id
    and e.execution_token = p_execution_token
  for update;

  if not found then
    raise exception
      'First-party execution ownership lost for source %',
      p_source_id;
  end if;

  if v_started_at + interval '30 minutes'
       <= clock_timestamp() then
    raise exception
      'First-party source execution deadline exceeded for %',
      p_source_id;
  end if;
end;
$ownership$;

-- Standalone source locks have no Market lease, so they need
-- their own token-checked, transactionally safe recovery.
-- Never remove a market-bound execution through this RPC.
create function
public.recover_expired_standalone_source_executions(
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = ''
as $recover$
declare
  v_candidate record;
  v_lock record;
  v_recovered integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  if p_limit is null
     or p_limit not between 1 and 1000 then
    raise exception 'Invalid recovery limit';
  end if;

  for v_candidate in
    select e.source_id
    from public.first_party_source_executions e
    where e.market_work_id is null
      and e.started_at + interval '30 minutes'
          <= clock_timestamp()
    order by e.started_at, e.source_id
    limit p_limit
  loop
    select e.execution_token, e.started_at
      into v_lock
    from public.first_party_source_executions e
    where e.source_id = v_candidate.source_id
      and e.market_work_id is null
    for update skip locked;

    if not found
       or v_lock.started_at + interval '30 minutes'
            > clock_timestamp() then
      continue;
    end if;

    delete from public.first_party_source_executions e
    where e.source_id = v_candidate.source_id
      and e.execution_token = v_lock.execution_token
      and e.market_work_id is null
      and e.started_at + interval '30 minutes'
          <= clock_timestamp();

    if found then
      insert into public.first_party_execution_recoveries (
        source_id,
        previous_execution_token,
        reason
      )
      values (
        v_candidate.source_id,
        v_lock.execution_token,
        'automatic_standalone_30_minute_deadline'
      );

      v_recovered := v_recovered + 1;
    end if;
  end loop;

  return v_recovered;
end;
$recover$;

revoke all on function
  public.recover_expired_standalone_source_executions(integer)
from public, anon, authenticated;

grant execute on function
  public.recover_expired_standalone_source_executions(integer)
to service_role;

-- Also make the standalone claim path self-healing.
-- Recovery never replaces a live lock and never replaces a
-- market-bound execution. The token remains authoritative.
create or replace function
public.claim_first_party_source_execution(
  p_source_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $claim$
declare
  v_token uuid := gen_random_uuid();
  v_old record;
begin
  if p_source_id is null then
    raise exception 'Source ID is required';
  end if;

  select e.execution_token, e.started_at
    into v_old
  from public.first_party_source_executions e
  where e.source_id = p_source_id
    and e.market_work_id is null
    and e.started_at + interval '30 minutes'
        <= clock_timestamp()
  for update skip locked;

  if found then
    delete from public.first_party_source_executions e
    where e.source_id = p_source_id
      and e.execution_token = v_old.execution_token
      and e.market_work_id is null
      and e.started_at + interval '30 minutes'
          <= clock_timestamp();

    if found then
      insert into public.first_party_execution_recoveries (
        source_id,
        previous_execution_token,
        reason
      )
      values (
        p_source_id,
        v_old.execution_token,
        'standalone_reclaim_at_claim'
      );
    end if;
  end if;

  insert into public.first_party_source_executions (
    source_id,
    execution_token
  )
  values (p_source_id, v_token)
  on conflict (source_id) do nothing;

  if found then
    return v_token;
  end if;

  return null;
end;
$claim$;

-- Retire obsolete queue RECORDS left by the Spot-first cutover.
-- These are never eligible for independent source processing.
-- Do not touch leased work, source registrations or event data.
do $retire$
declare
  v_count integer;
begin
  update public.event_processing_work w
  set status = 'cancelled',
      last_finished_at = clock_timestamp(),
      last_error =
        'Obsolete Spot-owned source job: now processed by Spot-first',
      updated_at = clock_timestamp()
  from public.event_harvest_sources s
  where w.work_type = 'harvest_source'
    and w.source_id = s.id
    and s.venue_id is not null
    and w.status in ('pending', 'retry');

  get diagnostics v_count = row_count;

  raise notice
    '122: retired % obsolete queued Spot-owned source jobs',
    v_count;
end;
$retire$;

commit;
