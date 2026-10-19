-- Archive is a Harvester review state, not a venue status.
-- Existing events, sources, findings, and Spot identities remain intact.

create table public.event_harvest_archive (
  venue_id uuid primary key
    references public.venues(id) on delete cascade,
  original_bucket text not null
    check (original_bucket in ('transport', 'no_source')),
  archived_at timestamptz not null default now(),
  archived_by uuid references auth.users(id),
  last_checked_at timestamptz,
  next_check_at timestamptz not null
    default (now() + interval '1 month'),
  last_result text,
  check_count integer not null default 0,
  restored_at timestamptz
);

create index event_harvest_archive_due_idx
on public.event_harvest_archive(next_check_at)
where restored_at is null;

alter table public.event_harvest_archive
enable row level security;

revoke all on public.event_harvest_archive
from public, anon, authenticated;

create or replace function public.admin_archive_harvest_spot(
  p_venue_id uuid,
  p_bucket text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.platform_admins
    where user_id = auth.uid()
  ) then
    raise exception 'Admin access required.';
  end if;

  if p_bucket not in ('transport', 'no_source') then
    raise exception 'Invalid archive bucket.';
  end if;

  if not exists (
    select 1
    from public.venues v
    join public.event_harvest_detector_findings f
      on f.venue_id = v.id
    where v.id = p_venue_id
      and v.status = 'active'
      and f.status = 'active'
      and f.category = p_bucket
      and not exists (
        select 1
        from public.event_harvest_sources src
        where src.venue_id = v.id
          and src.provider = 'first_party'
          and src.is_enabled = true
      )
  ) then
    raise exception 'Spot is not active in the selected bucket.';
  end if;

  insert into public.event_harvest_archive (
    venue_id, original_bucket, archived_by
  )
  values (p_venue_id, p_bucket, auth.uid())
  on conflict (venue_id) do update
  set original_bucket = excluded.original_bucket,
      archived_at = now(),
      archived_by = excluded.archived_by,
      restored_at = null,
      archive_lease_token = null,
      next_check_at = now() + interval '1 month';
end;
$$;

create or replace function public.admin_restore_harvest_spot(
  p_venue_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.platform_admins
    where user_id = auth.uid()
  ) then
    raise exception 'Admin access required.';
  end if;

  update public.event_harvest_archive
  set restored_at = now(),
      archive_lease_token = null
  where venue_id = p_venue_id
    and restored_at is null;

  if not found then
    raise exception 'Spot is not currently archived.';
  end if;
end;
$$;

create or replace function public.admin_list_harvest_archive()
returns table (
  venue_id uuid,
  venue_name text,
  city text,
  state_region text,
  website_url text,
  original_bucket text,
  archived_at timestamptz,
  last_checked_at timestamptz,
  next_check_at timestamptz,
  last_result text,
  check_count integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.platform_admins
    where user_id = auth.uid()
  ) then
    raise exception 'Admin access required.';
  end if;

  return query
  select
    v.id,
    v.name::text,
    coalesce(nullif(trim(v.city), ''), 'Unknown')::text,
    coalesce(v.state_region, '')::text,
    coalesce(v.website_url, '')::text,
    a.original_bucket,
    a.archived_at,
    a.last_checked_at,
    a.next_check_at,
    a.last_result,
    a.check_count
  from public.event_harvest_archive a
  join public.venues v on v.id = a.venue_id
  where a.restored_at is null
    and v.status = 'active'
  order by v.city, v.name;
end;
$$;

revoke all on function
  public.admin_archive_harvest_spot(uuid,text),
  public.admin_restore_harvest_spot(uuid),
  public.admin_list_harvest_archive()
from public;

grant execute on function
  public.admin_archive_harvest_spot(uuid,text),
  public.admin_restore_harvest_spot(uuid),
  public.admin_list_harvest_archive()
to authenticated;

-- ARCHIVE QUEUE EXCLUSIONS V1

create or replace function
public.admin_event_harvest_transport_findings()
returns table(
  id uuid,
  venue_id uuid,
  venue_name text,
  detector_status text,
  website_url text,
  fetched_url text,
  error text,
  first_seen_at timestamptz,
  last_seen_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null
     or not exists (
       select 1
       from public.platform_admins pa
       where pa.user_id = auth.uid()
     ) then
    raise exception 'Admin access required.';
  end if;

  return query
  select
    f.id,
    f.venue_id,
    v.name,
    f.detector_status,
    f.website_url,
    f.fetched_url,
    f.error,
    f.first_seen_at,
    f.last_seen_at
  from public.event_harvest_detector_findings f
  join public.venues v
    on v.id = f.venue_id
  where f.category = 'transport'
    and f.status = 'active'
    and not exists (
      select 1
      from public.event_harvest_sources s
      where s.venue_id = f.venue_id
        and s.provider = 'first_party'
        and s.is_enabled = true
    )
    and not exists (
      select 1
      from public.event_harvest_archive a
      where a.venue_id = f.venue_id
        and a.restored_at is null
    )
  order by f.last_seen_at desc, v.name asc;
end;
$$;

create or replace function
public.admin_event_harvest_no_source_findings()
returns table(
  id uuid,
  venue_id uuid,
  venue_name text,
  website_url text,
  fetched_url text,
  first_seen_at timestamptz,
  last_seen_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null
     or not exists (
       select 1
       from public.platform_admins pa
       where pa.user_id = auth.uid()
     ) then
    raise exception 'Admin access required.';
  end if;

  return query
  select
    f.id,
    f.venue_id,
    v.name,
    f.website_url,
    f.fetched_url,
    f.first_seen_at,
    f.last_seen_at
  from public.event_harvest_detector_findings f
  join public.venues v
    on v.id = f.venue_id
  where f.category = 'no_source'
    and f.status = 'active'
    and not exists (
      select 1
      from public.event_harvest_sources s
      where s.venue_id = f.venue_id
        and s.provider = 'first_party'
        and s.is_enabled = true
    )
    and not exists (
      select 1
      from public.event_harvest_archive a
      where a.venue_id = f.venue_id
        and a.restored_at is null
    )
  order by f.last_seen_at desc, v.name asc;
end;
$$;


-- ARCHIVE DETECTOR INTEGRATION V1

alter table public.event_harvest_archive
  add column archive_lease_token uuid;

--
-- Normal detector scans use this eligible-Spot view.
-- Archived Spots are excluded before LIMIT/OFFSET pagination.

create or replace view
public.event_harvest_detector_eligible_venues
with (security_invoker = true)
as
select v.*
from public.venues v
where not exists (
  select 1
  from public.event_harvest_archive a
  where a.venue_id = v.id
    and a.restored_at is null
);

revoke all on
  public.event_harvest_detector_eligible_venues
from public, anon, authenticated;

grant select on
  public.event_harvest_detector_eligible_venues
to service_role;


-- Claim due archive work atomically.
-- Oldest due Spots are selected first.
-- A lease prevents overlapping invocations from
-- claiming the same Spot simultaneously.

create or replace function
public.claim_event_harvest_archive_rechecks(
  p_limit integer default 30
)
returns table(venue_id uuid, lease_token uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required.';
  end if;

  if p_limit < 1 or p_limit > 100 then
    raise exception 'Archive batch size must be 1-100.';
  end if;

  return query
  with due as (
    select a.venue_id
    from public.event_harvest_archive a
    join public.venues v on v.id = a.venue_id
    where a.restored_at is null
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
$$;


-- Record the result of one completed archive recheck.
-- Restore only when a validated, enabled first-party
-- source exists and the detector completed successfully.

create or replace function
public.finish_event_harvest_archive_recheck(
  p_venue_id uuid,
  p_scan_succeeded boolean,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_validated boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required.';
  end if;

  select exists (
    select 1
    from public.event_harvest_sources s
    where s.venue_id = p_venue_id
      and s.provider = 'first_party'
      and s.is_enabled = true
  )
  into v_validated;

  v_validated :=
    coalesce(p_scan_succeeded, false)
    and v_validated;

  update public.event_harvest_archive a
  set last_checked_at = now(),
      check_count = a.check_count + 1,
      last_result = case
        when v_validated then 'validated_source'
        when not coalesce(p_scan_succeeded, false)
          then 'scan_failed'
        else 'no_validated_source'
      end,
      next_check_at = case
        when not coalesce(p_scan_succeeded, false)
          then now() + interval '1 day'
        else now() + interval '1 month'
      end,
      restored_at = case
        when v_validated then now()
        else null
      end,
      archive_lease_token = null
  where a.venue_id = p_venue_id
    and a.restored_at is null
    and a.archive_lease_token = p_lease_token
    and a.next_check_at > now();

  if not found then
    raise exception 'Archive lease expired or no longer owned.';
  end if;

  return v_validated;
end;
$$;

revoke all on function
  public.claim_event_harvest_archive_rechecks(integer),
  public.finish_event_harvest_archive_recheck(uuid,boolean,uuid)
from public, anon, authenticated;

grant execute on function
  public.claim_event_harvest_archive_rechecks(integer),
  public.finish_event_harvest_archive_recheck(uuid,boolean,uuid)
to service_role;
