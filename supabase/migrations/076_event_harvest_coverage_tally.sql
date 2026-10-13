create or replace function public.admin_event_harvest_coverage_tally()
returns table (
  total_spots bigint,
  validated_spots bigint,
  non_validated_spots bigint,
  missing_from_buckets bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with eligible as (
    select v.id
    from public.venues v
    where v.status = 'active'
      and v.website_url is not null
  ),
  classified as (
    select
      e.id,
      exists (
        select 1
        from public.event_harvest_sources s
        where s.venue_id = e.id
          and s.provider = 'first_party'
          and s.is_enabled = true
      ) as validated,
      exists (
        select 1
        from public.event_harvest_detector_findings f
        where f.venue_id = e.id
          and f.status = 'active'
          and f.category in (
            'html_error',
            'calendar_image',
            'facebook',
            'browser_required',
            'challenge_encountered',
            'transport',
            'no_source'
          )
      ) as has_exception
    from eligible e
  )
  select
    count(*)::bigint,
    count(*) filter (where validated)::bigint,
    count(*) filter (where not validated)::bigint,
    count(*) filter (
      where not validated and not has_exception
    )::bigint
  from classified;
$$;

revoke all on function public.admin_event_harvest_coverage_tally()
from public, anon, authenticated;

grant execute on function public.admin_event_harvest_coverage_tally()
to service_role;
