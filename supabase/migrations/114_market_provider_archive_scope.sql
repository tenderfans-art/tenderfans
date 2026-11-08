-- 114: Market-scoped provider/archive execution foundation.
--
-- Existing global Ticketmaster and archive cron behavior
-- remains intact.
--
-- This migration adds only a scoped archive claim operation.
-- Ticketmaster Market filtering is performed by the existing
-- authenticated server-side route.
--
-- Work admission and scheduled activation follow separately.
-- No Markets are enabled and no existing cron is changed.

begin;

create function public.claim_market_event_harvest_archive_rechecks(
  p_market_id uuid,
  p_limit integer default 30
)
returns table (
  venue_id uuid,
  lease_token uuid
)
language plpgsql
security definer
set search_path = ''
as $market_archive_claim$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  if p_market_id is null
     or p_limit is null
     or p_limit not between 1 and 100
  then
    raise exception 'Invalid Market archive claim arguments';
  end if;

  if not exists (
    select 1
    from public.event_processing_markets m
    where m.id = p_market_id
      and m.is_enabled = true
  ) then
    raise exception 'Market is missing or disabled';
  end if;

  /*
   * Preserve the original archive claim lifecycle:
   *   - due-date gating
   *   - active Spot eligibility
   *   - SKIP LOCKED
   *   - two-hour provisional ownership
   *   - archive_lease_token
   *
   * Only add the authoritative Market membership gate.
   *
   * The existing global claim RPC is deliberately unchanged.
   */
  return query
  with due as materialized (
    select a.venue_id
    from public.event_harvest_archive a
    join public.venues v
      on v.id = a.venue_id
    join public.event_processing_market_venues mv
      on mv.venue_id = a.venue_id
    where mv.market_id = p_market_id
      and a.restored_at is null
      and a.next_check_at <= now()
      and v.status = 'active'
      and v.website_url is not null
    order by a.next_check_at, a.venue_id
    limit p_limit
    for update of a skip locked
  ),
  claimed as (
    update public.event_harvest_archive a
    set next_check_at = now() + interval '2 hours',
        archive_lease_token = gen_random_uuid()
    from due
    where a.venue_id = due.venue_id
    returning a.venue_id, a.archive_lease_token
  )
  select claimed.venue_id, claimed.archive_lease_token
  from claimed;
end;
$market_archive_claim$;

revoke all on function
  public.claim_market_event_harvest_archive_rechecks(uuid,integer)
from public, anon, authenticated;

grant execute on function
  public.claim_market_event_harvest_archive_rechecks(uuid,integer)
to service_role;

commit;
