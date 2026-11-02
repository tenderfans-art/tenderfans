-- Atomic, market-owned contest activation.
-- Market-scoped contest activation and Shout eligibility.
-- Preserve the existing contest and its verification/cooldown rules.
-- Keep the established Market key stable for operational routing.

create function public.admin_set_market_contest_active(
  p_contest_id uuid,
  p_active boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_market_id uuid;
begin
  if auth.uid() is null or not exists (
    select 1
    from public.platform_admins
    where user_id = auth.uid()
  ) then
    raise exception 'Admin access required';
  end if;

  if p_contest_id is null or p_active is null then
    raise exception 'Contest and activation state are required';
  end if;

  select market_id
  into v_market_id
  from public.contests
  where id = p_contest_id;

  if not found then
    raise exception 'Contest not found';
  end if;

  if v_market_id is null then
    raise exception
      'Assign this contest to a Market before activation';
  end if;

  -- Serialize competing activation requests for this Market.
  perform 1
  from public.event_processing_markets
  where id = v_market_id
  for update;

  if not found then
    raise exception 'Owning Market not found';
  end if;

  if p_active then
    update public.contests
    set is_active = false,
        updated_at = now()
    where market_id = v_market_id
      and id <> p_contest_id
      and is_active = true;

    update public.contests
    set is_active = true,
        updated_at = now()
    where id = p_contest_id
      and market_id = v_market_id;
  else
    update public.contests
    set is_active = false,
        updated_at = now()
    where id = p_contest_id
      and market_id = v_market_id;
  end if;

  if not found then
    raise exception 'Contest activation failed';
  end if;
end;
$$;

revoke all on function
  public.admin_set_market_contest_active(uuid, boolean)
from public, anon, authenticated;

grant execute on function
  public.admin_set_market_contest_active(uuid, boolean)
to authenticated;


-- ------------------------------------------------------------
-- First Market: display-name change only.
-- Preserve the Market ID, key, Spot assignments and workflows.
-- ------------------------------------------------------------

update public.event_processing_markets
set display_name = 'Pinellas County',
    updated_at = now()
where market_key = 'tampa-bay';

do $$
begin
  if not exists (
    select 1
    from public.event_processing_markets
    where market_key = 'tampa-bay'
  ) then
    raise exception 'Existing Tampa Bay Market not found';
  end if;
end;
$$;

-- Preserve the inaugural contest and assign its owning Market.
update public.contests
set market_id = (
      select id
      from public.event_processing_markets
      where market_key = 'tampa-bay'
    ),
    updated_at = now()
where id = 'f3062c04-2b5c-4d4b-8534-3de8342e334a'
  and market_id is null;

do $$
begin
  if not exists (
    select 1
    from public.contests c
    join public.event_processing_markets m
      on m.id = c.market_id
    where c.id = 'f3062c04-2b5c-4d4b-8534-3de8342e334a'
      and m.market_key = 'tampa-bay'
  ) then
    raise exception 'Inaugural contest Market assignment failed';
  end if;
end;
$$;

-- Remove the old platform-wide restriction.
-- Migration 101 already enforces one active contest per Market.
drop index if exists public.contests_one_active_idx;

-- ------------------------------------------------------------
-- Market eligibility for the existing five-argument RPC.
--
-- Preserve its complete existing Shout, trait, verification,
-- cooldown and entry-creation implementation.
-- ------------------------------------------------------------

create or replace function public.create_contest_shoutout(
  p_contest_id uuid,
  p_phone_identity_id uuid,
  p_bartender_id uuid,
  p_venue_id uuid,
  p_traits text[]
)
returns uuid
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_shoutout_id uuid;
  v_recent_entry timestamptz;
  v_now timestamptz := now();
begin
  perform pg_advisory_xact_lock(
    hashtextextended(
      p_contest_id::text || ':' ||
      p_phone_identity_id::text || ':' ||
      p_bartender_id::text,
      0
    )
  );

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

  -- The selected contest must belong to a Market containing
  -- at least one current Spot of the selected Tender.
  if not exists (
    select 1
    from public.contests c
    join public.event_processing_market_venues mv
      on mv.market_id = c.market_id
    join public.bartender_venues bv
      on bv.venue_id = mv.venue_id
    join public.venues v
      on v.id = bv.venue_id
    where c.id = p_contest_id
      and bv.bartender_id = p_bartender_id
      and bv.is_current = true
      and v.status = 'active'
  ) then
    raise exception 'CONTEST_MARKET_MISMATCH';
  end if;

  if not exists (
    select 1
    from public.contest_phone_identities i
    where i.id = p_phone_identity_id
  ) then
    raise exception 'PHONE_NOT_VERIFIED';
  end if;

  if not exists (
    select 1
    from public.bartenders b
    where b.id = p_bartender_id
      and b.status = 'active'
  ) then
    raise exception 'TENDER_NOT_AVAILABLE';
  end if;

  if not exists (
    select 1
    from public.venues v
    where v.id = p_venue_id
      and v.status = 'active'
  ) then
    raise exception 'SPOT_NOT_AVAILABLE';
  end if;

  if not exists (
    select 1
    from public.bartender_venues bv
    where bv.bartender_id = p_bartender_id
      and bv.venue_id = p_venue_id
      and bv.is_current = true
  ) then
    raise exception 'TENDER_SPOT_MISMATCH';
  end if;

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

  if p_traits is null
     or array_length(p_traits, 1) is null
     or array_length(p_traits, 1) < 1
     or array_length(p_traits, 1) > 5
  then
    raise exception 'INVALID_TRAITS';
  end if;

  insert into public.shoutouts (
    user_id, bartender_id, venue_id, status, created_at
  )
  values (
    null, p_bartender_id, p_venue_id, 'published', v_now
  )
  returning id into v_shoutout_id;

  insert into public.shoutout_traits (
    shoutout_id, trait_id
  )
  select v_shoutout_id, t.id
  from public.traits t
  where t.label = any(p_traits)
    and t.audience = 'bartender'
    and t.active = true;

  if (
    select count(*)
    from public.shoutout_traits st
    where st.shoutout_id = v_shoutout_id
  ) <> array_length(p_traits, 1) then
    raise exception 'INVALID_TRAITS';
  end if;

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
$function$;

-- Preserve server-side access; never expose contest
-- Shout creation directly to anonymous browsers.
revoke all on function
  public.create_contest_shoutout(
    uuid, uuid, uuid, uuid, text[]
  )
from public, anon, authenticated;

grant execute on function
  public.create_contest_shoutout(
    uuid, uuid, uuid, uuid, text[]
  )
to service_role;
