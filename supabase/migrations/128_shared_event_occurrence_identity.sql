-- Shared occurrence identity and timed-over-all-day precedence.
-- Source observations remain independent provenance. No adapter or Spot cases.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '90s';

do $$
declare expected record;
begin
  for expected in select * from (values
    ('public.link_harvest_candidate_to_existing_event(uuid)', '2e8c67eacfc6eb23ebd22d7927d29c90'),
    ('public.flag_event_harvest_occurrence_review(uuid)', '7ac136128225bb0a9433cd897adf86c2'),
    ('public.graduate_harvest_candidate(uuid,uuid)', 'bf0d9d0ff18b227ec67e7990428639a2'),
    ('public.bootstrap_first_party_harvest_candidate(uuid)', 'dbf328c8b19fec908959dc876bbfa162'),
    ('public.reconcile_first_party_source_absences(uuid,timestamp with time zone)', '15a5105a8cac46af113599c3f453e1ad')
  ) as baseline(signature, body_hash) loop
    if (select md5(prosrc) from pg_catalog.pg_proc where oid = expected.signature::regprocedure)
       is distinct from expected.body_hash then
      raise exception '128: % differs from the verified baseline', expected.signature;
    end if;
  end loop;
end;
$$;

alter table public.events
  add column merged_into_event_id uuid references public.events(id);

create function public.event_harvest_normalize_event_url(p_url text)
returns text language plpgsql immutable set search_path = public as $$
declare v text := btrim(p_url); origin text; suffix text;
begin
  if v is null or v ~ '[[:space:]]' then return null; end if;
  origin := substring(v from '^https?://[^/?#]+');
  if origin is null or position('@' in origin) > 0 then return null; end if;
  suffix := substring(v from length(origin) + 1);
  if suffix in ('', '/') then return null; end if;
  -- Preserve query strings, fragments and case-sensitive paths.
  if position('?' in suffix) = 0 and position('#' in suffix) = 0 then
    suffix := rtrim(suffix, '/');
  end if;
  return lower(origin) || suffix;
end;
$$;

create function public.event_harvest_occurrence_url(p_candidate public.event_harvest_candidates)
returns text language sql stable set search_path = public as $$
  select public.event_harvest_normalize_event_url(p_candidate.source_url)
  from public.event_harvest_sources s
  where s.id = p_candidate.source_id
    and public.event_harvest_normalize_event_url(p_candidate.source_url) is not null
    and public.event_harvest_normalize_event_url(p_candidate.source_url)
      is distinct from public.event_harvest_normalize_event_url(s.source_url)
$$;

create function public.event_harvest_occurrence_date(p_candidate public.event_harvest_candidates)
returns date language plpgsql stable set search_path = public as $$
declare zone text := p_candidate.raw_payload #>> '{tenderfansOccurrence,timeZone}';
begin
  if p_candidate.is_all_day then
    return (p_candidate.starts_at at time zone 'UTC')::date;
  end if;
  if zone is null then return null; end if;
  -- PostgreSQL caches timezone conversion. Do not enumerate every timezone
  -- for every peer considered during deduplication.
  begin
    return (p_candidate.starts_at at time zone zone)::date;
  exception when invalid_parameter_value then return null;
  end;
end;
$$;

create function public.event_harvest_same_occurrence(
  p_left public.event_harvest_candidates,
  p_right public.event_harvest_candidates
)
returns boolean language plpgsql stable set search_path = public as $$
declare left_timed timestamptz; right_timed timestamptz; left_date date; right_date date;
begin
  if p_left.venue_id is null or p_left.venue_id is distinct from p_right.venue_id then
    return false;
  end if;
  if not p_left.is_all_day then left_timed := p_left.starts_at;
  else
    select e.starts_at into left_timed from public.events e
    where e.id = p_left.canonical_event_id and not e.is_all_day;
  end if;
  if not p_right.is_all_day then right_timed := p_right.starts_at;
  else
    select e.starts_at into right_timed from public.events e
    where e.id = p_right.canonical_event_id and not e.is_all_day;
  end if;
  if left_timed is not null and right_timed is not null and left_timed <> right_timed then
    return false;
  end if;
  if p_left.is_all_day <> p_right.is_all_day then
    left_date := public.event_harvest_occurrence_date(p_left);
    right_date := public.event_harvest_occurrence_date(p_right);
    if left_date is not null and right_date is not null and left_date <> right_date then return false; end if;
  end if;
  -- Existing exact identity remains authoritative.
  if nullif(p_left.event_fingerprint, '') = nullif(p_right.event_fingerprint, '') then
    return true;
  end if;
  if nullif(lower(btrim(p_left.normalized_title)), '') is distinct from
       nullif(lower(btrim(p_right.normalized_title)), '')
     or nullif(btrim(p_left.normalized_title), '') is null
     or public.event_harvest_occurrence_url(p_left) is null
     or public.event_harvest_occurrence_url(p_left) is distinct from
        public.event_harvest_occurrence_url(p_right) then return false; end if;

  left_date := public.event_harvest_occurrence_date(p_left);
  right_date := public.event_harvest_occurrence_date(p_right);
  if left_date is null or right_date is null or left_date <> right_date then return false; end if;

  -- A broad multi-day listing cannot absorb an individual performance.
  if (p_left.is_all_day and p_left.ends_at is not null and
       (p_left.ends_at at time zone 'UTC')::date - left_date > 1)
     or (p_right.is_all_day and p_right.ends_at is not null and
       (p_right.ends_at at time zone 'UTC')::date - right_date > 1) then return false; end if;

  -- An all-day observation already linked to one timed performance must
  -- never become a bridge that combines a second, differently timed show.
  return left_timed is null or right_timed is null or left_timed = right_timed;
end;
$$;

create function public.lock_event_harvest_occurrence(p_candidate_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare spot uuid;
begin
  select c.venue_id into spot from public.event_harvest_candidates c where c.id = p_candidate_id;
  if spot is not null then
    perform pg_advisory_xact_lock(hashtextextended('event-occurrence:' || spot::text, 0));
  end if;
end;
$$;

create function public.guard_event_harvest_timing()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.merged_into_event_id is not null and new.merged_into_event_id is null then
    new.merged_into_event_id := old.merged_into_event_id;
  end if;
  if new.merged_into_event_id is not null then
    if new.merged_into_event_id = new.id or not exists (
      select 1 from public.events target where target.id = new.merged_into_event_id
        and target.venue_id = new.venue_id and target.merged_into_event_id is null
        and target.status = 'published'
    ) then raise exception 'Merged event must point to a published event at the same Spot'; end if;
    new.status := 'cancelled';
  end if;
  if new.is_all_day and not old.is_all_day and exists (
    select 1 from public.event_harvest_candidates c
    where c.canonical_event_id = old.id and not c.is_all_day
      and c.status = 'published'
  ) then
    new.starts_at := old.starts_at;
    new.ends_at := old.ends_at;
    new.is_all_day := false;
  end if;
  return new;
end;
$$;
create trigger guard_event_harvest_timing before update on public.events
for each row execute function public.guard_event_harvest_timing();

create function public.promote_event_harvest_timing()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.canonical_event_id is not null and not new.is_all_day and new.status = 'published' then
    update public.events e
    set starts_at = new.starts_at, ends_at = new.ends_at, is_all_day = false, updated_at = now()
    where e.id = new.canonical_event_id and e.venue_id = new.venue_id
      and e.is_all_day and e.merged_into_event_id is null;
  end if;
  return new;
end;
$$;
create trigger promote_event_harvest_timing
after update of canonical_event_id, starts_at, status on public.event_harvest_candidates
for each row execute function public.promote_event_harvest_timing();

create function public.preserve_event_occurrence_evidence()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.venue_id is not distinct from old.venue_id
     and (new.raw_payload -> 'tenderfansOccurrence' is null or
      new.raw_payload -> 'tenderfansOccurrence' = 'null'::jsonb)
     and old.raw_payload -> 'tenderfansOccurrence' is not null then
    new.raw_payload := coalesce(new.raw_payload, '{}'::jsonb) ||
      jsonb_build_object('tenderfansOccurrence', old.raw_payload -> 'tenderfansOccurrence');
  end if;
  return new;
end;
$$;
create trigger preserve_event_occurrence_evidence
before update of raw_payload on public.event_harvest_candidates
for each row execute function public.preserve_event_occurrence_evidence();

-- Patch the existing RPCs in place, retaining their OIDs, grants, provider
-- authority, review gates, notification suppression and fenced callers.
do $$
declare definition text; original text; signature regprocedure;
begin
  foreach signature in array array[
    'public.link_harvest_candidate_to_existing_event(uuid)'::regprocedure,
    'public.flag_event_harvest_occurrence_review(uuid)'::regprocedure,
    'public.graduate_harvest_candidate(uuid,uuid)'::regprocedure,
    'public.bootstrap_first_party_harvest_candidate(uuid)'::regprocedure
  ] loop
    definition := pg_get_functiondef(signature);
    original := definition;
    definition := regexp_replace(definition, E'begin\n',
      E'begin\n  perform public.lock_event_harvest_occurrence(p_candidate_id);\n', 'i');

    if signature = 'public.link_harvest_candidate_to_existing_event(uuid)'::regprocedure then
      if position('c.event_fingerprint = candidate_record.event_fingerprint' in definition) = 0 then
        raise exception '128: Unexpected cross-source identity definition'; end if;
      definition := replace(definition,
        'c.event_fingerprint = candidate_record.event_fingerprint',
        'public.event_harvest_same_occurrence(candidate_record, c)');
    elsif signature = 'public.flag_event_harvest_occurrence_review(uuid)'::regprocedure then
      -- Multiple canonical matches require review, including legacy doubles
      -- and all-day observations that could refer to several performances.
      if position('  /*' in definition) = 0 then raise exception '128: Unexpected review definition'; end if;
      definition := overlay(definition placing $body$
  if v_candidate.canonical_event_id is null and ((
    select count(distinct peer.canonical_event_id) > 1
    from public.event_harvest_candidates peer
    join public.events e on e.id = peer.canonical_event_id
    where peer.id <> v_candidate.id and peer.status = 'published'
      and e.status = 'published'
      and public.event_harvest_same_occurrence(v_candidate, peer)
  ) or exists (
    select 1 from public.event_harvest_candidates peer
    join public.events established on established.id = peer.canonical_event_id
    where peer.venue_id = v_candidate.venue_id and peer.status = 'published'
      and established.status = 'published' and peer.is_all_day <> v_candidate.is_all_day
      and peer.normalized_title = v_candidate.normalized_title
      and public.event_harvest_occurrence_url(v_candidate) is not null
      and public.event_harvest_occurrence_url(peer) = public.event_harvest_occurrence_url(v_candidate)
      and (public.event_harvest_occurrence_date(peer) is null
        or public.event_harvest_occurrence_date(v_candidate) is null)
      and abs(extract(epoch from (peer.starts_at - v_candidate.starts_at))) <= 129600
  )) then
    update public.event_harvest_candidates
    set status = 'needs_review', raw_payload = raw_payload || jsonb_build_object(
      'occurrenceReview', jsonb_build_object('requiresReview', true,
        'reason', 'ambiguous_event_identity', 'flaggedAt', now())), updated_at = now()
    where id = p_candidate_id;
    return true;
  end if;

$body$ from position('  /*' in definition) for 0);
    else
      if position('  insert into public.events (' in definition) = 0 then
        raise exception '128: Unexpected graduation definition'; end if;
      -- Recheck after obtaining the per-Spot transaction lock. Earlier RPC
      -- checks alone cannot prevent two simultaneous sources from publishing.
      definition := overlay(definition placing $body$
  if candidate_record.canonical_event_id is null then
    created_event_id := public.link_harvest_candidate_to_existing_event(p_candidate_id);
    if created_event_id is not null then return created_event_id; end if;
    if public.flag_event_harvest_occurrence_review(p_candidate_id) then return null; end if;
  end if;

$body$ from position('  insert into public.events (' in definition) for 0);
    end if;
    if signature = 'public.graduate_harvest_candidate(uuid,uuid)'::regprocedure then
      definition := replace(definition,
        'if public.flag_event_harvest_occurrence_review(p_candidate_id) then return null; end if;',
        'if p_reviewed_by is null and public.flag_event_harvest_occurrence_review(p_candidate_id) then return null; end if;');
      definition := regexp_replace(definition, E'ends_at,\n([ ]+)status,',
        E'ends_at,\n\\1is_all_day,\n\\1status,');
      definition := regexp_replace(definition, E'candidate_record.ends_at,\n([ ]+)''draft'',',
        E'candidate_record.ends_at,\n\\1candidate_record.is_all_day,\n\\1''draft'',');
    end if;
    if definition = original then raise exception '128: RPC was not updated'; end if;
    execute definition;
  end loop;
end;
$$;

-- A canonical shared by several observations survives while any enabled
-- source still confirms it. Each source retains its own absence counters.
do $$
declare definition text;
begin
  definition := pg_get_functiondef('public.reconcile_first_party_source_absences(uuid,timestamptz)'::regprocedure);
  if position('for update of c, e' in definition) = 0 then
    raise exception '128: Unexpected absence reconciliation definition'; end if;
  definition := regexp_replace(definition, E'declare\n', E'declare\n  occurrence_venue uuid;\n', 'i');
  definition := overlay(definition placing $body$
  for occurrence_venue in select distinct c.venue_id from public.event_harvest_candidates c
    where c.source_id = p_source_id and c.venue_id is not null order by c.venue_id loop
    perform pg_advisory_xact_lock(hashtextextended('event-occurrence:' || occurrence_venue::text, 0));
  end loop;

$body$ from position('  update public.event_harvest_candidates' in definition) for 0);
  definition := replace(definition, 'for update of c, e', $body$
      and not exists (
        select 1 from public.event_harvest_candidates peer
        join public.event_harvest_sources peer_source on peer_source.id = peer.source_id
        where peer.canonical_event_id = c.canonical_event_id and peer.id <> c.id
          and peer.venue_id = c.venue_id and peer.status = 'published'
          and peer.consecutive_missing_scans < 2 and peer_source.is_enabled
      )
    for update of c, e
$body$);
  execute definition;
end;
$$;

create function public.resolve_published_event_id(p_event_id uuid)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare current_id uuid := p_event_id; row_record public.events%rowtype;
begin
  for i in 1..8 loop
    select * into row_record from public.events where id = current_id;
    if not found then return null; end if;
    if row_record.merged_into_event_id is null then
      return case when row_record.status = 'published' then row_record.id else null end;
    end if;
    current_id := row_record.merged_into_event_id;
  end loop;
  return null;
end;
$$;

revoke all on function public.resolve_published_event_id(uuid) from public;
grant execute on function public.resolve_published_event_id(uuid) to anon, authenticated, service_role;

create function public.merge_event_harvest_duplicate(p_keep uuid, p_duplicate uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare keeper public.events%rowtype; duplicate public.events%rowtype;
begin
  select * into keeper from public.events where id = p_keep;
  if not found then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('event-occurrence:' || keeper.venue_id::text, 0));
  if exists (
    select 1 from public.first_party_source_executions execution
    join public.event_harvest_candidates c on c.source_id = execution.source_id
    where c.canonical_event_id in (p_keep, p_duplicate)
  ) then return false; end if;
  perform 1 from public.events where id in (p_keep, p_duplicate) order by id for update;
  select * into keeper from public.events where id = p_keep;
  select * into duplicate from public.events where id = p_duplicate;
  if duplicate.id is null or p_keep = p_duplicate or keeper.venue_id <> duplicate.venue_id
     or keeper.status <> 'published' or duplicate.status <> 'published'
     or keeper.merged_into_event_id is not null or duplicate.merged_into_event_id is not null
     or (keeper.is_all_day and not duplicate.is_all_day)
     or keeper.submitted_by is not null or duplicate.submitted_by is not null then return false; end if;
  if exists (select 1 from public.event_source_links
             where event_id in (p_keep, p_duplicate) and owner_overridden) then return false; end if;
  if not exists (
    select 1 from public.event_harvest_candidates a
    join public.event_harvest_candidates b on b.canonical_event_id = p_duplicate
    where a.canonical_event_id = p_keep and a.status = 'published' and b.status = 'published'
      and public.event_harvest_same_occurrence(a, b)
  ) then return false; end if;

  -- A sender already holding a delivery must finish before maintenance retries.
  perform 1 from public.notification_events
    where source_kind = 'event' and source_id in (p_keep, p_duplicate) order by id for update;
  if exists (select 1 from public.notification_events
      where source_kind = 'event' and source_id in (p_keep, p_duplicate) and status = 'processing') or exists (
    select 1 from public.notification_deliveries d
    left join public.event_reminders r on r.id = d.reminder_id
    left join public.notification_events n on n.id = d.notification_event_id
    left join public.notification_outbox o on o.id = d.outbox_id
    where d.status = 'processing' and
      (r.event_id in (p_keep, p_duplicate) or n.source_id in (p_keep, p_duplicate)
       or o.event_id in (p_keep, p_duplicate))
  ) then return false; end if;
  perform 1 from public.event_reminders where event_id in (p_keep, p_duplicate) order by id for update;
  -- Keep independently issued verification/cancellation tokens and sent-delivery
  -- histories intact. A recipient collision requires separate adjudication.
  if exists (
    select 1 from public.event_reminders a join public.event_reminders b
      on lower(a.email) = lower(b.email) and a.reminder_minutes_before = b.reminder_minutes_before
    where a.event_id = p_keep and b.event_id = p_duplicate
  ) then return false; end if;

  update public.event_reminders set event_id = p_keep, updated_at = now() where event_id = p_duplicate;

  update public.event_source_links set event_id = p_keep, updated_at = now() where event_id = p_duplicate;
  update public.event_harvest_candidates set canonical_event_id = p_keep, updated_at = now()
    where canonical_event_id = p_duplicate;
  update public.notification_events set status = 'suppressed', processed_at = now(),
    metadata = metadata || jsonb_build_object('merged_into_event_id', p_keep)
    where source_kind = 'event' and source_id = p_duplicate and status in ('pending', 'failed');
  update public.notification_outbox set processed_at = coalesce(processed_at, now()),
    url_path = '/events?event=' || p_keep::text where event_id = p_duplicate;
  update public.events set status = 'cancelled', merged_into_event_id = p_keep, updated_at = now()
    where id = p_duplicate;
  update public.events set merged_into_event_id = p_keep where merged_into_event_id = p_duplicate;
  return true;
end;
$$;

create function public.reconcile_event_harvest_duplicates(p_venue_id uuid, p_time_zone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare group_record record; keep_id uuid; loser_id uuid; live_ids uuid[];
  merged integer := 0; skipped integer := 0; timing public.event_harvest_candidates%rowtype;
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_time_zone) then
    raise exception 'A verified IANA timezone is required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('event-occurrence:' || p_venue_id::text, 0));
  -- Application ingestion spans several fenced RPCs. Preserve its canonical
  -- ID until the existing source execution has ended; never clear its lease.
  if exists (
    select 1 from public.first_party_source_executions execution
    join public.event_harvest_candidates c on c.source_id = execution.source_id
    where c.venue_id = p_venue_id
  ) then
    return jsonb_build_object('merged_events', 0, 'skipped_groups', 0, 'deferred_venues', 1);
  end if;
  update public.event_harvest_candidates set raw_payload = raw_payload || jsonb_build_object(
    'tenderfansOccurrence', jsonb_build_object('version', 1, 'timeZone', p_time_zone))
    where venue_id = p_venue_id and canonical_event_id is not null;

  for group_record in
    select array_agg(distinct c.canonical_event_id) as ids
    from public.event_harvest_candidates c join public.events e on e.id = c.canonical_event_id
    where c.venue_id = p_venue_id and c.status = 'published' and e.status = 'published'
      and public.event_harvest_occurrence_url(c) is not null
    group by c.normalized_title, public.event_harvest_occurrence_url(c), public.event_harvest_occurrence_date(c)
    having count(distinct c.canonical_event_id) > 1
      and count(distinct c.starts_at) filter (where not c.is_all_day) <= 1
    union
    select array_agg(distinct c.canonical_event_id) as ids
    from public.event_harvest_candidates c join public.events e on e.id = c.canonical_event_id
    where c.venue_id = p_venue_id and c.status = 'published' and e.status = 'published'
      and nullif(c.event_fingerprint, '') is not null
    group by c.event_fingerprint having count(distinct c.canonical_event_id) > 1
  loop
    select array_agg(e.id order by e.is_all_day, e.created_at, e.id) into live_ids
      from public.events e where e.id = any(group_record.ids) and e.merged_into_event_id is null;
    if coalesce(array_length(live_ids, 1), 0) < 2 then continue; end if;
    -- A legacy all-day candidate cannot bridge two different timed performances.
    if (select count(distinct starts_at) from public.events where id = any(live_ids) and not is_all_day) > 1 then
      skipped := skipped + 1; continue;
    end if;
    keep_id := live_ids[1];
    for loser_id in select unnest(live_ids[2:]) loop
      if public.merge_event_harvest_duplicate(keep_id, loser_id) then merged := merged + 1;
      else skipped := skipped + 1; end if;
    end loop;
    -- Timing can be more precise than a legacy canonical's all-day fields.
    if (select count(distinct c.starts_at) from public.event_harvest_candidates c
        where c.canonical_event_id = keep_id and c.status = 'published' and not c.is_all_day) = 1 then
      select * into timing from public.event_harvest_candidates c
        where c.canonical_event_id = keep_id and c.status = 'published' and not c.is_all_day
        order by c.last_verified_at desc nulls last, c.id limit 1;
      update public.events set starts_at = timing.starts_at, ends_at = timing.ends_at,
        is_all_day = false, updated_at = now() where id = keep_id and is_all_day;
    end if;
  end loop;
  return jsonb_build_object('merged_events', merged, 'skipped_groups', skipped, 'deferred_venues', 0);
end;
$$;

do $$
declare signature regprocedure;
begin
  for signature in select oid::regprocedure from pg_catalog.pg_proc
    where pronamespace = 'public'::regnamespace and proname in (
      'event_harvest_normalize_event_url', 'event_harvest_occurrence_url',
      'event_harvest_occurrence_date', 'event_harvest_same_occurrence',
      'lock_event_harvest_occurrence', 'guard_event_harvest_timing',
      'promote_event_harvest_timing', 'preserve_event_occurrence_evidence',
      'merge_event_harvest_duplicate', 'reconcile_event_harvest_duplicates'
    ) loop
    execute format('revoke all on function %s from public, anon, authenticated', signature);
    execute format('grant execute on function %s to service_role', signature);
  end loop;
end;
$$;

commit;
