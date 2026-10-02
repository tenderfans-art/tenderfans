-- ============================================================
-- ADMIN UNRESOLVED VENUE QUEUE — SOURCE URL
--
-- Expose the harvested source URL to the Admin review queue so
-- event titles can link directly to the publisher/source page.
-- ============================================================

drop function if exists
public.admin_pending_event_harvest_unresolved_venues();

create function
public.admin_pending_event_harvest_unresolved_venues()
returns table(
  id uuid,
  source_id uuid,
  source_name text,
  external_event_id text,
  event_title text,
  starts_at text,
  source_url text,
  publisher_venue_name text,
  publisher_address text,
  publisher_city text,
  publisher_state_region text,
  publisher_postal_code text,
  suggested_venue_id uuid,
  suggested_venue_name text,
  confidence_score numeric,
  evidence jsonb,
  first_seen_at timestamptz,
  last_seen_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  ) then
    raise exception 'Admin access required';
  end if;

  return query
  select
    u.id,
    u.source_id,
    s.name as source_name,
    u.external_event_id,
    u.raw_title as event_title,
    u.raw_starts_at as starts_at,
    u.source_url,
    u.publisher_venue_name,
    u.publisher_address,
    u.publisher_city,
    u.publisher_state_region,
    u.publisher_postal_code,
    u.suggested_venue_id,
    v.name as suggested_venue_name,
    u.confidence_score,
    u.evidence,
    u.first_seen_at,
    u.last_seen_at
  from public.event_harvest_unresolved_venues u
  join public.event_harvest_sources s
    on s.id = u.source_id
  left join public.venues v
    on v.id = u.suggested_venue_id
  where u.status = 'pending'
  order by
    u.confidence_score desc nulls last,
    u.first_seen_at asc;
end;
$$;

revoke all
on function
public.admin_pending_event_harvest_unresolved_venues()
from public, anon;

grant execute
on function
public.admin_pending_event_harvest_unresolved_venues()
to authenticated;
