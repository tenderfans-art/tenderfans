-- ============================================================
-- TenderFans V1 Security Hardening
-- ============================================================

-- Admin claim queue: authenticated users only.
-- Function itself additionally verifies platform_admins membership.
revoke all on function public.admin_pending_claim_details() from public;
revoke execute on function public.admin_pending_claim_details() from anon;
grant execute on function public.admin_pending_claim_details() to authenticated;

-- Admin claim review: authenticated users only.
-- Function itself additionally verifies platform_admins membership.
revoke all on function public.admin_review_claim(uuid, boolean) from public;
revoke execute on function public.admin_review_claim(uuid, boolean) from anon;
grant execute on function public.admin_review_claim(uuid, boolean) to authenticated;

-- Tender claim verification: authenticated users only.
-- Function itself additionally verifies Spot-management permission.
revoke all on function public.review_tender_claim(uuid, boolean) from public;
revoke execute on function public.review_tender_claim(uuid, boolean) from anon;
grant execute on function public.review_tender_claim(uuid, boolean) to authenticated;


-- Affiliation request queue: authenticated users only.
revoke all on function public.admin_pending_bartender_venue_requests() from public;
revoke execute on function public.admin_pending_bartender_venue_requests() from anon;
grant execute on function public.admin_pending_bartender_venue_requests() to authenticated;

-- Affiliation review: authenticated users only.
revoke all on function public.review_bartender_venue_request(uuid, boolean) from public;
revoke execute on function public.review_bartender_venue_request(uuid, boolean) from anon;
grant execute on function public.review_bartender_venue_request(uuid, boolean) to authenticated;


-- Trigger-only auth profile function.
-- Browser client roles must not execute this directly.
revoke all on function public.handle_new_auth_user() from public;
revoke execute on function public.handle_new_auth_user() from anon;
revoke execute on function public.handle_new_auth_user() from authenticated;

-- Trigger-only Spot claim validation function.
-- Executed by entity_claims triggers, not directly by browser clients.
revoke all on function public.validate_spot_claim() from public;
revoke execute on function public.validate_spot_claim() from anon;
revoke execute on function public.validate_spot_claim() from authenticated;

-- Google Places venue upsert must only be callable by trusted server code.
revoke all on function public.upsert_google_venue(
  text,
  text,
  text,
  text,
  text,
  text,
  double precision,
  double precision
) from public;

revoke execute on function public.upsert_google_venue(
  text,
  text,
  text,
  text,
  text,
  text,
  double precision,
  double precision
) from anon;

revoke execute on function public.upsert_google_venue(
  text,
  text,
  text,
  text,
  text,
  text,
  double precision,
  double precision
) from authenticated;

revoke all on function public.upsert_google_venue(
  text,
  text,
  text,
  text,
  text,
  text,
  double precision,
  double precision,
  text,
  text,
  jsonb
) from public;

revoke execute on function public.upsert_google_venue(
  text,
  text,
  text,
  text,
  text,
  text,
  double precision,
  double precision,
  text,
  text,
  jsonb
) from anon;

revoke execute on function public.upsert_google_venue(
  text,
  text,
  text,
  text,
  text,
  text,
  double precision,
  double precision,
  text,
  text,
  jsonb
) from authenticated;

-- Prevent duplicate active Tenders with the same normalized name
-- at the same Spot while still allowing distinct names such as
-- "Tess M." or "Tess R.".
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
  normalized_name text;
begin
  normalized_name :=
    lower(
      regexp_replace(
        trim(p_display_name),
        '\s+',
        ' ',
        'g'
      )
    );

  if normalized_name = '' then
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

  if exists (
    select 1
    from public.bartenders b
    join public.bartender_venues bv
      on bv.bartender_id = b.id
    where bv.venue_id = p_venue_id
      and bv.is_current = true
      and b.status = 'active'
      and lower(
        regexp_replace(
          trim(b.display_name),
          '\s+',
          ' ',
          'g'
        )
      ) = normalized_name
  ) then
    raise exception
      'A Tender with that name already exists at this Spot. Add an initial or last name to distinguish them.';
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

-- Live schema allows anonymous shoutouts.
alter table public.shoutouts
  alter column user_id drop not null;

-- Validate Tender/Spot relationship and voice before creating a shoutout.
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
  if not exists (
    select 1
    from public.bartender_venues bv
    join public.bartenders b
      on b.id = bv.bartender_id
    join public.venues v
      on v.id = bv.venue_id
    where bv.bartender_id = p_bartender_id
      and bv.venue_id = p_venue_id
      and bv.is_current = true
      and b.status = 'active'
      and v.status = 'active'
  ) then
    raise exception
      'This Tender is not currently affiliated with this Spot.';
  end if;

  select id
  into selected_voice_id
  from public.voices
  where name = p_voice_name
    and active = true
  limit 1;

  if selected_voice_id is null then
    raise exception 'Invalid shout voice.';
  end if;

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

-- Restrict public media bucket uploads to common web image formats and 10 MB.
update storage.buckets
set
  file_size_limit = 10485760,
  allowed_mime_types = array[
    'image/jpeg',
    'image/png',
    'image/webp'
  ]
where id = 'spot-media';

-- Public relationship reads should expose only current Tender/Spot affiliations.
drop policy if exists "public bartender venues"
on public.bartender_venues;

create policy "public bartender venues"
on public.bartender_venues
for select
to public
using (is_current = true);

-- Do not expose internal account UUIDs through public shout/media reads.
revoke select
on public.shoutouts
from anon;

grant select (
  id,
  bartender_id,
  venue_id,
  voice_id,
  status,
  created_at
)
on public.shoutouts
to anon;

revoke select
on public.media_assets
from anon;

grant select (
  id,
  entity_kind,
  bartender_id,
  venue_id,
  storage_path,
  alt_text,
  is_hero,
  sort_order,
  status,
  created_at,
  media_type
)
on public.media_assets
to anon;

-- Prevent duplicate simultaneous current Tender/Spot relationships.
create unique index if not exists bartender_venues_one_current_pair
on public.bartender_venues (bartender_id, venue_id)
where is_current = true;

-- Public claim discovery may identify already-claimed entities without
-- exposing private verification or claimant data.
create or replace function public.public_approved_claimed_entities()
returns table (
  entity_kind text,
  entity_id uuid
)
language sql
security definer
set search_path = public
stable
as $$
  select
    ec.entity_kind::text,
    case
      when ec.entity_kind = 'bartender' then ec.bartender_id
      when ec.entity_kind = 'venue' then ec.venue_id
    end
  from public.entity_claims ec
  where ec.status = 'approved'
    and (
      (ec.entity_kind = 'bartender' and ec.bartender_id is not null)
      or
      (ec.entity_kind = 'venue' and ec.venue_id is not null)
    );
$$;

revoke all
on function public.public_approved_claimed_entities()
from public;

grant execute
on function public.public_approved_claimed_entities()
to anon, authenticated;

