-- 107: Atomic Google review recording and Market request.
--
-- Preserve:
-- - existing review-only restrictions (084)
-- - durable Market-request rules (100)
-- - existing registration/approval functions
-- - all existing review decisions and Spot memberships.
--
-- One RPC call means both operations succeed or both roll back.

begin;

create function public.record_event_harvest_google_spot_in_market(
  p_place_id text,
  p_place_data jsonb,
  p_confidence_score double precision,
  p_evidence jsonb,
  p_market_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_request_status text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  if p_market_id is null then
    raise exception 'Google Spot Market is required';
  end if;

  -- Reuse the existing decision-preserving recorder.
  -- This locks the review row for this transaction.
  v_status := public.record_event_harvest_google_spot(
    p_place_id,
    p_place_data,
    p_confidence_score,
    p_evidence
  );

  if v_status = 'rejected' then
    return 'rejected';
  end if;

  if v_status not in ('pending', 'approved') then
    raise exception 'Unexpected Google review status';
  end if;

  -- Reuse the established conflict-safe Market request.
  -- Any exception here rolls back the review write above.
  v_request_status := public.request_google_spot_market(
    p_place_id,
    p_market_id
  );

  if v_request_status = 'rejected' then
    return 'rejected';
  end if;

  if v_request_status not in ('pending', 'assigned') then
    raise exception 'Unexpected Google Market request status';
  end if;

  return v_status;
end;
$$;

revoke all on function
  public.record_event_harvest_google_spot_in_market(
    text, jsonb, double precision, jsonb, uuid
  )
from public, anon, authenticated;

grant execute on function
  public.record_event_harvest_google_spot_in_market(
    text, jsonb, double precision, jsonb, uuid
  )
to service_role;

commit;
