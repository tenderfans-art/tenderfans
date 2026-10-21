-- Unified Adapter Errors: independent source-level failures.
-- Preserve all existing finding categories and review workflows.

alter table public.event_harvest_detector_findings
  drop constraint if exists event_harvest_detector_findings_category_check;

alter table public.event_harvest_detector_findings
  add constraint event_harvest_detector_findings_category_check
  check (category in (
    'calendar_image',
    'transport',
    'facebook',
    'browser_required',
    'challenge_encountered',
    'no_source',
    'html_error',
    'source_ownership',
    'adapter_error'
  ));

-- Preserve the current RPC signature and conflict behavior.
create or replace function public.upsert_event_harvest_detector_finding(
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
    select 1 from public.venues v
    where v.id = p_venue_id and v.status = 'active'
  ) then
    raise exception 'Active TenderFans Spot not found';
  end if;

  if p_category not in (
    'calendar_image', 'transport', 'facebook',
    'browser_required', 'challenge_encountered',
    'no_source', 'html_error', 'source_ownership',
    'adapter_error'
  ) then
    raise exception 'Unsupported detector finding category';
  end if;

  if p_finding_key is null or trim(p_finding_key) = '' then
    raise exception 'Finding key is required';
  end if;

  insert into public.event_harvest_detector_findings (
    venue_id, category, finding_key, detector_status,
    source_type, website_url, source_url, fetched_url,
    confidence, evidence, error
  )
  values (
    p_venue_id, p_category, trim(p_finding_key),
    p_detector_status, p_source_type, p_website_url,
    p_source_url, p_fetched_url, p_confidence,
    coalesce(p_evidence, '[]'::jsonb), p_error
  )
  on conflict (venue_id, finding_key)
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

revoke all on function public.upsert_event_harvest_detector_finding(
  uuid, text, text, text, text, text, text, text, text, jsonb, text
) from public, anon, authenticated;

grant execute on function public.upsert_event_harvest_detector_finding(uuid, text, text, text, text, text, text, text, text, jsonb, text) to service_role;

-- Source-specific resolution. Never resolve all failures for a Spot.
create function public.resolve_event_harvest_adapter_error(
  p_venue_id uuid,
  p_finding_key text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.event_harvest_detector_findings
  set status = 'resolved',
      resolved_at = now(),
      updated_at = now()
  where venue_id = p_venue_id
    and finding_key = p_finding_key
    and category = 'adapter_error'
    and status = 'active';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function
  public.resolve_event_harvest_adapter_error(uuid, text)
from public, anon, authenticated;

grant execute on function
  public.resolve_event_harvest_adapter_error(uuid, text)
to service_role;

-- Admin-only queue; no exclusion for Spots with validated sources.
create function public.admin_event_harvest_adapter_error_findings()
returns table (
  id uuid,
  venue_id uuid,
  venue_name text,
  finding_key text,
  detector_status text,
  source_type text,
  website_url text,
  source_url text,
  fetched_url text,
  error text,
  evidence jsonb,
  first_seen_at timestamptz,
  last_seen_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null or not exists (
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
    f.finding_key,
    f.detector_status,
    f.source_type,
    f.website_url,
    f.source_url,
    f.fetched_url,
    f.error,
    f.evidence,
    f.first_seen_at,
    f.last_seen_at
  from public.event_harvest_detector_findings f
  join public.venues v on v.id = f.venue_id
  where f.category = 'adapter_error'
    and f.status = 'active'
  order by v.name asc, f.source_type asc, f.last_seen_at desc;
end;
$$;

revoke all on function
  public.admin_event_harvest_adapter_error_findings()
from public, anon;

grant execute on function
  public.admin_event_harvest_adapter_error_findings()
to authenticated;


-- Explicit Admin resolution of one Adapter Error finding.
-- Automated source-specific resolution remains service-role-only.
create function public.admin_resolve_event_harvest_adapter_error(
  p_finding_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_count integer;
begin
  if auth.uid() is null or not exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  ) then
    raise exception 'Admin access required.';
  end if;

  update public.event_harvest_detector_findings
  set status = 'resolved',
      resolved_at = now(),
      updated_at = now()
  where id = p_finding_id
    and category = 'adapter_error'
    and status = 'active';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function
  public.admin_resolve_event_harvest_adapter_error(uuid)
from public, anon;

grant execute on function
  public.admin_resolve_event_harvest_adapter_error(uuid)
to authenticated;


-- Distinct Spots with active Adapter Errors.
create or replace function
  public.admin_event_harvest_adapter_error_spot_count()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select count(distinct venue_id)
  from public.event_harvest_detector_findings
  where category = 'adapter_error'
    and status = 'active'
    and resolved_at is null;
$$;

revoke all on function
  public.admin_event_harvest_adapter_error_spot_count()
from public, anon, authenticated;

grant execute on function
  public.admin_event_harvest_adapter_error_spot_count()
to service_role;
