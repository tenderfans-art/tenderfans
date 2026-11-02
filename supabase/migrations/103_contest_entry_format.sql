-- Individual contest entry format, independent of Market.
-- Preserve the inaugural contest's original Shouts behavior.

alter table public.contests
  add column contest_format text not null default 'shouts';

alter table public.contests
  add constraint contests_format_supported
  check (contest_format in ('shouts', 'custom'));

comment on column public.contests.contest_format is
  'Entry mechanism for this contest. Custom contests do not intercept Shouts.';

-- Restrict the existing verified-Shout RPC to Shouts contests.
-- Preserve its validation, phone identity, cooldown, Market
-- eligibility, multi-contest crediting and transaction semantics.

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
  v_contest record;
begin
  -- Serialize all contest Shouts for this phone and Tender,
  -- including submissions targeting different Markets.
  perform pg_advisory_xact_lock(
    hashtextextended(
      p_phone_identity_id::text || ':' || p_bartender_id::text,
      0
    )
  );

  if not exists (
    select 1
    from public.contests c
    where c.id = p_contest_id
      and c.is_active = true
      and c.contest_format = 'shouts'
      and c.starts_at <= v_now
      and c.ends_at >= v_now
  ) then
    raise exception 'CONTEST_NOT_ACTIVE';
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

  -- Eligibility follows the Tender's current Spot associations,
  -- not only the Spot selected for this Shout.
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

  -- Credit every currently eligible active Market contest.
  -- If another contest is in cooldown, skip only that contest.
  for v_contest in
    select c.id
    from public.contests c
    where c.is_active = true
      and c.contest_format = 'shouts'
      and c.starts_at <= v_now
      and c.ends_at >= v_now
      and exists (
        select 1
        from public.event_processing_market_venues mv
        join public.bartender_venues bv
          on bv.venue_id = mv.venue_id
        join public.venues v
          on v.id = bv.venue_id
        where mv.market_id = c.market_id
          and bv.bartender_id = p_bartender_id
          and bv.is_current = true
          and v.status = 'active'
      )
    order by c.id
  loop
    if not exists (
      select 1
      from public.contest_shout_entries e
      where e.contest_id = v_contest.id
        and e.phone_identity_id = p_phone_identity_id
        and e.bartender_id = p_bartender_id
        and e.created_at > v_now - interval '7 days'
    ) then
      insert into public.contest_shout_entries (
        contest_id,
        phone_identity_id,
        bartender_id,
        shoutout_id,
        created_at
      )
      values (
        v_contest.id,
        p_phone_identity_id,
        p_bartender_id,
        v_shoutout_id,
        v_now
      );
    end if;
  end loop;

  return v_shoutout_id;
end;
$function$;

revoke all on function public.create_contest_shoutout(
  uuid, uuid, uuid, uuid, text[]
) from public, anon, authenticated;

grant execute on function public.create_contest_shoutout(
  uuid, uuid, uuid, uuid, text[]
) to service_role;
