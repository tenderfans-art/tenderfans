-- TenderFans Event Harvester foundation
--
-- Adds:
--   * approved harvest sources
--   * external event candidate staging
--   * canonical event provenance
--   * suppression protection
--   * idempotent event-publication activity
--   * one canonical event publication primitive
--   * admin harvest review operations
--
-- This migration intentionally does NOT add:
--   * provider/API integrations
--   * scheduled harvesting
--   * geographic Fan subscriptions
--   * changes to normal Partner/Spot submission workflows


-- ============================================================
-- 1. HARVEST SOURCES
-- ============================================================

create table if not exists public.event_harvest_sources (
  id uuid primary key default gen_random_uuid(),

  provider text not null,
  source_type text not null,
  name text not null,

  source_url text,
  external_source_id text,

  is_enabled boolean not null default true,

  trust_level text not null default 'standard'
    check (
      trust_level in (
        'standard',
        'trusted'
      )
    ),

  config jsonb not null default '{}'::jsonb,

  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (provider, external_source_id)
);

create index if not exists event_harvest_sources_enabled_idx
  on public.event_harvest_sources (is_enabled, provider);

alter table public.event_harvest_sources
  enable row level security;


-- ============================================================
-- 2. HARVEST CANDIDATES
-- ============================================================

create table if not exists public.event_harvest_candidates (
  id uuid primary key default gen_random_uuid(),

  source_id uuid not null
    references public.event_harvest_sources(id)
    on delete cascade,

  external_event_id text,
  source_url text,

  raw_title text not null,
  raw_venue_name text,
  raw_address text,
  raw_description text,

  raw_starts_at text,
  raw_ends_at text,

  normalized_title text,

  starts_at timestamptz,
  ends_at timestamptz,

  venue_id uuid
    references public.venues(id)
    on delete set null,

  confidence_score numeric(5,4)
    check (
      confidence_score is null
      or (
        confidence_score >= 0
        and confidence_score <= 1
      )
    ),

  status text not null default 'discovered'
    check (
      status in (
        'discovered',
        'matched',
        'needs_review',
        'approved',
        'published',
        'ignored',
        'suppressed',
        'stale',
        'cancelled'
      )
    ),

  canonical_event_id uuid
    references public.events(id)
    on delete set null,

  raw_payload jsonb not null default '{}'::jsonb,

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_verified_at timestamptz,

  reviewed_by uuid
    references auth.users(id)
    on delete set null,

  reviewed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists
  event_harvest_candidates_external_unique
on public.event_harvest_candidates (
  source_id,
  external_event_id
)
where external_event_id is not null;

create index if not exists
  event_harvest_candidates_review_idx
on public.event_harvest_candidates (
  status,
  confidence_score desc,
  created_at
);

create index if not exists
  event_harvest_candidates_venue_idx
on public.event_harvest_candidates (
  venue_id,
  starts_at
)
where venue_id is not null;

create index if not exists
  event_harvest_candidates_event_idx
on public.event_harvest_candidates (
  canonical_event_id
)
where canonical_event_id is not null;

alter table public.event_harvest_candidates
  enable row level security;


-- ============================================================
-- 3. CANONICAL EVENT PROVENANCE
-- ============================================================

create table if not exists public.event_source_links (
  id uuid primary key default gen_random_uuid(),

  event_id uuid not null
    references public.events(id)
    on delete cascade,

  source_id uuid not null
    references public.event_harvest_sources(id)
    on delete cascade,

  candidate_id uuid
    references public.event_harvest_candidates(id)
    on delete set null,

  external_event_id text,
  source_url text,

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_verified_at timestamptz,

  owner_overridden boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists
  event_source_links_source_external_unique
on public.event_source_links (
  source_id,
  external_event_id
)
where external_event_id is not null;

create unique index if not exists
  event_source_links_candidate_unique
on public.event_source_links (candidate_id)
where candidate_id is not null;

create index if not exists
  event_source_links_event_idx
on public.event_source_links (event_id);

alter table public.event_source_links
  enable row level security;


-- ============================================================
-- 4. OWNER / ADMIN SUPPRESSION
-- ============================================================

create table if not exists public.event_harvest_suppressions (
  id uuid primary key default gen_random_uuid(),

  venue_id uuid not null
    references public.venues(id)
    on delete cascade,

  source_id uuid
    references public.event_harvest_sources(id)
    on delete cascade,

  external_event_id text,

  event_fingerprint text not null,

  reason text,

  suppressed_by uuid
    references auth.users(id)
    on delete set null,

  created_at timestamptz not null default now(),

  unique (
    venue_id,
    event_fingerprint
  )
);

create index if not exists
  event_harvest_suppressions_source_idx
on public.event_harvest_suppressions (
  source_id,
  external_event_id
)
where source_id is not null
  and external_event_id is not null;

alter table public.event_harvest_suppressions
  enable row level security;


-- ============================================================
-- 5. IDEMPOTENT CANONICAL PUBLICATION ACTIVITY
-- ============================================================

create unique index if not exists
  notification_events_event_publication_unique
on public.notification_events (
  event_type,
  source_kind,
  source_id
)
where event_type = 'spot.event_published'
  and source_kind = 'event'
  and source_id is not null;


-- ============================================================
-- 6. CANONICAL EVENT PUBLISHER
-- ============================================================

create or replace function public.publish_event(
  p_event_id uuid,
  p_reviewed_by uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  event_venue_id uuid;
  event_status text;
begin
  select
    e.venue_id,
    e.status
  into
    event_venue_id,
    event_status
  from public.events e
  where e.id = p_event_id
  for update;

  if event_venue_id is null then
    raise exception 'Event not found';
  end if;

  /*
   * Publication is intentionally idempotent.
   *
   * If already published, do not manufacture another status
   * transition or another publication activity.
   */
  if event_status <> 'published' then
    update public.events
    set
      venue_approval_status = 'approved',
      admin_approval_status = 'approved',
      status = 'published',
      reviewed_by = coalesce(
        p_reviewed_by,
        reviewed_by
      ),
      reviewed_at = case
        when p_reviewed_by is not null
          then now()
        else reviewed_at
      end,
      updated_at = now()
    where id = p_event_id;
  end if;

  /*
   * This is the canonical Follow activity for an Event.
   * The unique partial index makes retries harmless.
   */
  insert into public.notification_events (
    entity_kind,
    venue_id,
    event_type,
    source_kind,
    source_id,
    metadata
  )
  values (
    'venue',
    event_venue_id,
    'spot.event_published',
    'event',
    p_event_id,
    jsonb_build_object(
      'event_id',
      p_event_id
    )
  )
  on conflict do nothing;
end;
$$;


-- ============================================================
-- 7. PRESERVE EXISTING ADMIN REVIEW CONTRACT
-- ============================================================

create or replace function public.admin_review_event(
  p_event_id uuid,
  p_approve boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  event_venue_id uuid;
begin
  if not exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  ) then
    raise exception 'Admin access required';
  end if;

  select e.venue_id
  into event_venue_id
  from public.events e
  where e.id = p_event_id
    and e.admin_approval_status = 'pending';

  if event_venue_id is null then
    raise exception 'Pending event not found';
  end if;

  if p_approve then
    perform public.publish_event(
      p_event_id,
      auth.uid()
    );
  else
    update public.events
    set
      admin_approval_status = 'denied',
      status = 'draft',
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      updated_at = now()
    where id = p_event_id;
  end if;
end;
$$;


-- ============================================================
-- 8. ADMIN HARVEST REVIEW
-- ============================================================

create or replace function public.admin_list_harvest_candidates()
returns table (
  id uuid,
  source_id uuid,
  source_name text,
  provider text,
  external_event_id text,
  source_url text,
  raw_title text,
  raw_venue_name text,
  raw_address text,
  starts_at timestamptz,
  ends_at timestamptz,
  venue_id uuid,
  venue_name text,
  confidence_score numeric,
  status text,
  canonical_event_id uuid,
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
    s.provider,
    c.external_event_id,
    c.source_url,
    c.raw_title,
    c.raw_venue_name,
    c.raw_address,
    c.starts_at,
    c.ends_at,
    c.venue_id,
    v.name,
    c.confidence_score,
    c.status,
    c.canonical_event_id,
    c.last_seen_at,
    c.created_at
  from public.event_harvest_candidates c
  join public.event_harvest_sources s
    on s.id = c.source_id
  left join public.venues v
    on v.id = c.venue_id
  where c.status in (
    'matched',
    'needs_review'
  )
  order by
    c.confidence_score desc nulls last,
    c.created_at asc;
end;
$$;


create or replace function public.graduate_harvest_candidate(
  p_candidate_id uuid,
  p_reviewed_by uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate_record
    public.event_harvest_candidates%rowtype;

  created_event_id uuid;
begin
  select *
  into candidate_record
  from public.event_harvest_candidates
  where id = p_candidate_id
  for update;

  if not found then
    raise exception 'Harvest candidate not found';
  end if;

  if candidate_record.status = 'published'
     and candidate_record.canonical_event_id is not null then
    perform public.publish_event(
      candidate_record.canonical_event_id,
      p_reviewed_by
    );

    return candidate_record.canonical_event_id;
  end if;

  if candidate_record.status not in (
    'matched',
    'needs_review',
    'approved'
  ) then
    raise exception
      'Harvest candidate cannot be published from status %',
      candidate_record.status;
  end if;

  if candidate_record.venue_id is null then
    raise exception
      'Harvest candidate is not matched to a Spot';
  end if;

  if candidate_record.starts_at is null then
    raise exception
      'Harvest candidate has no normalized start time';
  end if;

  if candidate_record.canonical_event_id is not null then
    created_event_id :=
      candidate_record.canonical_event_id;
  else
    insert into public.events (
      venue_id,
      title,
      description,
      starts_at,
      ends_at,
      status,
      venue_approval_status,
      admin_approval_status,
      reviewed_by,
      reviewed_at,
      updated_at
    )
    values (
      candidate_record.venue_id,
      candidate_record.raw_title,
      candidate_record.raw_description,
      candidate_record.starts_at,
      candidate_record.ends_at,
      'draft',
      'approved',
      'pending',
      p_reviewed_by,
      case
        when p_reviewed_by is not null
          then now()
        else null
      end,
      now()
    )
    returning id
    into created_event_id;

    update public.event_harvest_candidates
    set
      canonical_event_id = created_event_id,
      status = 'approved',
      reviewed_by = coalesce(
        p_reviewed_by,
        reviewed_by
      ),
      reviewed_at = case
        when p_reviewed_by is not null
          then now()
        else reviewed_at
      end,
      updated_at = now()
    where id = p_candidate_id;
  end if;

  insert into public.event_source_links (
    event_id,
    source_id,
    candidate_id,
    external_event_id,
    source_url,
    first_seen_at,
    last_seen_at,
    last_verified_at
  )
  values (
    created_event_id,
    candidate_record.source_id,
    p_candidate_id,
    candidate_record.external_event_id,
    candidate_record.source_url,
    candidate_record.first_seen_at,
    candidate_record.last_seen_at,
    candidate_record.last_verified_at
  )
  on conflict do nothing;

  perform public.publish_event(
    created_event_id,
    p_reviewed_by
  );

  update public.event_harvest_candidates
  set
    canonical_event_id = created_event_id,
    status = 'published',
    reviewed_by = coalesce(
      p_reviewed_by,
      reviewed_by
    ),
    reviewed_at = case
      when p_reviewed_by is not null
        then now()
      else reviewed_at
    end,
    updated_at = now()
  where id = p_candidate_id;

  return created_event_id;
end;
$$;


create or replace function public.admin_review_harvest_candidate(
  p_candidate_id uuid,
  p_approve boolean
)
returns uuid
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

  if not p_approve then
    update public.event_harvest_candidates
    set
      status = 'ignored',
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      updated_at = now()
    where id = p_candidate_id
      and status in (
        'matched',
        'needs_review'
      );

    if not found then
      raise exception 'Harvest candidate not found';
    end if;

    return null;
  end if;

  return public.graduate_harvest_candidate(
    p_candidate_id,
    auth.uid()
  );
end;
$$;

-- ============================================================
-- 9. SECURITY / EXECUTION
-- ============================================================

/*
 * Harvester tables are intentionally not given public RLS
 * policies. Browser clients cannot directly read/write the
 * harvesting pipeline.
 *
 * Admin access occurs through SECURITY DEFINER RPCs.
 * Future server-side harvest jobs use the server secret.
 */

revoke all on function public.publish_event(uuid, uuid)
from public;

revoke all on function public.graduate_harvest_candidate(uuid, uuid)
from public;

revoke all on function public.admin_list_harvest_candidates()
from public;

revoke all on function public.admin_review_harvest_candidate(uuid, boolean)
from public;

grant execute on function public.admin_review_event(uuid, boolean)
to authenticated;

grant execute on function public.admin_list_harvest_candidates()
to authenticated;

grant execute on function public.admin_review_harvest_candidate(uuid, boolean)
to authenticated;
