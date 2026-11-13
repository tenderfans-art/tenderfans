-- 124: Market-scoped coverage tally for Market header.
-- Reuses the existing global tally's exact eligibility
-- and classification rules without changing that function.
-- No scheduling, worker, source or event changes.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '90s';

create function public.admin_event_harvest_coverage_tally_for_market(
  p_market_id uuid
)
returns table (
  total_spots bigint,
  validated_spots bigint,
  non_validated_spots bigint,
  missing_from_buckets bigint,
  active_errors bigint
)
language sql
stable
security definer
set search_path = ''
as $market_tally$
  with classified as (
    select
      v.id,

      exists (
        select 1
        from public.event_harvest_sources s
        where s.venue_id = v.id
          and s.provider = 'first_party'
          and s.is_enabled = true
      ) as validated,

      exists (
        select 1
        from public.event_harvest_detector_findings f
        where f.venue_id = v.id
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

    from public.event_processing_market_venues mv
    join public.venues v
      on v.id = mv.venue_id

    where mv.market_id = p_market_id
      and v.status = 'active'
      and v.website_url is not null
  )
  select
    count(*)::bigint,
    count(*) filter (where validated)::bigint,
    count(*) filter (where not validated)::bigint,
    count(*) filter (
      where not validated and not has_exception
    )::bigint,

    (
      select count(distinct f.venue_id)::bigint
      from public.event_harvest_detector_findings f
      join public.event_processing_market_venues mv
        on mv.venue_id = f.venue_id
      where mv.market_id = p_market_id
        and f.category = 'adapter_error'
        and f.status = 'active'
        and f.resolved_at is null
    )

  from classified;
$market_tally$;

revoke all on function
  public.admin_event_harvest_coverage_tally_for_market(uuid)
from public, anon, authenticated;

grant execute on function
  public.admin_event_harvest_coverage_tally_for_market(uuid)
to service_role;

commit;
