-- TenderFans Event Harvester:
-- persistent Browser Required detector findings.
--
-- These findings identify Spots where static HTTP discovery has been
-- established as insufficient and browser execution is required.
-- Browser Required is a discovery capability classification, not the
-- eventual event-source adapter.

-- ============================================================
-- CATEGORY CONSTRAINT
-- ============================================================

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
      'browser_required'
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
    'browser_required'
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
-- ADMIN: BROWSER REQUIRED QUEUE
-- ============================================================

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
    f.source_url,
    f.confidence,
    f.evidence,
    f.first_seen_at,
    f.last_seen_at
  from
    public.event_harvest_detector_findings f
  join public.venues v
    on v.id = f.venue_id
  where f.category = 'browser_required'
    and f.status = 'active'
  order by
    f.last_seen_at desc,
    v.name asc;
end;
$$;


-- ============================================================
-- KNOWN VERIFIED BROWSER-REQUIRED SPOTS
-- ============================================================

-- Coconut Charlie's North Redington Beach:
-- Wix EventsCalendar.co widget configuration is supplied at runtime.
select public.upsert_event_harvest_detector_finding(
  v.id,
  'browser_required',
  'browser_required',
  'browser_required',
  'browser_required',
  v.website_url,
  v.website_url,
  null,
  'high',
  '[
    "EventsCalendar.co runtime widget detected",
    "Browser execution required to obtain runtime event-source configuration"
  ]'::jsonb,
  null
)
from public.venues v
where v.id =
  'eae19e87-1e90-4175-9666-8f8bdf5077a5'::uuid
  and v.status = 'active'
  and v.website_url is not null;


-- OCC Road House & Museum:
-- prior investigation established browser transport as the required path.
select public.upsert_event_harvest_detector_finding(
  v.id,
  'browser_required',
  'browser_required',
  'browser_required',
  'browser_required',
  v.website_url,
  v.website_url,
  null,
  'high',
  '[
    "Static transport blocked by Cloudflare",
    "Browser transport established as required discovery path"
  ]'::jsonb,
  null
)
from public.venues v
where v.id =
  'ac8bc863-93bb-4f60-8c8d-ada1fc11fc7c'::uuid
  and v.status = 'active'
  and v.website_url is not null;

select public.resolve_event_harvest_detector_findings(
  'ac8bc863-93bb-4f60-8c8d-ada1fc11fc7c'::uuid,
  'transport'
);


-- ============================================================
-- PERMISSIONS
-- ============================================================

revoke all on function
  public.admin_event_harvest_browser_required_findings()
from public, anon;

grant execute on function
  public.admin_event_harvest_browser_required_findings()
to authenticated;
