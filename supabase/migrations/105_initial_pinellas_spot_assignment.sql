-- 105: One-time initial Pinellas County Spot membership backfill.
--
-- Every pre-Market-onboarding Spot without membership belongs
-- to Pinellas County, unless there is an explicit conflicting
-- Market request requiring investigation.
--
-- Preserve all existing Market assignments, including the
-- Workflow Isolation Test Market.
--
-- No changes to Spot identity, status, event ownership,
-- Harvester findings, Google review decisions or work queues.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- Keep the set of existing Spot records stable while the
-- one-time membership backfill and validation complete.
lock table public.venues in share mode;

-- Prevent concurrent Market membership changes until commit.
lock table public.event_processing_market_venues
  in share row exclusive mode;

do $$
declare
  v_pinellas_id uuid;

  v_total_before bigint;
  v_unassigned_before bigint;
  v_unassigned_after bigint;

  v_pinellas_before bigint;
  v_pinellas_after bigint;

  v_other_before bigint;
  v_other_after bigint;

  v_inserted bigint;
  v_conflicts bigint;
  v_pending_without_market bigint;
begin
  select id
  into v_pinellas_id
  from public.event_processing_markets
  where market_key = 'pinellas-county'
    and display_name = 'Pinellas County';

  if v_pinellas_id is null then
    raise exception
      'Migration 105: Pinellas County Market not found';
  end if;

  -- Verify no duplicate Market identity.
  if (
    select count(*)
    from public.event_processing_markets
    where market_key = 'pinellas-county'
       or display_name = 'Pinellas County'
  ) <> 1 then
    raise exception
      'Migration 105: ambiguous Pinellas County Market';
  end if;

  select count(*)
  into v_total_before
  from public.venues;

  select count(*)
  into v_unassigned_before
  from public.venues v
  where not exists (
    select 1
    from public.event_processing_market_venues mv
    where mv.venue_id = v.id
  );

  select count(*)
  into v_pinellas_before
  from public.event_processing_market_venues
  where market_id = v_pinellas_id;

  select count(*)
  into v_other_before
  from public.event_processing_market_venues
  where market_id <> v_pinellas_id;

  -- Explicit Google Places Market requests are authoritative.
  --
  -- Stop rather than assigning a Spot to Pinellas if its
  -- previously approved Google review identifies another Market.
  --
  -- Also detect any previously established contradictory
  -- membership/review relationship.
  select count(*)
  into v_conflicts
  from public.event_harvest_google_spot_reviews gr
  join public.event_google_spot_market_requests mr
    on mr.place_id = gr.place_id
  left join public.event_processing_market_venues mv
    on mv.venue_id = gr.venue_id
  where gr.status = 'approved'
    and gr.venue_id is not null
    and (
      (
        mv.venue_id is null
        and mr.market_id <> v_pinellas_id
      )
      or
      (
        mv.venue_id is not null
        and mv.market_id <> mr.market_id
      )
    );

  if v_conflicts > 0 then
    raise exception
      'Migration 105: % Google Market ownership conflict(s). No backfill performed.',
      v_conflicts;
  end if;

  raise notice
    'BEFORE: total Spots=%, unassigned=%, Pinellas=%, other Markets=%',
    v_total_before,
    v_unassigned_before,
    v_pinellas_before,
    v_other_before;

  -- Add only Spots with no existing Market membership.
  --
  -- Existing Market assignments are immutable here.
  -- Do not filter by Spot status: archived and removed
  -- Spots still retain their original Market ownership.
  insert into public.event_processing_market_venues (
    venue_id,
    market_id
  )
  select
    v.id,
    v_pinellas_id
  from public.venues v
  where not exists (
    select 1
    from public.event_processing_market_venues mv
    where mv.venue_id = v.id
  )
  on conflict (venue_id) do nothing;

  get diagnostics v_inserted = row_count;

  select count(*)
  into v_unassigned_after
  from public.venues v
  where not exists (
    select 1
    from public.event_processing_market_venues mv
    where mv.venue_id = v.id
  );

  select count(*)
  into v_pinellas_after
  from public.event_processing_market_venues
  where market_id = v_pinellas_id;

  select count(*)
  into v_other_after
  from public.event_processing_market_venues
  where market_id <> v_pinellas_id;

  if v_unassigned_after <> 0 then
    raise exception
      'Migration 105: % Spots remain unassigned',
      v_unassigned_after;
  end if;

  if v_other_after <> v_other_before then
    raise exception
      'Migration 105: another Market membership count changed';
  end if;

  if v_pinellas_after <> v_pinellas_before + v_inserted then
    raise exception
      'Migration 105: Pinellas membership count mismatch';
  end if;

  if v_inserted <> v_unassigned_before then
    raise exception
      'Migration 105: expected % assignments but inserted %',
      v_unassigned_before,
      v_inserted;
  end if;

  -- Discovery records awaiting Google review do not yet
  -- represent published Spots. Report their Market coverage,
  -- but do not manufacture assignments or review decisions.
  select count(*)
  into v_pending_without_market
  from public.event_harvest_google_spot_reviews gr
  where gr.status = 'pending'
    and not exists (
      select 1
      from public.event_google_spot_market_requests mr
      where mr.place_id = gr.place_id
    );

  raise notice
    'AFTER: newly assigned=%, Pinellas=%, other Markets=%, unassigned Spots=%',
    v_inserted,
    v_pinellas_after,
    v_other_after,
    v_unassigned_after;

  raise notice
    'Pending Google reviews without Market context (future intake audit): %',
    v_pending_without_market;

  raise notice
    'Migration 105 completed; all existing Spots have Market membership.';
end;
$$;

commit;
