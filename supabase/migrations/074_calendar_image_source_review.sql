-- Calendar-image SOURCE review precedes image parsing.
-- Event-level verification remains independent.

alter table public.event_harvest_detector_findings
  drop constraint if exists event_harvest_detector_findings_status_check;

alter table public.event_harvest_detector_findings
  add constraint event_harvest_detector_findings_status_check
  check (status in ('active', 'resolved', 'rejected'));

-- The existing detector upsert can refresh discovery evidence,
-- but cannot reopen an explicitly rejected finding.
create or replace function
public.preserve_rejected_calendar_source_finding()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.category = 'calendar_image'
     and old.status = 'rejected'
     and new.status = 'active' then
    new.status := 'rejected';
    new.resolved_at := old.resolved_at;
  end if;

  return new;
end;
$$;

drop trigger if exists
  preserve_rejected_calendar_source_finding
on public.event_harvest_detector_findings;

create trigger preserve_rejected_calendar_source_finding
before update on public.event_harvest_detector_findings
for each row
execute function
  public.preserve_rejected_calendar_source_finding();


-- Show every pending calendar source, even when its Spot
-- already has another enabled first-party source.
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
  join public.venues v on v.id = f.venue_id
  where f.category = 'calendar_image'
    and f.status = 'active'
  order by f.last_seen_at desc, v.name asc;
end;
$$;


create or replace function
public.admin_review_calendar_image_source(
  p_finding_id uuid,
  p_approve boolean,
  p_venue_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_finding public.event_harvest_detector_findings%rowtype;
  v_venue_name text;
  v_source_id uuid;
  v_existing_owner uuid;
  v_source_url text;
begin
  if auth.uid() is null
     or not exists (
       select 1
       from public.platform_admins pa
       where pa.user_id = auth.uid()
     ) then
    raise exception 'Admin access required.';
  end if;

  select *
  into v_finding
  from public.event_harvest_detector_findings
  where id = p_finding_id
  for update;

  if not found
     or v_finding.category <> 'calendar_image'
     or v_finding.status <> 'active' then
    raise exception 'Pending calendar source not found.';
  end if;

  if not p_approve then
    update public.event_harvest_detector_findings
    set status = 'rejected',
        resolved_at = now(),
        updated_at = now()
    where id = p_finding_id;

    return null;
  end if;

  if p_venue_id is null then
    raise exception 'Select a Spot before approval.';
  end if;

  select name into v_venue_name
  from public.venues
  where id = p_venue_id
    and status = 'active';

  if v_venue_name is null then
    raise exception 'Active Spot not found.';
  end if;

  v_source_url := nullif(trim(v_finding.source_url), '');

  if v_source_url is null
     or v_source_url !~* '^https?://' then
    raise exception 'Valid calendar source URL required.';
  end if;

  -- A calendar already owned by another Spot must be reviewed
  -- explicitly rather than silently attached to both Spots.
  select s.venue_id
  into v_existing_owner
  from public.event_harvest_sources s
  where s.provider = 'first_party'
    and s.source_type = 'calendar_image'
    and s.external_source_id =
      'first_party:calendar_image:' || v_source_url
    and s.is_enabled = true
    and s.venue_id is distinct from p_venue_id
  limit 1;

  if v_existing_owner is not null then
    raise exception
      'Calendar already belongs to another Spot. Review ownership before approval.';
  end if;

  v_source_id :=
    public.upsert_first_party_event_source(
      p_venue_id,
      'calendar_image',
      v_venue_name || ' official calendar',
      v_source_url,
      'first_party:calendar_image:' || v_source_url,
      '{}'::jsonb
    );

  update public.event_harvest_detector_findings
  set status = 'resolved',
      resolved_at = now(),
      updated_at = now()
  where id = p_finding_id;

  return v_source_id;
end;
$$;

revoke all on function
public.admin_review_calendar_image_source(uuid, boolean, uuid)
from public, anon, authenticated;

grant execute on function
public.admin_review_calendar_image_source(uuid, boolean, uuid)
to authenticated, service_role;
