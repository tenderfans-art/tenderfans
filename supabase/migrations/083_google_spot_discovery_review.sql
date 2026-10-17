-- Durable Google Places discovery decisions for the Event Harvester.
-- These records are separate from event-level attribution decisions.

create table public.event_harvest_google_spot_reviews (
  place_id text primary key,
  place_data jsonb not null,
  confidence_score double precision,
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  venue_id uuid references public.venues(id),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id)
);

create index event_harvest_google_spot_reviews_status_idx
  on public.event_harvest_google_spot_reviews(status);

alter table public.event_harvest_google_spot_reviews
  enable row level security;

revoke all on public.event_harvest_google_spot_reviews
  from public, anon, authenticated;

grant select, insert, update
  on public.event_harvest_google_spot_reviews
  to service_role;

create function public.record_event_harvest_google_spot(
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
    evidence = excluded.evidence,
    last_seen_at = now();

  select status into v_status
  from public.event_harvest_google_spot_reviews
  where place_id = p_place_id;

  return v_status;
end;
$$;

create function public.admin_list_google_spot_reviews()
returns setof public.event_harvest_google_spot_reviews
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.platform_admins
    where user_id = auth.uid()
  ) then
    raise exception 'Admin access required';
  end if;

  return query
  select *
  from public.event_harvest_google_spot_reviews
  where status = 'pending'
  order by first_seen_at;
end;
$$;

create function public.admin_review_google_spot(
  p_place_id text,
  p_approve boolean,
  p_venue_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_review public.event_harvest_google_spot_reviews%rowtype;
  v_venue_id uuid;
begin
  if auth.uid() is null or not exists (
    select 1 from public.platform_admins
    where user_id = auth.uid()
  ) then
    raise exception 'Admin access required';
  end if;

  select * into v_review
  from public.event_harvest_google_spot_reviews
  where place_id = p_place_id
  for update;

  if not found then
    raise exception 'Google Spot review not found';
  end if;

  if v_review.status <> 'pending' then
    raise exception 'This Google Spot was already reviewed';
  end if;

  if p_approve then
    if p_venue_id is not null then
      if not exists (
        select 1 from public.venues
        where id = p_venue_id and status = 'active'
      ) then
        raise exception 'Selected Spot is not active';
      end if;

      perform public.set_venue_external_ref(
        p_venue_id,
        'google_places',
        p_place_id,
        jsonb_build_object(
          'match_source', 'admin_google_spot_review'
        )
      );
      v_venue_id := p_venue_id;
    else
      v_venue_id := public.upsert_google_venue(
        p_place_id,
        v_review.place_data->>'name',
        coalesce(v_review.place_data->>'streetAddress', ''),
        coalesce(v_review.place_data->>'city', ''),
        coalesce(v_review.place_data->>'stateRegion', ''),
        coalesce(v_review.place_data->>'postalCode', ''),
        (v_review.place_data->>'latitude')::double precision,
        (v_review.place_data->>'longitude')::double precision,
        coalesce(v_review.place_data->>'publicPhone', ''),
        coalesce(v_review.place_data->>'websiteUrl', ''),
        coalesce(v_review.place_data->'regularHours', '[]'::jsonb)
      );
    end if;
  end if;

  update public.event_harvest_google_spot_reviews
  set
    status = case when p_approve then 'approved' else 'rejected' end,
    venue_id = v_venue_id,
    reviewed_by = auth.uid(),
    reviewed_at = now()
  where place_id = p_place_id;
end;
$$;

revoke all on function public.record_event_harvest_google_spot(
  text, jsonb, double precision, jsonb
) from public, anon, authenticated;

grant execute on function public.record_event_harvest_google_spot(
  text, jsonb, double precision, jsonb
) to service_role;

revoke all on function public.admin_list_google_spot_reviews()
  from public, anon, authenticated;

grant execute on function public.admin_list_google_spot_reviews()
  to authenticated;

revoke all on function public.admin_review_google_spot(
  text, boolean, uuid
) from public, anon, authenticated;

grant execute on function public.admin_review_google_spot(
  text, boolean, uuid
) to authenticated;



-- Atomic harvester registration. Locks the discovery decision before
-- creating or resolving a Spot, preventing rejected Place IDs from
-- being automatically registered by a concurrent harvester.

create function public.register_event_harvest_google_spot(
  p_place_id text,
  p_place_data jsonb,
  p_confidence_score double precision,
  p_evidence jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_review public.event_harvest_google_spot_reviews%rowtype;
  v_venue_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  perform public.record_event_harvest_google_spot(
    p_place_id, p_place_data, p_confidence_score, p_evidence
  );

  select * into v_review
  from public.event_harvest_google_spot_reviews
  where place_id = p_place_id
  for update;

  if v_review.status = 'rejected' then
    return null;
  end if;

  if v_review.status = 'approved' and v_review.venue_id is not null then
    return v_review.venue_id;
  end if;

  -- A previously pending manual-review candidate must not
  -- be auto-approved on a later higher-confidence discovery.
  if v_review.status = 'pending'
     and coalesce(v_review.evidence->>'reviewOnly', 'false') = 'true' then
    return null;
  end if;

  v_venue_id := public.upsert_google_venue(
    p_place_id,
    p_place_data->>'name',
    coalesce(p_place_data->>'streetAddress', ''),
    coalesce(p_place_data->>'city', ''),
    coalesce(p_place_data->>'stateRegion', ''),
    coalesce(p_place_data->>'postalCode', ''),
    (p_place_data->>'latitude')::double precision,
    (p_place_data->>'longitude')::double precision,
    coalesce(p_place_data->>'publicPhone', ''),
    coalesce(p_place_data->>'websiteUrl', ''),
    coalesce(p_place_data->'regularHours', '[]'::jsonb)
  );

  update public.event_harvest_google_spot_reviews
  set
    status = 'approved',
    venue_id = v_venue_id,
    reviewed_at = coalesce(reviewed_at, now())
  where place_id = p_place_id;

  return v_venue_id;
end;
$$;

revoke all on function public.register_event_harvest_google_spot(
  text, jsonb, double precision, jsonb
) from public, anon, authenticated;

grant execute on function public.register_event_harvest_google_spot(
  text, jsonb, double precision, jsonb
) to service_role;


-- Return only explicitly approved Google Spot associations.
-- Rejected and pending candidates remain unresolved.
create function public.resolved_event_harvest_google_spot(
  p_place_id text,
  p_place_data jsonb,
  p_confidence_score double precision,
  p_evidence jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_venue_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role required';
  end if;

  perform public.record_event_harvest_google_spot(
    p_place_id, p_place_data, p_confidence_score, p_evidence
  );

  select venue_id into v_venue_id
  from public.event_harvest_google_spot_reviews
  where place_id = p_place_id
    and status = 'approved';

  return v_venue_id;
end;
$$;

revoke all on function public.resolved_event_harvest_google_spot(
  text, jsonb, double precision, jsonb
) from public, anon, authenticated;

grant execute on function public.resolved_event_harvest_google_spot(
  text, jsonb, double precision, jsonb
) to service_role;
