-- TenderFans Event Harvester: provider venue match candidates
--
-- Stores possible mappings between an existing TenderFans Spot
-- and an external provider venue.
--
-- This table does NOT create TenderFans Spots.
-- Approved mappings are promoted into venue_external_refs.

create table public.event_harvest_venue_matches (
  id uuid primary key default gen_random_uuid(),

  venue_id uuid not null
    references public.venues(id)
    on delete cascade,

  provider text not null,

  provider_place_id text not null,

  provider_venue_name text not null,

  provider_address text,
  provider_city text,
  provider_state_region text,
  provider_postal_code text,

  confidence_score numeric(5,4) not null
    check (
      confidence_score >= 0
      and confidence_score <= 1
    ),

  evidence jsonb not null default '{}'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb,

  status text not null default 'pending'
    check (
      status in (
        'pending',
        'approved',
        'rejected'
      )
    ),

  reviewed_by uuid
    references public.profiles(id)
    on delete set null,

  reviewed_at timestamptz,

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (
    venue_id,
    provider,
    provider_place_id
  )
);

create index event_harvest_venue_matches_review_idx
  on public.event_harvest_venue_matches (
    status,
    confidence_score desc,
    last_seen_at desc
  );

create index event_harvest_venue_matches_venue_idx
  on public.event_harvest_venue_matches (
    venue_id,
    provider
  );

create index event_harvest_venue_matches_provider_identity_idx
  on public.event_harvest_venue_matches (
    provider,
    provider_place_id
  );


-- ============================================================
-- UPSERT MATCH CANDIDATE
-- ============================================================

create or replace function public.upsert_event_harvest_venue_match(
  p_venue_id uuid,
  p_provider text,
  p_provider_place_id text,
  p_provider_venue_name text,
  p_provider_address text,
  p_provider_city text,
  p_provider_state_region text,
  p_provider_postal_code text,
  p_confidence_score numeric,
  p_evidence jsonb default '{}'::jsonb,
  p_raw_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_provider text;
  v_place_id text;
begin
  v_provider := lower(trim(p_provider));
  v_place_id := trim(p_provider_place_id);

  if v_provider is null or v_provider = '' then
    raise exception 'Provider is required';
  end if;

  if v_place_id is null or v_place_id = '' then
    raise exception 'Provider place ID is required';
  end if;

  if not exists (
    select 1
    from public.venues v
    where v.id = p_venue_id
      and v.status = 'active'
  ) then
    raise exception 'Active TenderFans venue not found';
  end if;

  insert into public.event_harvest_venue_matches (
    venue_id,
    provider,
    provider_place_id,
    provider_venue_name,
    provider_address,
    provider_city,
    provider_state_region,
    provider_postal_code,
    confidence_score,
    evidence,
    raw_payload
  )
  values (
    p_venue_id,
    v_provider,
    v_place_id,
    trim(p_provider_venue_name),
    nullif(trim(p_provider_address), ''),
    nullif(trim(p_provider_city), ''),
    nullif(trim(p_provider_state_region), ''),
    nullif(trim(p_provider_postal_code), ''),
    p_confidence_score,
    coalesce(p_evidence, '{}'::jsonb),
    coalesce(p_raw_payload, '{}'::jsonb)
  )
  on conflict (
    venue_id,
    provider,
    provider_place_id
  )
  do update set
    provider_venue_name =
      excluded.provider_venue_name,
    provider_address =
      excluded.provider_address,
    provider_city =
      excluded.provider_city,
    provider_state_region =
      excluded.provider_state_region,
    provider_postal_code =
      excluded.provider_postal_code,
    confidence_score =
      excluded.confidence_score,
    evidence =
      excluded.evidence,
    raw_payload =
      excluded.raw_payload,
    last_seen_at = now(),
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;


-- ============================================================
-- ADMIN REVIEW
-- ============================================================

create or replace function public.admin_review_event_harvest_venue_match(
  p_match_id uuid,
  p_approve boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match public.event_harvest_venue_matches%rowtype;
begin
  if auth.uid() is null or not exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  ) then
    raise exception 'Admin access required.';
  end if;

  select *
  into v_match
  from public.event_harvest_venue_matches
  where id = p_match_id
  for update;

  if not found then
    raise exception 'Venue match candidate not found';
  end if;

  if p_approve then
    perform public.set_venue_external_ref(
      v_match.venue_id,
      v_match.provider,
      v_match.provider_place_id,
      jsonb_build_object(
        'match_source', 'admin_review',
        'match_confidence',
          v_match.confidence_score,
        'match_evidence',
          v_match.evidence
      )
    );

    update public.event_harvest_venue_matches
    set
      status = 'approved',
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      updated_at = now()
    where id = p_match_id;
  else
    update public.event_harvest_venue_matches
    set
      status = 'rejected',
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      updated_at = now()
    where id = p_match_id;
  end if;
end;
$$;


-- ============================================================
-- SECURITY
-- ============================================================

alter table public.event_harvest_venue_matches
  enable row level security;

revoke all
on table public.event_harvest_venue_matches
from public, anon, authenticated;

grant select
on table public.event_harvest_venue_matches
to authenticated;

create policy
  "Admins can read harvest venue matches"
on public.event_harvest_venue_matches
for select
to authenticated
using (
  auth.uid() is not null
  and exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);


revoke all
on function public.upsert_event_harvest_venue_match(
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  numeric,
  jsonb,
  jsonb
)
from public;

grant execute
on function public.upsert_event_harvest_venue_match(
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  numeric,
  jsonb,
  jsonb
)
to service_role;


revoke all
on function public.admin_review_event_harvest_venue_match(
  uuid,
  boolean
)
from public;

grant execute
on function public.admin_review_event_harvest_venue_match(
  uuid,
  boolean
)
to authenticated;
