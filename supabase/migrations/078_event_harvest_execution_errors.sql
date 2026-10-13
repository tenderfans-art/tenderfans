-- Persistent detector execution failures.
-- These are diagnostics, not source classification buckets.

create table public.event_harvest_execution_errors (
  venue_id uuid primary key references public.venues(id) on delete cascade,
  consecutive_failures integer not null default 0
    check (consecutive_failures >= 0),
  first_failed_at timestamptz,
  last_failed_at timestamptz,
  latest_stage text,
  latest_error text,
  resolved_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.event_harvest_execution_errors
  enable row level security;

revoke all on public.event_harvest_execution_errors
  from public, anon, authenticated;

grant select, insert, update
  on public.event_harvest_execution_errors to service_role;

create or replace function public.record_event_harvest_execution_result(
  p_venue_id uuid,
  p_errors jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message text;
  v_stage text;
begin
  if p_errors is null or jsonb_typeof(p_errors) <> 'array' then
    raise exception 'p_errors must be an array';
  end if;

  if jsonb_array_length(p_errors) = 0 then
    update public.event_harvest_execution_errors
       set consecutive_failures = 0,
           resolved_at = now(),
           updated_at = now()
     where venue_id = p_venue_id
       and resolved_at is null;
  else
    v_message := left(
      coalesce(p_errors->0->>'error', 'Detector execution failed'),
      4000
    );
    v_stage := left(
      coalesce(p_errors->0->>'stage', 'unknown'),
      100
    );

    insert into public.event_harvest_execution_errors (
      venue_id,
      consecutive_failures,
      first_failed_at,
      last_failed_at,
      latest_stage,
      latest_error,
      resolved_at,
      updated_at
    )
    values (
      p_venue_id, 1, now(), now(),
      v_stage, v_message, null, now()
    )
    on conflict (venue_id) do update set
      consecutive_failures = case
        when public.event_harvest_execution_errors.resolved_at is null
          then public.event_harvest_execution_errors.consecutive_failures + 1
        else 1
      end,
      first_failed_at = case
        when public.event_harvest_execution_errors.resolved_at is null
          then public.event_harvest_execution_errors.first_failed_at
        else now()
      end,
      last_failed_at = now(),
      latest_stage = excluded.latest_stage,
      latest_error = excluded.latest_error,
      resolved_at = null,
      updated_at = now();
  end if;
end;
$$;

revoke all on function
  public.record_event_harvest_execution_result(uuid,jsonb)
  from public, anon, authenticated;

grant execute on function
  public.record_event_harvest_execution_result(uuid,jsonb)
  to service_role;

create or replace function public.admin_event_harvest_active_errors()
returns table (
  venue_id uuid,
  venue_name text,
  website_url text,
  consecutive_failures integer,
  first_failed_at timestamptz,
  last_failed_at timestamptz,
  latest_stage text,
  latest_error text,
  needs_review boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    v.id,
    v.name::text,
    v.website_url::text,
    e.consecutive_failures,
    e.first_failed_at,
    e.last_failed_at,
    e.latest_stage,
    e.latest_error,
    e.consecutive_failures >= 3
  from public.event_harvest_execution_errors e
  join public.venues v on v.id = e.venue_id
  where e.resolved_at is null
    and v.status = 'active'
    and v.website_url is not null
  order by
    (e.consecutive_failures >= 3) desc,
    e.consecutive_failures desc,
    e.last_failed_at desc;
$$;

revoke all on function
  public.admin_event_harvest_active_errors()
  from public, anon, authenticated;

grant execute on function
  public.admin_event_harvest_active_errors()
  to service_role;
