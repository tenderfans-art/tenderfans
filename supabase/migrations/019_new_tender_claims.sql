-- ============================================================
-- 019_new_tender_claims.sql
-- Allow a Tender claim to request creation of a new Tender
-- profile at an existing Spot.
-- ============================================================

alter table public.entity_claims
  add column if not exists requested_tender_name text,
  add column if not exists requested_venue_id uuid
    references public.venues(id) on delete restrict;

-- Replace the original entity-shape constraint.
alter table public.entity_claims
  drop constraint if exists entity_claims_check;

alter table public.entity_claims
  add constraint entity_claims_check
  check (
    (
      entity_kind = 'bartender'
      and (
        (
          bartender_id is not null
          and venue_id is null
          and requested_tender_name is null
          and requested_venue_id is null
        )
        or
        (
          bartender_id is null
          and venue_id is null
          and requested_tender_name is not null
          and length(trim(requested_tender_name)) >= 2
          and requested_venue_id is not null
        )
      )
    )
    or
    (
      entity_kind = 'venue'
      and venue_id is not null
      and bartender_id is null
      and requested_tender_name is null
      and requested_venue_id is null
    )
  );

-- ============================================================
-- Admin pending claim queue
-- ============================================================

drop function if exists public.admin_pending_claim_details();

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
  role_start_date date,
  requested_tender_type text,
  requested_tender_name text,
  requested_venue_id uuid
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
    p.username,
    u.email::text,

    case
      when ec.entity_kind = 'bartender'
        then coalesce(b.display_name, ec.requested_tender_name)
      when ec.entity_kind = 'venue'
        then v.name
      else null
    end,

    coalesce(vv.name, rv.name),
    ec.claimed_hire_date,
    ec.claimant_role,
    ec.business_email,
    ec.role_start_date,
    ec.requested_tender_type,
    ec.requested_tender_name,
    ec.requested_venue_id

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

  left join public.venues rv
    on rv.id = ec.requested_venue_id

  where ec.status = 'pending'
  order by ec.created_at asc;
end;
$$;

revoke all on function public.admin_pending_claim_details() from public;
revoke execute on function public.admin_pending_claim_details() from anon;
grant execute on function public.admin_pending_claim_details() to authenticated;

-- ============================================================
-- Admin claim approval
-- ============================================================

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
  v_bartender_id uuid;
  v_slug text;
  v_normalized_name text;
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

    if v_claim.entity_kind = 'bartender' then

      -- Existing Tender claim
      if v_claim.bartender_id is not null then

        v_bartender_id := v_claim.bartender_id;

        update public.bartenders
        set tender_type =
          coalesce(v_claim.requested_tender_type, 'bartender')
        where id = v_bartender_id;

      -- New Tender requested at existing Spot
      else

        if not exists (
          select 1
          from public.venues
          where id = v_claim.requested_venue_id
            and status = 'active'
        ) then
          raise exception 'Requested Spot is no longer active';
        end if;

        v_normalized_name :=
          lower(
            regexp_replace(
              trim(v_claim.requested_tender_name),
              '\s+',
              ' ',
              'g'
            )
          );

        if exists (
          select 1
          from public.bartenders b
          join public.bartender_venues bv
            on bv.bartender_id = b.id
          where bv.venue_id = v_claim.requested_venue_id
            and bv.is_current = true
            and b.status = 'active'
            and lower(
              regexp_replace(
                trim(b.display_name),
                '\s+',
                ' ',
                'g'
              )
            ) = v_normalized_name
        ) then
          raise exception
            'A Tender with that name already exists at this Spot';
        end if;

        v_slug :=
          regexp_replace(
            lower(trim(v_claim.requested_tender_name)),
            '[^a-z0-9]+',
            '-',
            'g'
          )
          || '-'
          || substr(gen_random_uuid()::text, 1, 6);

        insert into public.bartenders (
          display_name,
          slug,
          status,
          tender_type
        )
        values (
          trim(v_claim.requested_tender_name),
          v_slug,
          'active',
          coalesce(v_claim.requested_tender_type, 'bartender')
        )
        returning id into v_bartender_id;

        insert into public.bartender_venues (
          bartender_id,
          venue_id,
          is_current
        )
        values (
          v_bartender_id,
          v_claim.requested_venue_id,
          true
        );

        update public.entity_claims
        set
          bartender_id = v_bartender_id,
          requested_tender_name = null,
          requested_venue_id = null
        where id = p_claim_id;

      end if;

      insert into public.bartender_permissions (
        bartender_id,
        user_id,
        can_edit,
        can_manage_media
      )
      values (
        v_bartender_id,
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

    update public.entity_claims
    set
      status = 'approved',
      verification_method = 'tenderfans_admin',
      verification_notes = null,
      reviewed_at = now()
    where id = p_claim_id;

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

revoke all on function public.admin_review_claim(uuid, boolean) from public;
revoke execute on function public.admin_review_claim(uuid, boolean) from anon;
grant execute on function public.admin_review_claim(uuid, boolean) to authenticated;
