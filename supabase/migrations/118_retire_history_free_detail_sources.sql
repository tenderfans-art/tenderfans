-- Retire only history-free child registrations with an existing
-- successful, candidate-producing Squarespace or RSC inventory.
-- Keep every source, candidate, event and provenance record.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';

CREATE TABLE public.event_harvest_source_retirements (
  source_id uuid PRIMARY KEY
    REFERENCES public.event_harvest_sources(id) ON DELETE RESTRICT,
  replacement_source_id uuid NOT NULL
    REFERENCES public.event_harvest_sources(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (
    reason = '118_history_free_detail_with_verified_inventory'
  ),
  retired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (source_id <> replacement_source_id)
);

ALTER TABLE public.event_harvest_source_retirements
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_harvest_source_retirements
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.event_harvest_source_retirements
  TO service_role;

DO $retire$
DECLARE
  v_market uuid;
  v_planned integer;
  v_changed integer;
  v_jobs integer;
BEGIN
  SELECT id INTO v_market
  FROM public.event_processing_markets
  WHERE market_key = 'pinellas-county'
    AND is_enabled = false
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '118: Pinellas must exist and be disabled';
  END IF;

  CREATE TEMP TABLE tf118_plan ON COMMIT DROP AS
  WITH normalized AS (
    SELECT s.*,
      regexp_replace(
        lower(coalesce(substring(s.source_url
          from '^https?://([^/?#]+)'), '')),
        '^www\.', ''
      ) AS host,
      coalesce(nullif(regexp_replace(
        coalesce(substring(s.source_url
          from '^https?://[^/]+([^?#]*)'), '/'),
        '/+$', ''
      ), ''), '/') AS path
    FROM public.event_harvest_sources s
    WHERE s.provider = 'first_party'
      AND s.is_enabled = true
      AND s.venue_id IS NOT NULL
      AND s.source_type IN (
        'schema_org_events',
        'squarespace_events',
        'next_rsc_events'
      )
  )
  SELECT child.id AS source_id,
         parent.id AS replacement_source_id
  FROM normalized child
  JOIN public.event_processing_market_venues mv
    ON mv.venue_id = child.venue_id
   AND mv.market_id = v_market
  JOIN LATERAL (
    SELECT p.id
    FROM normalized p
    WHERE p.id <> child.id
      AND p.venue_id = child.venue_id
      AND p.host = child.host
      AND p.host <> ''
      AND p.source_type IN (
        'squarespace_events', 'next_rsc_events'
      )
      AND p.last_success_at IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.event_harvest_candidates c
        WHERE c.source_id = p.id
      )
      AND (
        (p.path = '/' AND child.path <> '/')
        OR (
          p.path <> '/'
          AND left(child.path, length(p.path) + 1)
            = p.path || '/'
        )
      )
    ORDER BY length(p.path) DESC, p.id
    LIMIT 1
  ) parent ON true
  WHERE NOT EXISTS (
    SELECT 1 FROM public.event_harvest_candidates c
    WHERE c.source_id = child.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.event_source_links l
    WHERE l.source_id = child.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.event_harvest_unresolved_venues u
    WHERE u.source_id = child.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.event_harvest_suppressions x
    WHERE x.source_id = child.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.first_party_source_executions e
    WHERE e.source_id = child.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.event_processing_work w
    WHERE w.source_id = child.id AND w.status = 'leased'
  );

  SELECT count(*) INTO v_planned FROM pg_temp.tf118_plan;

  IF v_planned NOT BETWEEN 1 AND 150 THEN
    RAISE EXCEPTION '118: unexpected retirement count %', v_planned;
  END IF;

  WITH disabled AS (
    UPDATE public.event_harvest_sources s
    SET is_enabled = false, updated_at = clock_timestamp()
    FROM pg_temp.tf118_plan p
    WHERE s.id = p.source_id
      AND s.is_enabled = true
      AND NOT EXISTS (
        SELECT 1 FROM public.event_harvest_candidates c
        WHERE c.source_id = s.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.event_source_links l
        WHERE l.source_id = s.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.event_harvest_unresolved_venues u
        WHERE u.source_id = s.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.event_harvest_suppressions x
        WHERE x.source_id = s.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.first_party_source_executions e
        WHERE e.source_id = s.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.event_processing_work w
        WHERE w.source_id = s.id AND w.status = 'leased'
      )
    RETURNING s.id
  )
  INSERT INTO public.event_harvest_source_retirements
    (source_id, replacement_source_id, reason)
  SELECT d.id, p.replacement_source_id,
    '118_history_free_detail_with_verified_inventory'
  FROM disabled d
  JOIN pg_temp.tf118_plan p ON p.source_id = d.id;

  GET DIAGNOSTICS v_changed = ROW_COUNT;

  IF v_changed <> v_planned THEN
    RAISE EXCEPTION '118: concurrent change; planned %, changed %',
      v_planned, v_changed;
  END IF;

  UPDATE public.event_processing_work w
  SET status = 'cancelled',
      last_finished_at = clock_timestamp(),
      updated_at = clock_timestamp()
  FROM public.event_harvest_source_retirements r
  WHERE w.source_id = r.source_id
    AND w.work_type = 'harvest_source'
    AND w.status IN ('pending', 'retry');

  GET DIAGNOSTICS v_jobs = ROW_COUNT;

  RAISE NOTICE '118: retired % sources; cancelled % queued jobs',
    v_changed, v_jobs;
END;
$retire$;

COMMIT;
