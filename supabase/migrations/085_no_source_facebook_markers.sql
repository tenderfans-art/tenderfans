-- Facebook history markers for the No Source Admin queue.
-- Read-only, admin-authorized, and independent of bucket classification.

create or replace function
public.admin_event_harvest_no_source_facebook_markers()
returns table(venue_id uuid)
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
  select distinct f.venue_id
  from public.event_harvest_detector_findings f
  where f.category = 'facebook'
    and exists (
      select 1
      from public.event_harvest_detector_findings ns
      where ns.venue_id = f.venue_id
        and ns.category = 'no_source'
        and ns.status = 'active'
    )
    and not exists (
      select 1
      from public.event_harvest_sources s
      where s.venue_id = f.venue_id
        and s.provider = 'first_party'
        and s.is_enabled = true
    );
end;
$$;

revoke all on function
  public.admin_event_harvest_no_source_facebook_markers()
from public, anon;

grant execute on function
  public.admin_event_harvest_no_source_facebook_markers()
to authenticated;
