-- TenderFans Event Harvester:
-- Admin review for unresolved publisher event venues.
--
-- Extends the existing Venue Matches admin workflow without changing
-- event_harvest_venue_matches or its external-provider approval semantics.
--
-- Resolution is durable by (source_id, external_event_id). The next
-- harvest can reuse the administrator-selected TenderFans Spot and then
-- enter the normal candidate/dedupe/graduation/sync pipeline.


-- ============================================================
-- ADMIN PENDING QUEUE
-- ============================================================

create or replace function
public.admin_pending_event_harvest_unresolved_venues()
returns table(
  id uuid,
  source_id uuid,
  source_name text,
  external_event_id text,
  event_title text,
  starts_at text,
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


-- ============================================================
-- ADMIN REVIEW
-- ============================================================

create or replace function
public.admin_review_event_harvest_unresolved_venue(
  p_unresolved_id uuid,
  p_venue_id uuid default null,
  p_approve boolean default true
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_record public.event_harvest_unresolved_venues%rowtype;
begin
  if auth.uid() is null or not exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  ) then
    raise exception 'Admin access required.';
  end if;

  select *
  into v_record
  from public.event_harvest_unresolved_venues
  where id = p_unresolved_id
  for update;

  if not found then
    raise exception 'Unresolved venue attribution not found';
  end if;

  if v_record.status <> 'pending' then
    raise exception 'Unresolved venue attribution has already been reviewed';
  end if;

  if p_approve then
    if p_venue_id is null then
      raise exception 'TenderFans Spot is required';
    end if;

    if not exists (
      select 1
      from public.venues v
      where v.id = p_venue_id
        and v.status = 'active'
    ) then
      raise exception 'Active TenderFans Spot not found';
    end if;

    update public.event_harvest_unresolved_venues
    set
      status = 'resolved',
      resolved_venue_id = p_venue_id,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      updated_at = now()
    where id = p_unresolved_id;
  else
    update public.event_harvest_unresolved_venues
    set
      status = 'rejected',
      resolved_venue_id = null,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      updated_at = now()
    where id = p_unresolved_id;
  end if;
end;
$$;


-- ============================================================
-- HARVESTER RESOLUTION LOOKUP
-- ============================================================

create or replace function
public.resolved_event_harvest_venue(
  p_source_id uuid,
  p_external_event_id text
)
returns table(
  venue_id uuid,
  venue_name text
)
language sql
security definer
set search_path = public
stable
as $$
  select
    u.resolved_venue_id as venue_id,
    v.name as venue_name
  from public.event_harvest_unresolved_venues u
  join public.venues v
    on v.id = u.resolved_venue_id
  where u.source_id = p_source_id
    and u.external_event_id = trim(p_external_event_id)
    and u.status = 'resolved'
    and v.status = 'active'
  limit 1;
$$;


-- ============================================================
-- SECURITY
-- ============================================================

revoke all
on function
public.admin_pending_event_harvest_unresolved_venues()
from public, anon;

grant execute
on function
public.admin_pending_event_harvest_unresolved_venues()
to authenticated;


revoke all
on function
public.admin_review_event_harvest_unresolved_venue(
  uuid,
  uuid,
  boolean
)
from public, anon;

grant execute
on function
public.admin_review_event_harvest_unresolved_venue(
  uuid,
  uuid,
  boolean
)
to authenticated;


revoke all
on function
public.resolved_event_harvest_venue(
  uuid,
  text
)
from public, anon, authenticated;

grant execute
on function
public.resolved_event_harvest_venue(
  uuid,
  text
)
to service_role;
