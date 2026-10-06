-- ============================================================
-- 069_calendar_event_verification.sql
--
-- Admin verification for first-party calendar-image events
-- whose occurrence evidence requires human review.
--
-- This remains separate from venue-attribution review and from
-- detector/source-management findings.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Calendar event verification queue
-- ------------------------------------------------------------

create or replace function public.admin_list_calendar_event_verifications()
returns table (
  id uuid,
  source_id uuid,
  source_name text,
  external_event_id text,
  source_url text,
  raw_title text,
  raw_description text,
  raw_starts_at text,
  raw_ends_at text,
  normalized_title text,
  starts_at timestamptz,
  ends_at timestamptz,
  venue_id uuid,
  venue_name text,
  event_fingerprint text,
  is_all_day boolean,
  raw_payload jsonb,
  last_seen_at timestamptz,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  ) then
    raise exception 'Admin access required';
  end if;

  return query
  select
    c.id,
    c.source_id,
    s.name,
    c.external_event_id,
    c.source_url,
    c.raw_title,
    c.raw_description,
    c.raw_starts_at,
    c.raw_ends_at,
    c.normalized_title,
    c.starts_at,
    c.ends_at,
    c.venue_id,
    v.name,
    c.event_fingerprint,
    c.is_all_day,
    c.raw_payload,
    c.last_seen_at,
    c.created_at
  from public.event_harvest_candidates c
  join public.event_harvest_sources s
    on s.id = c.source_id
  join public.venues v
    on v.id = c.venue_id
  where c.status = 'needs_review'
    and s.provider = 'first_party'
    and s.source_type = 'calendar_image'
    and s.is_enabled = true
    and c.raw_payload->>'adapter' = 'calendar_image'
    and coalesce(
      (c.raw_payload->'eventEvidence'->>'requiresReview')::boolean,
      false
    ) = true
  order by
    c.starts_at asc,
    c.created_at asc;
end;
$$;

revoke all
on function public.admin_list_calendar_event_verifications()
from public;

grant execute
on function public.admin_list_calendar_event_verifications()
to authenticated;


-- ------------------------------------------------------------
-- 2. Review one calendar-image occurrence
--
-- Reject uses the established ignored lifecycle.
--
-- Approval deliberately performs:
--   graduate_harvest_candidate
--   -> sync_first_party_event
--
-- This preserves the normal first-party lifecycle rather than
-- creating an Admin-only publication path.
-- ------------------------------------------------------------

create or replace function public.admin_review_calendar_event_verification(
  p_candidate_id uuid,
  p_approve boolean
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate_record public.event_harvest_candidates%rowtype;
  source_record public.event_harvest_sources%rowtype;
  canonical_event_id uuid;
  synced_event_id uuid;
  image_url text;
begin
  if not exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  ) then
    raise exception 'Admin access required';
  end if;

  select c.*
  into candidate_record
  from public.event_harvest_candidates c
  where c.id = p_candidate_id
  for update;

  if not found then
    raise exception 'Calendar event verification candidate not found';
  end if;

  select s.*
  into source_record
  from public.event_harvest_sources s
  where s.id = candidate_record.source_id
    and s.provider = 'first_party'
    and s.source_type = 'calendar_image'
    and s.is_enabled = true;

  if not found then
    raise exception 'Enabled calendar-image first-party source not found';
  end if;

  if candidate_record.status <> 'needs_review' then
    raise exception
      'Calendar event candidate cannot be reviewed from status %',
      candidate_record.status;
  end if;

  if candidate_record.raw_payload->>'adapter' <> 'calendar_image'
     or coalesce(
       (candidate_record.raw_payload->'eventEvidence'->>'requiresReview')::boolean,
       false
     ) <> true then
    raise exception 'Candidate does not require calendar-event verification';
  end if;

  if not p_approve then
    update public.event_harvest_candidates
    set
      status = 'ignored',
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      updated_at = now()
    where id = p_candidate_id;

    return null;
  end if;

  canonical_event_id :=
    public.graduate_harvest_candidate(
      p_candidate_id,
      auth.uid()
    );

  if canonical_event_id is null then
    raise exception 'Calendar event graduation returned no canonical event';
  end if;

  image_url :=
    nullif(
      trim(candidate_record.raw_payload->>'imageUrl'),
      ''
    );

  synced_event_id :=
    public.sync_first_party_event(
      p_candidate_id,
      candidate_record.source_url,
      candidate_record.raw_title,
      candidate_record.raw_description,
      candidate_record.raw_starts_at,
      candidate_record.raw_ends_at,
      candidate_record.normalized_title,
      candidate_record.starts_at,
      candidate_record.ends_at,
      candidate_record.event_fingerprint,
      image_url,
      candidate_record.raw_payload
    );

  if synced_event_id is distinct from canonical_event_id then
    raise exception 'Calendar event canonical sync mismatch';
  end if;

  update public.event_harvest_candidates
  set
    reviewed_by = auth.uid(),
    reviewed_at = now(),
    updated_at = now()
  where id = p_candidate_id;

  return canonical_event_id;
end;
$$;

revoke all
on function public.admin_review_calendar_event_verification(uuid, boolean)
from public;

grant execute
on function public.admin_review_calendar_event_verification(uuid, boolean)
to authenticated;
