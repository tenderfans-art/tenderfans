-- 117: Defer provider contention without consuming failure attempts.
-- Reuses existing shared work ownership and admission.
-- No Market activation, new worker pool, or cron changes.

begin;

create function public.defer_shared_market_provider_work(
  p_work_id uuid,
  p_lease_token uuid,
  p_delay_seconds integer default 60
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $defer$
declare
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  if p_work_id is null
     or p_lease_token is null
     or p_delay_seconds is null
     or p_delay_seconds not between 15 and 600
  then
    return false;
  end if;

  update public.event_processing_work w
  set status = 'retry',
      due_at = v_now + make_interval(
        secs => p_delay_seconds
      ),
      attempts = greatest(0, w.attempts - 1),
      lease_token = null,
      leased_until = null,
      last_finished_at = v_now,
      last_error = null,
      updated_at = v_now
  where w.id = p_work_id
    and w.work_type = 'harvest_provider'
    and w.status = 'leased'
    and w.lease_token = p_lease_token
    and w.leased_until > v_now;

  return found;
end;
$defer$;

revoke all on function
  public.defer_shared_market_provider_work(
    uuid,uuid,integer
  )
from public, anon, authenticated;

grant execute on function
  public.defer_shared_market_provider_work(
    uuid,uuid,integer
  )
to service_role;

commit;
