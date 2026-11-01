-- Migration 097
-- Bind Workflow first-party source executions to market work leases.
--
-- Additive only.
-- Existing standalone source claims remain unchanged.
-- Existing event publication functions remain unchanged.
-- No automatic source-lock recovery.
--
-- IMPORTANT:
-- This migration establishes lease-bound source claims.
-- It does not yet fence subsequent event writes.

alter table public.first_party_source_executions
  add column market_work_id uuid
    references public.event_processing_work(id)
    on delete restrict,
  add column market_lease_token uuid;

alter table public.first_party_source_executions
  add constraint first_party_market_binding_shape
  check (
    (
      market_work_id is null
      and market_lease_token is null
    )
    or
    (
      market_work_id is not null
      and market_lease_token is not null
    )
  );

create index first_party_executions_market_work_idx
  on public.first_party_source_executions(market_work_id)
  where market_work_id is not null;

create function
public.claim_market_first_party_source_execution(
  p_source_id uuid,
  p_work_id uuid,
  p_lease_token uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token uuid := gen_random_uuid();
  v_work_source_id uuid;
  v_work_status text;
  v_work_lease_token uuid;
  v_work_leased_until timestamptz;
begin
  if p_source_id is null
     or p_work_id is null
     or p_lease_token is null then
    raise exception
      'Market source claim requires source, work, and lease token';
  end if;

  /*
   * Lock the work row first.
   *
   * This serializes the claim against lease renewal,
   * completion, failure, and reassignment.
   */
  select
    w.source_id,
    w.status,
    w.lease_token,
    w.leased_until
  into
    v_work_source_id,
    v_work_status,
    v_work_lease_token,
    v_work_leased_until
  from public.event_processing_work w
  where w.id = p_work_id
    and w.work_type = 'harvest_source'
  for update;

  if not found
     or v_work_source_id is distinct from p_source_id
     or v_work_status is distinct from 'leased'
     or v_work_lease_token is distinct from p_lease_token
     or v_work_leased_until is null
     or v_work_leased_until <= clock_timestamp() then
    raise exception
      'Market work lease ownership invalid for work %',
      p_work_id;
  end if;

  /*
   * Preserve the existing one-execution-per-source
   * exclusion using the source_id primary key.
   *
   * Never replace an existing execution automatically.
   */
  insert into public.first_party_source_executions (
    source_id,
    execution_token,
    market_work_id,
    market_lease_token
  )
  values (
    p_source_id,
    v_token,
    p_work_id,
    p_lease_token
  )
  on conflict (source_id) do nothing;

  if found then
    return v_token;
  end if;

  return null;
end;
$$;

revoke all on function
public.claim_market_first_party_source_execution(
  uuid, uuid, uuid
)
from public, anon, authenticated;

grant execute on function
public.claim_market_first_party_source_execution(
  uuid, uuid, uuid
)
to service_role;

-- Transactional first-party write fencing.
-- Each operation is allowlisted; no arbitrary SQL is accepted.

create function public.execute_fenced_first_party_write(
  p_source_id uuid,
  p_execution_token uuid,
  p_operation text,
  p_args jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fence$
declare
  v_execution record;
  v_work record;
  v_result jsonb;
begin
  if p_source_id is null
     or p_execution_token is null
     or p_operation is null
     or p_args is null
     or jsonb_typeof(p_args) <> 'object' then
    raise exception 'Invalid first-party write request';
  end if;

  -- Read the binding before acquiring locks, then verify it
  -- again after locking. Market work is always locked first.
  select e.market_work_id, e.market_lease_token
  into v_execution
  from public.first_party_source_executions e
  where e.source_id = p_source_id
    and e.execution_token = p_execution_token;

  if not found then
    raise exception 'First-party execution ownership lost';
  end if;

  if v_execution.market_work_id is not null then
    select w.source_id, w.work_type, w.status,
           w.lease_token, w.leased_until
    into v_work
    from public.event_processing_work w
    where w.id = v_execution.market_work_id
    for update;

    if not found
       or v_work.source_id is distinct from p_source_id
       or v_work.work_type is distinct from 'harvest_source'
       or v_work.status is distinct from 'leased'
       or v_work.lease_token is distinct from
          v_execution.market_lease_token
       or v_work.leased_until <= clock_timestamp() then
      raise exception 'First-party market lease ownership lost';
    end if;
  end if;

  perform public.assert_first_party_execution_ownership(
    p_source_id, p_execution_token
  );

  -- Recheck the execution binding after acquiring its row lock.
  perform 1
  from public.first_party_source_executions e
  where e.source_id = p_source_id
    and e.execution_token = p_execution_token
    and e.market_work_id is not distinct from
        v_execution.market_work_id
    and e.market_lease_token is not distinct from
        v_execution.market_lease_token;

  if not found then
    raise exception 'First-party execution binding changed';
  end if;

  -- Recheck expiry after all lock waits.
  if v_execution.market_work_id is not null then
    perform 1
    from public.event_processing_work w
    where w.id = v_execution.market_work_id
      and w.status = 'leased'
      and w.lease_token = v_execution.market_lease_token
      and w.leased_until > clock_timestamp();

    if not found then
      raise exception 'First-party market lease expired';
    end if;
  end if;

  if p_operation = 'resolve_pending_facebook_review' then
    update public.event_harvest_unresolved_venues
    set status = 'resolved',
        resolved_venue_id =
          (p_args ->> 'p_resolved_venue_id')::uuid,
        updated_at = clock_timestamp()
    where source_id = p_source_id
      and external_event_id =
          p_args ->> 'p_external_event_id'
      and status = 'pending';

    return null;
  elsif p_operation = 'upsert_event_harvest_unresolved_venue' then

    if (p_args ->> 'p_source_id')::uuid
       is distinct from p_source_id then
      raise exception 'Source argument does not match execution';
    end if;
    return to_jsonb(public.upsert_event_harvest_unresolved_venue(
        p_source_id => (p_args ->> 'p_source_id')::uuid,
        p_external_event_id => (p_args ->> 'p_external_event_id')::text,
        p_source_url => (p_args ->> 'p_source_url')::text,
        p_raw_title => (p_args ->> 'p_raw_title')::text,
        p_raw_starts_at => (p_args ->> 'p_raw_starts_at')::text,
        p_raw_ends_at => (p_args ->> 'p_raw_ends_at')::text,
        p_publisher_venue_name => (p_args ->> 'p_publisher_venue_name')::text,
        p_publisher_address => (p_args ->> 'p_publisher_address')::text,
        p_publisher_city => (p_args ->> 'p_publisher_city')::text,
        p_publisher_state_region => (p_args ->> 'p_publisher_state_region')::text,
        p_publisher_postal_code => (p_args ->> 'p_publisher_postal_code')::text,
        p_suggested_venue_id => (p_args ->> 'p_suggested_venue_id')::uuid,
        p_confidence_score => (p_args ->> 'p_confidence_score')::numeric,
        p_evidence => p_args -> 'p_evidence',
        p_raw_payload => p_args -> 'p_raw_payload'
      ));
  elsif p_operation = 'upsert_event_harvest_candidate' then

    if (p_args ->> 'p_source_id')::uuid
       is distinct from p_source_id then
      raise exception 'Source argument does not match execution';
    end if;
    return to_jsonb(public.upsert_event_harvest_candidate(
        p_source_id => (p_args ->> 'p_source_id')::uuid,
        p_external_event_id => (p_args ->> 'p_external_event_id')::text,
        p_source_url => (p_args ->> 'p_source_url')::text,
        p_raw_title => (p_args ->> 'p_raw_title')::text,
        p_raw_venue_name => (p_args ->> 'p_raw_venue_name')::text,
        p_raw_address => (p_args ->> 'p_raw_address')::text,
        p_raw_description => (p_args ->> 'p_raw_description')::text,
        p_raw_starts_at => (p_args ->> 'p_raw_starts_at')::text,
        p_raw_ends_at => (p_args ->> 'p_raw_ends_at')::text,
        p_normalized_title => (p_args ->> 'p_normalized_title')::text,
        p_starts_at => (p_args ->> 'p_starts_at')::timestamptz,
        p_ends_at => (p_args ->> 'p_ends_at')::timestamptz,
        p_venue_id => (p_args ->> 'p_venue_id')::uuid,
        p_confidence_score => (p_args ->> 'p_confidence_score')::numeric,
        p_event_fingerprint => (p_args ->> 'p_event_fingerprint')::text,
        p_raw_payload => p_args -> 'p_raw_payload'
      ));
  elsif p_operation = 'mark_harvest_candidate_for_review' then

    perform 1
    from public.event_harvest_candidates c
    where c.id = (p_args ->> 'p_candidate_id')::uuid
      and c.source_id = p_source_id;

    if not found then
      raise exception 'Candidate does not belong to source execution';
    end if;
    perform public.mark_harvest_candidate_for_review(
        p_candidate_id => (p_args ->> 'p_candidate_id')::uuid
      );
      return null;
  elsif p_operation = 'link_harvest_candidate_to_existing_event' then

    perform 1
    from public.event_harvest_candidates c
    where c.id = (p_args ->> 'p_candidate_id')::uuid
      and c.source_id = p_source_id;

    if not found then
      raise exception 'Candidate does not belong to source execution';
    end if;
    return to_jsonb(public.link_harvest_candidate_to_existing_event(
        p_candidate_id => (p_args ->> 'p_candidate_id')::uuid
      ));
  elsif p_operation = 'flag_event_harvest_occurrence_review' then

    perform 1
    from public.event_harvest_candidates c
    where c.id = (p_args ->> 'p_candidate_id')::uuid
      and c.source_id = p_source_id;

    if not found then
      raise exception 'Candidate does not belong to source execution';
    end if;
    return to_jsonb(public.flag_event_harvest_occurrence_review(
        p_candidate_id => (p_args ->> 'p_candidate_id')::uuid
      ));
  elsif p_operation = 'graduate_harvest_candidate' then

    perform 1
    from public.event_harvest_candidates c
    where c.id = (p_args ->> 'p_candidate_id')::uuid
      and c.source_id = p_source_id;

    if not found then
      raise exception 'Candidate does not belong to source execution';
    end if;
    return to_jsonb(public.graduate_harvest_candidate(
        p_candidate_id => (p_args ->> 'p_candidate_id')::uuid,
        p_reviewed_by => (p_args ->> 'p_reviewed_by')::uuid
      ));
  elsif p_operation = 'sync_first_party_event' then

    perform 1
    from public.event_harvest_candidates c
    where c.id = (p_args ->> 'p_candidate_id')::uuid
      and c.source_id = p_source_id;

    if not found then
      raise exception 'Candidate does not belong to source execution';
    end if;
    return to_jsonb(public.sync_first_party_event(
        p_candidate_id => (p_args ->> 'p_candidate_id')::uuid,
        p_source_url => (p_args ->> 'p_source_url')::text,
        p_raw_title => (p_args ->> 'p_raw_title')::text,
        p_raw_description => (p_args ->> 'p_raw_description')::text,
        p_raw_starts_at => (p_args ->> 'p_raw_starts_at')::text,
        p_raw_ends_at => (p_args ->> 'p_raw_ends_at')::text,
        p_normalized_title => (p_args ->> 'p_normalized_title')::text,
        p_starts_at => (p_args ->> 'p_starts_at')::timestamptz,
        p_ends_at => (p_args ->> 'p_ends_at')::timestamptz,
        p_event_fingerprint => (p_args ->> 'p_event_fingerprint')::text,
        p_flyer_url => (p_args ->> 'p_flyer_url')::text,
        p_raw_payload => p_args -> 'p_raw_payload'
      ));
  elsif p_operation = 'reconcile_first_party_source_absences' then

    if (p_args ->> 'p_source_id')::uuid
       is distinct from p_source_id then
      raise exception 'Source argument does not match execution';
    end if;
    select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
      into v_result
      from public.reconcile_first_party_source_absences(
        p_source_id => (p_args ->> 'p_source_id')::uuid,
        p_scan_started_at => (p_args ->> 'p_scan_started_at')::timestamptz
      ) r;
      return v_result;
  else
    raise exception 'Unsupported first-party operation: %',
      p_operation;
  end if;
end;
$fence$;

revoke all on function
public.execute_fenced_first_party_write(uuid, uuid, text, jsonb)
from public, anon, authenticated;

grant execute on function
public.execute_fenced_first_party_write(uuid, uuid, text, jsonb)
to service_role;
