-- ============================================================
-- 024 CONTEST SHOUT CONCURRENCY
--
-- Prevent simultaneous requests from bypassing the
-- phone x Tender x 7-day contest cooldown.
-- ============================================================

create or replace function public.create_contest_shoutout(
  p_contest_id uuid,
  p_phone_identity_id uuid,
  p_bartender_id uuid,
  p_venue_id uuid,
  p_voice_name text,
  p_traits text[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shoutout_id uuid;
  v_voice_id smallint;
  v_recent_entry timestamptz;
  v_now timestamptz := now();
begin

  -- Serialize submissions for this exact
  -- contest + phone identity + Tender combination.
  perform pg_advisory_xact_lock(
    hashtextextended(
      p_contest_id::text
      || ':'
      || p_phone_identity_id::text
      || ':'
      || p_bartender_id::text,
      0
    )
  );

  -- Contest must be active and inside its date window.
  if not exists (
    select 1
    from public.contests c
    where c.id = p_contest_id
      and c.is_active = true
      and c.starts_at <= v_now
      and c.ends_at >= v_now
  ) then
    raise exception 'CONTEST_NOT_ACTIVE';
  end if;

  -- Verified phone identity must exist.
  if not exists (
    select 1
    from public.contest_phone_identities i
    where i.id = p_phone_identity_id
  ) then
    raise exception 'PHONE_NOT_VERIFIED';
  end if;

  -- Tender must be active.
  if not exists (
    select 1
    from public.bartenders b
    where b.id = p_bartender_id
      and b.status = 'active'
  ) then
    raise exception 'TENDER_NOT_AVAILABLE';
  end if;

  -- Spot must be active.
  if not exists (
    select 1
    from public.venues v
    where v.id = p_venue_id
      and v.status = 'active'
  ) then
    raise exception 'SPOT_NOT_AVAILABLE';
  end if;

  -- Tender must currently work at this Spot.
  if not exists (
    select 1
    from public.bartender_venues bv
    where bv.bartender_id = p_bartender_id
      and bv.venue_id = p_venue_id
      and bv.is_current = true
  ) then
    raise exception 'TENDER_SPOT_MISMATCH';
  end if;

  -- One qualifying Shout per verified phone,
  -- per Tender, every seven days within this contest.
  select e.created_at
  into v_recent_entry
  from public.contest_shout_entries e
  where e.contest_id = p_contest_id
    and e.phone_identity_id = p_phone_identity_id
    and e.bartender_id = p_bartender_id
    and e.created_at > v_now - interval '7 days'
  order by e.created_at desc
  limit 1;

  if v_recent_entry is not null then
    raise exception
      'CONTEST_COOLDOWN:%',
      (v_recent_entry + interval '7 days');
  end if;

  -- Resolve active voice.
  select v.id
  into v_voice_id
  from public.voices v
  where v.name = p_voice_name
    and v.active = true
  limit 1;

  if v_voice_id is null then
    raise exception 'INVALID_VOICE';
  end if;

  if p_traits is null
     or array_length(p_traits, 1) is null
     or array_length(p_traits, 1) < 1
     or array_length(p_traits, 1) > 5 then
    raise exception 'INVALID_TRAITS';
  end if;

  -- Create normal published TenderFans Shout.
  insert into public.shoutouts (
    user_id,
    bartender_id,
    venue_id,
    voice_id,
    status,
    created_at
  )
  values (
    null,
    p_bartender_id,
    p_venue_id,
    v_voice_id,
    'published',
    v_now
  )
  returning id into v_shoutout_id;

  -- Attach valid active bartender traits.
  insert into public.shoutout_traits (
    shoutout_id,
    trait_id
  )
  select
    v_shoutout_id,
    t.id
  from public.traits t
  where t.label = any(p_traits)
    and t.audience = 'bartender'
    and t.active = true;

  -- Every submitted trait must resolve.
  if (
    select count(*)
    from public.shoutout_traits st
    where st.shoutout_id = v_shoutout_id
  ) <> array_length(p_traits, 1) then
    raise exception 'INVALID_TRAITS';
  end if;

  -- Record contest qualification.
  insert into public.contest_shout_entries (
    contest_id,
    phone_identity_id,
    bartender_id,
    shoutout_id,
    created_at
  )
  values (
    p_contest_id,
    p_phone_identity_id,
    p_bartender_id,
    v_shoutout_id,
    v_now
  );

  return v_shoutout_id;
end;
$$;

revoke all
on function public.create_contest_shoutout(
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  text[]
)
from public, anon, authenticated;

grant execute
on function public.create_contest_shoutout(
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  text[]
)
to service_role;
