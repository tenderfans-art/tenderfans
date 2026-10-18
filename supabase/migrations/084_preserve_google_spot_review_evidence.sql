-- Preserve an existing review-only restriction across rediscovery.
-- Migration 083 already exists; never edit an applied migration.

create or replace function public.record_event_harvest_google_spot(
  p_place_id text,
  p_place_data jsonb,
  p_confidence_score double precision,
  p_evidence jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  if nullif(trim(p_place_id), '') is null then
    raise exception 'Google Place ID required';
  end if;

  insert into public.event_harvest_google_spot_reviews (
    place_id, place_data, confidence_score, evidence
  )
  values (
    p_place_id,
    p_place_data,
    p_confidence_score,
    coalesce(p_evidence, '{}'::jsonb)
  )
  on conflict (place_id) do update
  set
    place_data = excluded.place_data,
    confidence_score = excluded.confidence_score,
    evidence =
      coalesce(excluded.evidence, '{}'::jsonb)
      ||
      case
        when public.event_harvest_google_spot_reviews.status = 'pending'
         and coalesce(
           public.event_harvest_google_spot_reviews.evidence->>'reviewOnly',
           'false'
         ) = 'true'
        then '{"reviewOnly": true}'::jsonb
        else '{}'::jsonb
      end,
    last_seen_at = now();

  select status into v_status
  from public.event_harvest_google_spot_reviews
  where place_id = p_place_id;

  return v_status;
end;
$$;

revoke all on function public.record_event_harvest_google_spot(
  text, jsonb, double precision, jsonb
) from public, anon, authenticated;

grant execute on function public.record_event_harvest_google_spot(
  text, jsonb, double precision, jsonb
) to service_role;
