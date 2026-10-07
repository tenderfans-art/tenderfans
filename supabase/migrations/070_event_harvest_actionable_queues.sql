-- TenderFans Event Harvester:
-- complete actionable Harvester Management queues.
--
-- Adds durable no-source findings and makes every detector-exception
-- admin queue exclude Spots that already have an enabled,
-- venue-bound first-party source.

alter table public.event_harvest_detector_findings
  drop constraint if exists
    event_harvest_detector_findings_category_check;

alter table public.event_harvest_detector_findings
  add constraint
    event_harvest_detector_findings_category_check
  check (
    category in (
      'calendar_image',
      'transport',
      'facebook',
      'browser_required',
      'no_source'
    )
  );


-- ============================================================
-- HARVESTER UPSERT
-- ============================================================

create or replace function
public.upsert_event_harvest_detector_finding(
  p_venue_id uuid,
  p_category text,
  p_finding_key text,
  p_detector_status text,
  p_source_type text,
  p_website_url text,
  p_source_url text default null,
  p_fetched_url text default null,
  p_confidence text default null,
  p_evidence jsonb default '[]'::jsonb,
  p_error text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not exists (
    select 1
    from public.venues v
    where v.id = p_venue_id
      and v.status = 'active'
  ) then
    raise exception
      'Active TenderFans Spot not found';
  end if;

  if p_category not in (
    'calendar_image',
    'transport',
    'facebook',
    'browser_required',
    'no_source'
  ) then
    raise exception
      'Unsupported detector finding category';
  end if;

  if p_finding_key is null
     or trim(p_finding_key) = '' then
    raise exception
      'Finding key is required';
  end if;

  insert into public.event_harvest_detector_findings (
    venue_id,
    category,
    finding_key,
    detector_status,
    source_type,
    website_url,
    source_url,
    fetched_url,
    confidence,
    evidence,
    error
  )
  values (
    p_venue_id,
    p_category,
    trim(p_finding_key),
    p_detector_status,
    p_source_type,
    p_website_url,
    p_source_url,
    p_fetched_url,
    p_confidence,
    coalesce(
      p_evidence,
      '[]'::jsonb
    ),
    p_error
  )
  on conflict (
    venue_id,
    finding_key
  )
  do update set
    category = excluded.category,
    detector_status = excluded.detector_status,
    source_type = excluded.source_type,
    website_url = excluded.website_url,
    source_url = excluded.source_url,
    fetched_url = excluded.fetched_url,
    confidence = excluded.confidence,
    evidence = excluded.evidence,
    error = excluded.error,
    status = 'active',
    last_seen_at = now(),
    resolved_at = null,
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;


-- ============================================================
-- ACTIONABLE QUEUE SAFETY GATE
-- ============================================================

create or replace function
public.admin_event_harvest_calendar_image_findings()
returns table(
  id uuid,
  venue_id uuid,
  venue_name text,
  website_url text,
  source_url text,
  confidence text,
  evidence jsonb,
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
    f.source_url,
    f.confidence,
    f.evidence,
    f.first_seen_at,
    f.last_seen_at
  from public.event_harvest_detector_findings f
  join public.venues v
    on v.id = f.venue_id
  where f.category = 'calendar_image'
    and f.status = 'active'
    and not exists (
      select 1
      from public.event_harvest_sources s
      where s.venue_id = f.venue_id
        and s.provider = 'first_party'
        and s.is_enabled = true
    )
  order by f.last_seen_at desc, v.name asc;
end;
$$;


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
  order by f.last_seen_at desc, v.name asc;
end;
$$;


create or replace function
public.admin_event_harvest_facebook_findings()
returns table(
  id uuid,
  venue_id uuid,
  venue_name text,
  website_url text,
  source_url text,
  confidence text,
  evidence jsonb,
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
    f.source_url,
    f.confidence,
    f.evidence,
    f.first_seen_at,
    f.last_seen_at
  from public.event_harvest_detector_findings f
  join public.venues v
    on v.id = f.venue_id
  where f.category = 'facebook'
    and f.status = 'active'
    and not exists (
      select 1
      from public.event_harvest_sources s
      where s.venue_id = f.venue_id
        and s.provider = 'first_party'
        and s.is_enabled = true
    )
  order by f.last_seen_at desc, v.name asc;
end;
$$;


create or replace function
public.admin_event_harvest_browser_required_findings()
returns table(
  id uuid,
  venue_id uuid,
  venue_name text,
  detector_status text,
  website_url text,
  source_url text,
  confidence text,
  evidence jsonb,
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
    f.source_url,
    f.confidence,
    f.evidence,
    f.first_seen_at,
    f.last_seen_at
  from public.event_harvest_detector_findings f
  join public.venues v
    on v.id = f.venue_id
  where f.category = 'browser_required'
    and f.status = 'active'
    and not exists (
      select 1
      from public.event_harvest_sources s
      where s.venue_id = f.venue_id
        and s.provider = 'first_party'
        and s.is_enabled = true
    )
  order by f.last_seen_at desc, v.name asc;
end;
$$;


-- ============================================================
-- ADMIN: NO SOURCE QUEUE
-- ============================================================

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
  order by f.last_seen_at desc, v.name asc;
end;
$$;


revoke all on function
  public.admin_event_harvest_no_source_findings()
from public, anon;

grant execute on function
  public.admin_event_harvest_no_source_findings()
to authenticated;
