-- TenderFans V1 notification signup rate limiting.
-- Stores only a SHA-256 hash of the client IP, never the raw IP.

create table public.notification_rate_limits (
  ip_hash text primary key,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 1
    check (request_count >= 1)
);

alter table public.notification_rate_limits enable row level security;

revoke all on table public.notification_rate_limits
from public, anon, authenticated;

grant all on table public.notification_rate_limits
to service_role;

create or replace function public.check_notification_rate_limit(
  p_ip_hash text,
  p_limit integer default 5,
  p_window_minutes integer default 15
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_row public.notification_rate_limits%rowtype;
begin
  if p_ip_hash is null or length(p_ip_hash) <> 64 then
    return false;
  end if;

  if p_limit < 1 or p_window_minutes < 1 then
    return false;
  end if;

  insert into public.notification_rate_limits (
    ip_hash,
    window_started_at,
    request_count
  )
  values (
    p_ip_hash,
    v_now,
    1
  )
  on conflict (ip_hash) do update
  set
    window_started_at =
      case
        when public.notification_rate_limits.window_started_at
             <= v_now - make_interval(mins => p_window_minutes)
          then v_now
        else public.notification_rate_limits.window_started_at
      end,
    request_count =
      case
        when public.notification_rate_limits.window_started_at
             <= v_now - make_interval(mins => p_window_minutes)
          then 1
        else public.notification_rate_limits.request_count + 1
      end
  returning * into v_row;

  return v_row.request_count <= p_limit;
end;
$$;

revoke all on function public.check_notification_rate_limit(
  text,
  integer,
  integer
)
from public, anon, authenticated;

grant execute on function public.check_notification_rate_limit(
  text,
  integer,
  integer
)
to service_role;
