
-- HTML source ownership approval.
-- Preserve venue-scoped first-party source identity.

create or replace function
public.first_party_html_website_is_shared(p_venue_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with current_venue as (
    select lower(trim(both '/' from regexp_replace(
      regexp_replace(
        split_part(split_part(trim(website_url), '#', 1), '?', 1),
        '^https?://(www\.)?', '', 'i'
      ), '/+$', ''
    ))) as site
    from public.venues
    where id = p_venue_id and status = 'active'
  )
  select exists (
    select 1
    from public.venues v
    cross join current_venue c
    where v.id <> p_venue_id
      and v.status = 'active'
      and v.website_url is not null
      and lower(trim(both '/' from regexp_replace(
        regexp_replace(
          split_part(split_part(trim(v.website_url), '#', 1), '?', 1),
          '^https?://(www\.)?', '', 'i'
        ), '/+$', ''
      ))) = c.site
  );
$$;

revoke all on function
public.first_party_html_website_is_shared(uuid)
from public, anon, authenticated;

grant execute on function
public.first_party_html_website_is_shared(uuid)
to service_role;


-- Keep rejected ownership findings rejected on detector reruns.

create or replace function
public.preserve_rejected_html_ownership_finding()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.category = 'source_ownership'
     and old.status = 'rejected'
     and new.status = 'active' then

    new.status := 'rejected';
    new.resolved_at := old.resolved_at;

  end if;

  return new;
end;
$$;

drop trigger if exists
preserve_rejected_html_ownership_finding
on public.event_harvest_detector_findings;

create trigger preserve_rejected_html_ownership_finding
before update on public.event_harvest_detector_findings
for each row
execute function public.preserve_rejected_html_ownership_finding();


-- Administrator-only HTML ownership approval and rejection.

create or replace function
public.admin_review_html_source_ownership(
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
  f public.event_harvest_detector_findings%rowtype;
  v_name text;
  v_source_id uuid;
  v_external_id text;
begin

  if auth.uid() is null or not exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  ) then
    raise exception 'Admin access required.';
  end if;

  select *
  into f
  from public.event_harvest_detector_findings
  where id = p_finding_id
  for update;

  if not found
     or f.category <> 'source_ownership'
     or f.status <> 'active'
     or f.source_type <> 'html_events' then
    raise exception 'Pending HTML ownership finding not found.';
  end if;

  if not p_approve then

    update public.event_harvest_detector_findings
    set status = 'rejected',
        resolved_at = now(),
        updated_at = now()
    where id = f.id;

    return null;
  end if;

  if p_venue_id is null or p_venue_id <> f.venue_id then
    raise exception
      'Approval must explicitly target the finding Spot.';
  end if;

  select name
  into v_name
  from public.venues
  where id = p_venue_id
    and status = 'active';

  if v_name is null then
    raise exception 'Active Spot not found.';
  end if;

  if f.source_url is null
     or f.source_url !~* '^https?://[^/ ]+' then
    raise exception 'Valid HTML source URL required.';
  end if;

  v_external_id :=
    'first_party:html_events:' || f.source_url;

  if f.finding_key <> 'source_ownership:' || v_external_id then
    raise exception
      'Finding identity does not match source URL.';
  end if;

  if not (
    coalesce(f.evidence, '[]'::jsonb)
    @> '["Source validation succeeded"]'::jsonb
  ) then
    raise exception
      'Source needs fresh successful validation before approval.';
  end if;

  v_source_id := public.upsert_first_party_event_source(
    p_venue_id,
    'html_events',
    v_name || ' official events',
    f.source_url,
    v_external_id,
    '{}'::jsonb
  );

  update public.event_harvest_detector_findings
  set status = 'resolved',
      resolved_at = now(),
      updated_at = now()
  where id = f.id;

  return v_source_id;
end;
$$;

revoke all on function
public.admin_review_html_source_ownership(uuid, boolean, uuid)
from public, anon, authenticated;

grant execute on function
public.admin_review_html_source_ownership(uuid, boolean, uuid)
to authenticated, service_role;
