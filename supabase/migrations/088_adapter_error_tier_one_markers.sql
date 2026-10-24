-- Read-only Tier One source markers for the Adapter Errors review page.
-- Source registrations, findings, and publication behavior are unchanged.

create or replace function
public.admin_event_harvest_adapter_error_tier_one_sources()
returns table (
  venue_id uuid,
  source_type text
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
  select distinct
    s.venue_id,
    s.source_type::text
  from public.event_harvest_sources s
  where s.provider = 'first_party'
    and s.is_enabled = true
    and s.source_type is not null
    and s.source_type not in (
      'facebook',
      'facebook_events',
      'calendar_image'
    )
    and exists (
      select 1
      from public.event_harvest_detector_findings f
      where f.venue_id = s.venue_id
        and f.category = 'adapter_error'
        and f.status = 'active'
    )
  order by s.venue_id, s.source_type;
end;
$$;

revoke all on function
  public.admin_event_harvest_adapter_error_tier_one_sources()
from public, anon;

grant execute on function
  public.admin_event_harvest_adapter_error_tier_one_sources()
to authenticated;
