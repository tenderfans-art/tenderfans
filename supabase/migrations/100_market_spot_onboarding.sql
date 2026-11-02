
-- 100: Market onboarding integration.
-- Additive: preserve existing Google review, detector, harvester,
-- work leases, execution fencing and publication functions.

-- Shared privileged market-assignment primitive.
-- The API-facing wrapper enforces service-role authorization.
-- The Google approval trigger calls this within its transaction.
create function public.assign_spot_to_market_internal(
  p_venue_id uuid,
  p_market_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_market_id uuid;
begin
  if p_venue_id is null or p_market_id is null then
    raise exception 'Spot and market are required';
  end if;

  if not exists (
    select 1 from public.venues where id = p_venue_id
  ) then
    raise exception 'Spot not found';
  end if;

  if not exists (
    select 1 from public.event_processing_markets
    where id = p_market_id
  ) then
    raise exception 'Market not found';
  end if;

  insert into public.event_processing_market_venues (
    venue_id, market_id
  )
  values (p_venue_id, p_market_id)
  on conflict (venue_id) do nothing;

  if found then
    return 'assigned';
  end if;

  select market_id into v_market_id
  from public.event_processing_market_venues
  where venue_id = p_venue_id;

  if v_market_id = p_market_id then
    return 'already_assigned';
  end if;

  raise exception 'Spot already belongs to another market';
end;
$$;

revoke all on function
  public.assign_spot_to_market_internal(uuid, uuid)
from public, anon, authenticated;

grant execute on function
  public.assign_spot_to_market_internal(uuid, uuid)
to service_role;


-- One atomic, conflict-safe market assignment operation.
create function public.assign_spot_to_market(
  p_venue_id uuid,
  p_market_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  return public.assign_spot_to_market_internal(
    p_venue_id, p_market_id
  );
end;
$$;

revoke all on function
  public.assign_spot_to_market(uuid, uuid)
from public, anon, authenticated;

grant execute on function
  public.assign_spot_to_market(uuid, uuid)
to service_role;


-- Durable destination for a Google identity awaiting review.
-- The existing Google review record remains authoritative.
-- A Place ID cannot silently acquire two different markets.
create table public.event_google_spot_market_requests (
  place_id text primary key
    references public.event_harvest_google_spot_reviews(place_id)
    on delete cascade,
  market_id uuid not null
    references public.event_processing_markets(id)
    on delete restrict,
  requested_at timestamptz not null default now()
);

create index event_google_spot_market_requests_market_idx
  on public.event_google_spot_market_requests(market_id);

alter table public.event_google_spot_market_requests
  enable row level security;

revoke all on public.event_google_spot_market_requests
from public, anon, authenticated;

grant select, insert on public.event_google_spot_market_requests
to service_role;


-- Store market context without modifying the existing
-- Google discovery or approval RPC signatures.
create function public.request_google_spot_market(
  p_place_id text,
  p_market_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_review record;
  v_market_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  select status, venue_id into v_review
  from public.event_harvest_google_spot_reviews
  where place_id = p_place_id
  for update;

  if not found then
    raise exception 'Google Spot discovery must be recorded first';
  end if;

  if v_review.status = 'rejected' then
    return 'rejected';
  end if;

  insert into public.event_google_spot_market_requests (
    place_id, market_id
  )
  values (p_place_id, p_market_id)
  on conflict (place_id) do nothing;

  select market_id into v_market_id
  from public.event_google_spot_market_requests
  where place_id = p_place_id;

  if v_market_id is distinct from p_market_id then
    raise exception
      'Google Place already requested for another market';
  end if;

  if v_review.status = 'approved'
     and v_review.venue_id is not null then
    perform public.assign_spot_to_market(
      v_review.venue_id, p_market_id
    );
    return 'assigned';
  end if;

  return 'pending';
end;
$$;

revoke all on function
  public.request_google_spot_market(text, uuid)
from public, anon, authenticated;

grant execute on function
  public.request_google_spot_market(text, uuid)
to service_role;


-- Existing Admin Spot Review approval automatically completes
-- any pending market assignment in the same transaction.
-- A membership conflict rolls back the approval rather than
-- leaving an approved review assigned to the wrong market.
create function public.complete_google_spot_market_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_market_id uuid;
begin
  if new.status <> 'approved'
     or new.venue_id is null then
    return new;
  end if;

  select market_id into v_market_id
  from public.event_google_spot_market_requests
  where place_id = new.place_id;

  if v_market_id is not null then
    perform public.assign_spot_to_market_internal(
      new.venue_id, v_market_id
    );
  end if;

  return new;
end;
$$;

create trigger complete_google_spot_market_request
after insert or update of status, venue_id
on public.event_harvest_google_spot_reviews
for each row
execute function public.complete_google_spot_market_request();

revoke all on function
  public.complete_google_spot_market_request()
from public, anon, authenticated;
