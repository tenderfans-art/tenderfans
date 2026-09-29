create table public.event_harvest_venue_scan_state (
  venue_id uuid not null
    references public.venues(id) on delete cascade,
  provider text not null,
  last_checked_at timestamptz not null default now(),
  last_result text not null
    check (
      last_result in (
        'auto_attached',
        'needs_review',
        'no_match',
        'rate_limited',
        'error'
      )
    ),
  last_error text,
  updated_at timestamptz not null default now(),

  primary key (venue_id, provider)
);

create index event_harvest_venue_scan_state_queue_idx
  on public.event_harvest_venue_scan_state (
    provider,
    last_checked_at
  );

alter table public.event_harvest_venue_scan_state
  enable row level security;

revoke all
on public.event_harvest_venue_scan_state
from public, anon, authenticated;


/*
 * Harvester-only scan-state writer.
 *
 * Upsert means every attempted Spot receives durable state,
 * including Spots for which Ticketmaster returned no credible match.
 */
create or replace function public.record_event_harvest_venue_scan(
  p_venue_id uuid,
  p_provider text,
  p_result text,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider text;
  v_result text;
begin
  v_provider := lower(trim(p_provider));
  v_result := lower(trim(p_result));

  if v_provider is null or v_provider = '' then
    raise exception 'Provider is required';
  end if;

  if v_result not in (
    'auto_attached',
    'needs_review',
    'no_match',
    'rate_limited',
    'error'
  ) then
    raise exception 'Invalid venue scan result: %', p_result;
  end if;

  if not exists (
    select 1
    from public.venues v
    where v.id = p_venue_id
  ) then
    raise exception 'TenderFans venue not found';
  end if;

  insert into public.event_harvest_venue_scan_state (
    venue_id,
    provider,
    last_checked_at,
    last_result,
    last_error,
    updated_at
  )
  values (
    p_venue_id,
    v_provider,
    now(),
    v_result,
    p_error,
    now()
  )
  on conflict (venue_id, provider)
  do update set
    last_checked_at = excluded.last_checked_at,
    last_result = excluded.last_result,
    last_error = excluded.last_error,
    updated_at = now();
end;
$$;

revoke all
on function public.record_event_harvest_venue_scan(
  uuid,
  text,
  text,
  text
)
from public, anon, authenticated;

grant execute
on function public.record_event_harvest_venue_scan(
  uuid,
  text,
  text,
  text
)
to service_role;
