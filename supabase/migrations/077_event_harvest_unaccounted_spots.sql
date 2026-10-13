-- Read-only list backing Harvester Management's missing count.
-- Applied to Supabase SQL Editor before this migration was committed.

create or replace function public.admin_event_harvest_unaccounted_spots()
returns table (
  venue_id uuid,
  venue_name text,
  website_url text
)
language sql
stable
security definer
set search_path = public
as $$
  select v.id, v.name::text, v.website_url::text
  from public.venues v
  where v.status = 'active'
    and v.website_url is not null
    and not exists (
      select 1 from public.event_harvest_sources s
      where s.venue_id = v.id
        and s.provider = 'first_party'
        and s.is_enabled = true
    )
    and not exists (
      select 1 from public.event_harvest_detector_findings f
      where f.venue_id = v.id
        and f.status = 'active'
        and f.category in (
          'html_error', 'calendar_image', 'facebook',
          'browser_required', 'challenge_encountered',
          'transport', 'no_source'
        )
    )
  order by v.name, v.id;
$$;

revoke all on function public.admin_event_harvest_unaccounted_spots()
from public, anon, authenticated;

grant execute on function public.admin_event_harvest_unaccounted_spots()
to service_role;
