create or replace function public.auto_approve_event_harvest_venue_match(
  p_match_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match public.event_harvest_venue_matches%rowtype;
begin
  select *
  into v_match
  from public.event_harvest_venue_matches
  where id = p_match_id
  for update;

  if not found then
    raise exception 'Venue match candidate not found';
  end if;

  /*
   * A human rejection is durable. Automated harvesting must never
   * reverse it.
   */
  if v_match.status = 'rejected' then
    raise exception 'Venue match candidate was rejected';
  end if;

  perform public.set_venue_external_ref(
    v_match.venue_id,
    v_match.provider,
    v_match.provider_place_id,
    jsonb_build_object(
      'match_source', 'event_harvester_auto_match',
      'confidence_score', v_match.confidence_score,
      'evidence', v_match.evidence
    )
  );

  update public.event_harvest_venue_matches
  set
    status = 'approved',
    reviewed_by = null,
    reviewed_at = now(),
    updated_at = now()
  where id = v_match.id;

  return v_match.id;
end;
$$;

revoke all on function public.auto_approve_event_harvest_venue_match(uuid)
from public, anon, authenticated;

grant execute on function public.auto_approve_event_harvest_venue_match(uuid)
to service_role;
