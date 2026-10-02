-- TenderFans Event Harvester:
-- persistent detector findings for Harvester Management.
--
-- These findings sit before source ratification/registration.
-- They preserve actionable detector results that otherwise disappear
-- after the scheduled detector run.

create table public.event_harvest_detector_findings (
  id uuid primary key default gen_random_uuid(),

  venue_id uuid not null
    references public.venues(id)
    on delete cascade,

  category text not null
    check (
      category in (
        'calendar_image',
        'transport'
      )
    ),

  finding_key text not null,

  detector_status text not null,
  source_type text,

  website_url text not null,
  source_url text,
  fetched_url text,

  confidence text
    check (
      confidence is null
      or confidence in (
        'high',
        'medium',
        'low'
      )
    ),

  evidence jsonb not null default '[]'::jsonb,
  error text,

  status text not null default 'active'
    check (
      status in (
        'active',
        'resolved'
      )
    ),

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (
    venue_id,
    finding_key
  )
);

create index
  event_harvest_detector_findings_queue_idx
on public.event_harvest_detector_findings (
  category,
  status,
  last_seen_at desc
);

create index
  event_harvest_detector_findings_venue_idx
on public.event_harvest_detector_findings (
  venue_id,
  category,
  status
);

alter table
  public.event_harvest_detector_findings
enable row level security;


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
    'transport'
  ) then
    raise exception
      'Unsupported detector finding category';
  end if;

  if p_finding_key is null
     or trim(p_finding_key) = '' then
    raise exception
      'Finding key is required';
  end if;

  insert into
    public.event_harvest_detector_findings (
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
    detector_status =
      excluded.detector_status,
    source_type =
      excluded.source_type,
    website_url =
      excluded.website_url,
    source_url =
      excluded.source_url,
    fetched_url =
      excluded.fetched_url,
    confidence =
      excluded.confidence,
    evidence =
      excluded.evidence,
    error =
      excluded.error,
    status = 'active',
    last_seen_at = now(),
    resolved_at = null,
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;


-- ============================================================
-- AUTOMATIC TRANSPORT RESOLUTION
-- ============================================================

create or replace function
public.resolve_event_harvest_detector_findings(
  p_venue_id uuid,
  p_category text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update
    public.event_harvest_detector_findings
  set
    status = 'resolved',
    resolved_at = now(),
    updated_at = now()
  where venue_id = p_venue_id
    and category = p_category
    and status = 'active';

  get diagnostics
    v_count = row_count;

  return v_count;
end;
$$;


-- ============================================================
-- ADMIN: CALENDAR IMAGE QUEUE
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
    raise exception
      'Admin access required.';
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
  from
    public.event_harvest_detector_findings f
  join public.venues v
    on v.id = f.venue_id
  where f.category = 'calendar_image'
    and f.status = 'active'
  order by
    f.last_seen_at desc,
    v.name asc;
end;
$$;


-- ============================================================
-- ADMIN: TRANSPORT ERROR QUEUE
-- ============================================================

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
    raise exception
      'Admin access required.';
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
  from
    public.event_harvest_detector_findings f
  join public.venues v
    on v.id = f.venue_id
  where f.category = 'transport'
    and f.status = 'active'
  order by
    f.last_seen_at desc,
    v.name asc;
end;
$$;


-- ============================================================
-- PERMISSIONS
-- ============================================================

revoke all on table
  public.event_harvest_detector_findings
from public, anon, authenticated;

revoke all on function
  public.upsert_event_harvest_detector_finding(
    uuid,
    text,
    text,
    text,
    text,
    text,
    text,
    text,
    text,
    jsonb,
    text
  )
from public, anon, authenticated;

revoke all on function
  public.resolve_event_harvest_detector_findings(
    uuid,
    text
  )
from public, anon, authenticated;

grant execute on function
  public.upsert_event_harvest_detector_finding(
    uuid,
    text,
    text,
    text,
    text,
    text,
    text,
    text,
    text,
    jsonb,
    text
  )
to service_role;

grant execute on function
  public.resolve_event_harvest_detector_findings(
    uuid,
    text
  )
to service_role;

revoke all on function
  public.admin_event_harvest_calendar_image_findings()
from public, anon;

revoke all on function
  public.admin_event_harvest_transport_findings()
from public, anon;

grant execute on function
  public.admin_event_harvest_calendar_image_findings()
to authenticated;

grant execute on function
  public.admin_event_harvest_transport_findings()
to authenticated;
