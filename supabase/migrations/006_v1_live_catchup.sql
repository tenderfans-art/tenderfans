-- TenderFans V1 live database catch-up
-- Captures schema changes made during V1 development that were applied
-- directly to the live Supabase project after migrations 001-005.

-- ============================================================
-- ENTITY CLAIMS
-- ============================================================

alter table public.entity_claims
  add column if not exists claimant_name text,
  add column if not exists claimed_hire_date date,
  add column if not exists claimant_role text,
  add column if not exists business_email text,
  add column if not exists role_start_date date;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'entity_claims_claimant_name_length'
      and conrelid = 'public.entity_claims'::regclass
  ) then
    alter table public.entity_claims
      add constraint entity_claims_claimant_name_length
      check (
        claimant_name is null
        or (
          char_length(trim(claimant_name)) >= 2
          and char_length(trim(claimant_name)) <= 100
        )
      );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'entity_claims_claimant_role_check'
      and conrelid = 'public.entity_claims'::regclass
  ) then
    alter table public.entity_claims
      add constraint entity_claims_claimant_role_check
      check (
        claimant_role is null
        or claimant_role in (
          'owner',
          'general_manager',
          'bar_manager',
          'assistant_manager',
          'marketing_operations',
          'other'
        )
      );
  end if;
end
$$;


-- ============================================================
-- BARTENDER VENUES
-- ============================================================

alter table public.bartender_venues
  add column if not exists relationship_type text not null default 'regular',
  add column if not exists is_primary boolean not null default false;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'bartender_venues_relationship_type_check'
      and conrelid = 'public.bartender_venues'::regclass
  ) then
    alter table public.bartender_venues
      add constraint bartender_venues_relationship_type_check
      check (
        relationship_type in (
          'regular',
          'seasonal',
          'event',
          'guest',
          'other'
        )
      );
  end if;
end
$$;

create unique index if not exists bartender_venues_one_active_primary
on public.bartender_venues (bartender_id)
where is_current = true
  and is_primary = true;


-- ============================================================
-- BARTENDER VENUE REQUESTS
-- ============================================================

create table if not exists public.bartender_venue_requests (
  id uuid primary key default gen_random_uuid(),
  bartender_id uuid not null references public.bartenders(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  requested_by_user_id uuid not null references public.profiles(id) on delete cascade,
  request_type text not null default 'add',
  relationship_type text not null default 'regular',
  requested_start_date date,
  requested_end_date date,
  make_primary boolean not null default false,
  status text not null default 'pending',
  reviewed_by_user_id uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),

  constraint bartender_venue_requests_type_check
    check (request_type in ('add','end')),

  constraint bartender_venue_requests_relationship_check
    check (
      relationship_type in (
        'regular',
        'seasonal',
        'event',
        'guest',
        'other'
      )
    ),

  constraint bartender_venue_requests_status_check
    check (
      status in (
        'pending',
        'approved',
        'denied',
        'cancelled'
      )
    )
);

create unique index if not exists bartender_venue_requests_one_pending_change
on public.bartender_venue_requests (bartender_id, venue_id, request_type)
where status = 'pending';


-- ============================================================
-- BARTENDER VENUE REQUEST RPCs
-- ============================================================

create or replace function public.admin_pending_bartender_venue_requests()
returns table (
  id uuid,
  bartender_id uuid,
  bartender_name text,
  venue_id uuid,
  venue_name text,
  request_type text,
  relationship_type text,
  requested_start_date date,
  requested_end_date date,
  make_primary boolean,
  requested_by_user_id uuid,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    r.id,
    r.bartender_id,
    b.display_name as bartender_name,
    r.venue_id,
    v.name as venue_name,
    r.request_type,
    r.relationship_type,
    r.requested_start_date,
    r.requested_end_date,
    r.make_primary,
    r.requested_by_user_id,
    r.created_at
  from public.bartender_venue_requests r
  join public.bartenders b
    on b.id = r.bartender_id
  join public.venues v
    on v.id = r.venue_id
  where r.status = 'pending'
    and exists (
      select 1
      from public.platform_admins pa
      where pa.user_id = auth.uid()
    )
  order by r.created_at asc;
$$;


create or replace function public.review_bartender_venue_request(
  p_request_id uuid,
  p_approve boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  req public.bartender_venue_requests%rowtype;
  existing_relationship_id uuid;
  replacement_primary_id uuid;
begin
  select *
  into req
  from public.bartender_venue_requests
  where id = p_request_id
  for update;

  if req.id is null then
    raise exception 'Request not found.';
  end if;

  if req.status <> 'pending' then
    raise exception 'This request has already been reviewed.';
  end if;

  if not exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
  and not exists (
    select 1
    from public.venue_permissions vp
    where vp.venue_id = req.venue_id
      and vp.user_id = auth.uid()
      and vp.can_edit = true
  ) then
    raise exception 'You do not have permission to review this request.';
  end if;

  if p_approve then

    if req.request_type = 'add' then

      if req.make_primary then
        update public.bartender_venues
        set is_primary = false
        where bartender_id = req.bartender_id
          and is_current = true;
      end if;

      select id
      into existing_relationship_id
      from public.bartender_venues
      where bartender_id = req.bartender_id
        and venue_id = req.venue_id
        and is_current = true
      order by started_at desc nulls last
      limit 1;

      if existing_relationship_id is not null then

        update public.bartender_venues
        set
          relationship_type = req.relationship_type,
          started_at = coalesce(
            req.requested_start_date,
            started_at
          ),
          ended_at = req.requested_end_date,
          is_current = true,
          is_primary =
            case
              when req.make_primary then true
              else is_primary
            end
        where id = existing_relationship_id;

      else

        insert into public.bartender_venues (
          bartender_id,
          venue_id,
          is_current,
          started_at,
          ended_at,
          relationship_type,
          is_primary
        )
        values (
          req.bartender_id,
          req.venue_id,
          true,
          req.requested_start_date,
          req.requested_end_date,
          req.relationship_type,
          req.make_primary
        );

      end if;

      if not exists (
        select 1
        from public.bartender_venues
        where bartender_id = req.bartender_id
          and is_current = true
          and is_primary = true
      ) then

        update public.bartender_venues
        set is_primary = true
        where id = (
          select id
          from public.bartender_venues
          where bartender_id = req.bartender_id
            and venue_id = req.venue_id
            and is_current = true
          order by started_at desc nulls last
          limit 1
        );

      end if;

    elsif req.request_type = 'end' then

      update public.bartender_venues
      set
        is_current = false,
        is_primary = false,
        ended_at = coalesce(
          req.requested_end_date,
          current_date
        )
      where bartender_id = req.bartender_id
        and venue_id = req.venue_id
        and is_current = true;

      if not exists (
        select 1
        from public.bartender_venues
        where bartender_id = req.bartender_id
          and is_current = true
          and is_primary = true
      ) then

        select id
        into replacement_primary_id
        from public.bartender_venues
        where bartender_id = req.bartender_id
          and is_current = true
        order by started_at desc nulls last, id
        limit 1;

        if replacement_primary_id is not null then
          update public.bartender_venues
          set is_primary = true
          where id = replacement_primary_id;
        end if;

      end if;

    end if;

    update public.bartender_venue_requests
    set
      status = 'approved',
      reviewed_by_user_id = auth.uid(),
      reviewed_at = now()
    where id = req.id;

  else

    update public.bartender_venue_requests
    set
      status = 'denied',
      reviewed_by_user_id = auth.uid(),
      reviewed_at = now()
    where id = req.id;

  end if;
end;
$$;


-- ============================================================
-- BARTENDER VENUE REQUEST RLS
-- ============================================================

alter table public.bartender_venue_requests enable row level security;

drop policy if exists "spot managers can read requests for their spot"
on public.bartender_venue_requests;

create policy "spot managers can read requests for their spot"
on public.bartender_venue_requests
for select
to authenticated
using (
  exists (
    select 1
    from public.venue_permissions vp
    where vp.venue_id = bartender_venue_requests.venue_id
      and vp.user_id = auth.uid()
      and vp.can_edit = true
  )
);


drop policy if exists "tenders can create own spot requests"
on public.bartender_venue_requests;

create policy "tenders can create own spot requests"
on public.bartender_venue_requests
for insert
to authenticated
with check (
  requested_by_user_id = auth.uid()
  and exists (
    select 1
    from public.bartender_permissions bp
    where bp.bartender_id = bartender_venue_requests.bartender_id
      and bp.user_id = auth.uid()
      and bp.can_edit = true
  )
);


drop policy if exists "tenders can read own spot requests"
on public.bartender_venue_requests;

create policy "tenders can read own spot requests"
on public.bartender_venue_requests
for select
to authenticated
using (
  requested_by_user_id = auth.uid()
);


-- ============================================================
-- PERMISSION SELF-READ POLICIES
-- ============================================================

drop policy if exists "users can read own bartender permissions"
on public.bartender_permissions;

create policy "users can read own bartender permissions"
on public.bartender_permissions
for select
to authenticated
using (
  user_id = auth.uid()
);


drop policy if exists "users can read own venue permissions"
on public.venue_permissions;

create policy "users can read own venue permissions"
on public.venue_permissions
for select
to authenticated
using (
  user_id = auth.uid()
);


-- ============================================================
-- MEDIA ASSETS CATCH-UP
-- ============================================================

alter table public.media_assets
  add column if not exists media_type text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'media_assets_media_type_check'
      and conrelid = 'public.media_assets'::regclass
  ) then
    alter table public.media_assets
      add constraint media_assets_media_type_check
      check (
        media_type is null
        or media_type in ('menu', 'special', 'photo')
      );
  end if;
end
$$;


-- ============================================================
-- SPOT-MEDIA STORAGE
-- ============================================================

insert into storage.buckets (
  id,
  name,
  public
)
values (
  'spot-media',
  'spot-media',
  true
)
on conflict (id) do update
set
  name = excluded.name,
  public = excluded.public;


drop policy if exists "spot managers upload spot media"
on storage.objects;

create policy "spot managers upload spot media"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'spot-media'
  and exists (
    select 1
    from public.venue_permissions vp
    where vp.user_id = auth.uid()
      and vp.can_manage_media = true
      and vp.venue_id::text = (storage.foldername(name))[1]
  )
);


drop policy if exists "spot managers delete spot media"
on storage.objects;

create policy "spot managers delete spot media"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'spot-media'
  and exists (
    select 1
    from public.venue_permissions vp
    where vp.user_id = auth.uid()
      and vp.can_manage_media = true
      and vp.venue_id::text = (storage.foldername(name))[1]
  )
);


drop policy if exists "tender owners upload media"
on storage.objects;

create policy "tender owners upload media"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'spot-media'
  and exists (
    select 1
    from public.bartender_permissions bp
    where bp.user_id = auth.uid()
      and bp.can_manage_media = true
      and bp.bartender_id::text = (storage.foldername(name))[1]
  )
);


drop policy if exists "tender owners delete media"
on storage.objects;

create policy "tender owners delete media"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'spot-media'
  and exists (
    select 1
    from public.bartender_permissions bp
    where bp.user_id = auth.uid()
      and bp.can_manage_media = true
      and bp.bartender_id::text = (storage.foldername(name))[1]
  )
);


-- ============================================================
-- ADMIN CLAIM FUNCTIONS — LIVE V1 DEFINITIONS
-- ============================================================

create or replace function public.admin_pending_claim_details()
returns table(
  id uuid,
  entity_kind public.entity_kind,
  status public.claim_status,
  created_at timestamptz,
  bartender_id uuid,
  venue_id uuid,
  claimant_user_id uuid,
  claimant_name text,
  claimant_username text,
  claimant_email text,
  claimed_name text,
  verifying_spot_name text,
  claimed_hire_date date,
  claimant_role text,
  business_email text,
  role_start_date date
)
language plpgsql
security definer
set search_path to 'public', 'auth'
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  ) then
    raise exception 'Admin access required';
  end if;

  return query
  select
    ec.id,
    ec.entity_kind,
    ec.status,
    ec.created_at,
    ec.bartender_id,
    ec.venue_id,
    ec.claimant_user_id,
    ec.claimant_name,
    p.username as claimant_username,
    u.email::text as claimant_email,

    case
      when ec.entity_kind = 'bartender' then b.display_name
      when ec.entity_kind = 'venue' then v.name
      else null
    end as claimed_name,

    vv.name as verifying_spot_name,
    ec.claimed_hire_date,
    ec.claimant_role,
    ec.business_email,
    ec.role_start_date

  from public.entity_claims ec

  join public.profiles p
    on p.id = ec.claimant_user_id

  join auth.users u
    on u.id = ec.claimant_user_id

  left join public.bartenders b
    on b.id = ec.bartender_id

  left join public.venues v
    on v.id = ec.venue_id

  left join public.venues vv
    on vv.id = ec.verifying_venue_id

  where ec.status = 'pending'
  order by ec.created_at asc;
end;
$$;


create or replace function public.admin_review_claim(
  p_claim_id uuid,
  p_approve boolean
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_claim public.entity_claims%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not exists (
    select 1
    from public.platform_admins
    where user_id = auth.uid()
  ) then
    raise exception 'Admin access required';
  end if;

  select *
  into v_claim
  from public.entity_claims
  where id = p_claim_id
  for update;

  if not found then
    raise exception 'Claim not found';
  end if;

  if v_claim.status <> 'pending' then
    raise exception 'Claim has already been reviewed';
  end if;

  if p_approve then
    update public.entity_claims
    set
      status = 'approved',
      verification_method = 'tenderfans_admin',
      verification_notes = null,
      reviewed_at = now()
    where id = p_claim_id;

    if v_claim.entity_kind = 'bartender' then
      insert into public.bartender_permissions (
        bartender_id,
        user_id,
        can_edit,
        can_manage_media
      )
      values (
        v_claim.bartender_id,
        v_claim.claimant_user_id,
        true,
        true
      )
      on conflict (bartender_id, user_id)
      do update set
        can_edit = true,
        can_manage_media = true;

    elsif v_claim.entity_kind = 'venue' then
      insert into public.venue_permissions (
        venue_id,
        user_id,
        role,
        can_edit,
        can_manage_media,
        can_manage_marketing
      )
      values (
        v_claim.venue_id,
        v_claim.claimant_user_id,
        'owner',
        true,
        true,
        true
      )
      on conflict (venue_id, user_id)
      do update set
        role = 'owner',
        can_edit = true,
        can_manage_media = true,
        can_manage_marketing = true;
    end if;

  else
    update public.entity_claims
    set
      status = 'rejected',
      verification_method = 'tenderfans_admin',
      verification_notes = null,
      reviewed_at = now()
    where id = p_claim_id;
  end if;
end;
$$;


-- ============================================================
-- GOOGLE VENUE UPSERT FUNCTIONS
-- ============================================================

create or replace function public.upsert_google_venue(
  p_place_id text,
  p_name text,
  p_street_address text,
  p_city text,
  p_state_region text,
  p_postal_code text,
  p_latitude double precision,
  p_longitude double precision
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_venue_id uuid;
  v_slug text;
begin
  select venue_id
  into v_venue_id
  from public.venue_external_refs
  where provider = 'google_places'
    and provider_place_id = p_place_id;

  if v_venue_id is not null then
    return v_venue_id;
  end if;

  v_slug := regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g');
  v_slug := trim(both '-' from v_slug) || '-' || substr(gen_random_uuid()::text, 1, 8);

  insert into public.venues (
    slug,
    name,
    street_address,
    city,
    state_region,
    postal_code,
    latitude,
    longitude
  )
  values (
    v_slug,
    p_name,
    p_street_address,
    p_city,
    p_state_region,
    p_postal_code,
    p_latitude,
    p_longitude
  )
  returning id into v_venue_id;

  insert into public.venue_external_refs (
    venue_id,
    provider,
    provider_place_id
  )
  values (
    v_venue_id,
    'google_places',
    p_place_id
  );

  return v_venue_id;
end;
$$;


create or replace function public.upsert_google_venue(
  p_place_id text,
  p_name text,
  p_street_address text,
  p_city text,
  p_state_region text,
  p_postal_code text,
  p_latitude double precision,
  p_longitude double precision,
  p_public_phone text,
  p_website_url text,
  p_regular_hours jsonb
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_venue_id uuid;
begin
  v_venue_id := public.upsert_google_venue(
    p_place_id,
    p_name,
    p_street_address,
    p_city,
    p_state_region,
    p_postal_code,
    p_latitude,
    p_longitude
  );

  update public.venues
  set
    public_phone = nullif(p_public_phone, ''),
    website_url = nullif(p_website_url, ''),
    regular_hours = coalesce(p_regular_hours, '[]'::jsonb)
  where id = v_venue_id;

  return v_venue_id;
end;
$$;


-- ============================================================
-- SPOT CLAIM VALIDATION
-- ============================================================

create or replace function public.validate_spot_claim()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'auth'
as $$
declare
  account_email text;
begin

  -- These requirements apply only to Spot claims.
  if new.entity_kind = 'venue' then

    if new.claimant_name is null
       or char_length(trim(new.claimant_name)) < 2 then
      raise exception 'Claimant name is required for Spot claims';
    end if;

    if new.claimant_role is null
       or trim(new.claimant_role) = '' then
      raise exception 'Role is required for Spot claims';
    end if;

    if new.business_email is null
       or trim(new.business_email) = '' then
      raise exception 'Business email is required for Spot claims';
    end if;

    if new.role_start_date is null then
      raise exception 'Role start date is required for Spot claims';
    end if;

    select u.email
    into account_email
    from auth.users u
    where u.id = new.claimant_user_id;

    if account_email is null then
      raise exception 'Claimant account email could not be verified';
    end if;

    if lower(trim(new.business_email)) =
       lower(trim(account_email)) then
      raise exception
        'Business email must be different from your TenderFans account email';
    end if;

  end if;

  return new;
end;
$$;


drop trigger if exists validate_spot_claim_insert_trigger
on public.entity_claims;

create trigger validate_spot_claim_insert_trigger
before insert
on public.entity_claims
for each row
execute function public.validate_spot_claim();


drop trigger if exists validate_spot_claim_update_trigger
on public.entity_claims;

create trigger validate_spot_claim_update_trigger
before update of
  claimant_name,
  claimant_role,
  business_email,
  role_start_date,
  claimant_user_id,
  entity_kind
on public.entity_claims
for each row
execute function public.validate_spot_claim();


-- ============================================================
-- CREATE TENDER AT SPOT
-- ============================================================

create or replace function public.create_bartender_at_venue(
  p_display_name text,
  p_venue_id uuid
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  new_bartender_id uuid;
  new_slug text;
begin
  if trim(p_display_name) = '' then
    raise exception 'Bartender name is required';
  end if;

  if not exists (
    select 1
    from public.venues
    where id = p_venue_id
      and status = 'active'
  ) then
    raise exception 'Venue not found';
  end if;

  new_slug :=
    regexp_replace(
      lower(trim(p_display_name)),
      '[^a-z0-9]+',
      '-',
      'g'
    )
    || '-' ||
    substr(gen_random_uuid()::text, 1, 6);

  insert into public.bartenders (
    display_name,
    slug,
    status
  )
  values (
    trim(p_display_name),
    new_slug,
    'active'
  )
  returning id into new_bartender_id;

  insert into public.bartender_venues (
    bartender_id,
    venue_id,
    is_current
  )
  values (
    new_bartender_id,
    p_venue_id,
    true
  );

  return new_bartender_id;
end;
$$;


-- ============================================================
-- CREATE SHOUTOUT
-- ============================================================

create or replace function public.create_shoutout(
  p_bartender_id uuid,
  p_venue_id uuid,
  p_voice_name text,
  p_traits text[]
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  new_shoutout_id uuid;
  selected_voice_id smallint;
  current_user_id uuid;
begin
  select id
  into selected_voice_id
  from public.voices
  where name = p_voice_name
    and active = true
  limit 1;

  if auth.uid() is not null
     and exists (
       select 1
       from public.profiles
       where id = auth.uid()
     )
  then
    current_user_id := auth.uid();
  else
    current_user_id := null;
  end if;

  insert into public.shoutouts (
    user_id,
    bartender_id,
    venue_id,
    voice_id,
    status
  )
  values (
    current_user_id,
    p_bartender_id,
    p_venue_id,
    selected_voice_id,
    'published'
  )
  returning id into new_shoutout_id;

  insert into public.shoutout_traits (
    shoutout_id,
    trait_id
  )
  select
    new_shoutout_id,
    t.id
  from public.traits t
  where t.label = any(p_traits)
    and t.audience = 'bartender'
    and t.active = true;

  return new_shoutout_id;
end;
$$;


-- ============================================================
-- MEDIA ASSETS RLS CATCH-UP
-- ============================================================

drop policy if exists "tender owners media delete"
on public.media_assets;

create policy "tender owners media delete"
on public.media_assets
for delete
to authenticated
using (
  entity_kind = 'bartender'::public.entity_kind
  and exists (
    select 1
    from public.bartender_permissions bp
    where bp.bartender_id = media_assets.bartender_id
      and bp.user_id = auth.uid()
      and bp.can_manage_media = true
  )
);

drop policy if exists "venue manager media delete"
on public.media_assets;

create policy "venue manager media delete"
on public.media_assets
for delete
to authenticated
using (
  entity_kind = 'venue'::public.entity_kind
  and exists (
    select 1
    from public.venue_permissions p
    where p.venue_id = media_assets.venue_id
      and p.user_id = auth.uid()
      and p.can_manage_media = true
  )
);

drop policy if exists "venue manager media read"
on public.media_assets;

create policy "venue manager media read"
on public.media_assets
for select
to authenticated
using (
  entity_kind = 'venue'::public.entity_kind
  and exists (
    select 1
    from public.venue_permissions p
    where p.venue_id = media_assets.venue_id
      and p.user_id = auth.uid()
      and p.can_manage_media = true
  )
);


-- ============================================================
-- TENDER PROFILE UPDATE RLS
-- ============================================================

drop policy if exists "tender owners can update own profile"
on public.bartenders;

create policy "tender owners can update own profile"
on public.bartenders
for update
to authenticated
using (
  exists (
    select 1
    from public.bartender_permissions bp
    where bp.bartender_id = bartenders.id
      and bp.user_id = auth.uid()
      and bp.can_edit = true
  )
)
with check (
  exists (
    select 1
    from public.bartender_permissions bp
    where bp.bartender_id = bartenders.id
      and bp.user_id = auth.uid()
      and bp.can_edit = true
  )
);
