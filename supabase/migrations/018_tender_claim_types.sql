-- ============================================================
-- 018_tender_claim_types.sql
-- Store requested Tender type on Tender claims and apply it
-- only after TenderFans Admin approval.
-- ============================================================

alter table public.entity_claims
  add column if not exists requested_tender_type text
  references public.tender_types(key);

-- Existing pending Tender claims predate Tender types and are
-- therefore treated as Bartender claims.
update public.entity_claims
set requested_tender_type = 'bartender'
where entity_kind = 'bartender'
  and requested_tender_type is null;

-- A Spot claim must never carry a Tender type.
alter table public.entity_claims
  drop constraint if exists entity_claims_requested_tender_type_check;

alter table public.entity_claims
  add constraint entity_claims_requested_tender_type_check
  check (
    (entity_kind = 'bartender' and requested_tender_type is not null)
    or
    (entity_kind <> 'bartender' and requested_tender_type is null)
  );

-- PostgreSQL cannot CREATE OR REPLACE a function when its
-- RETURNS TABLE row type changes.
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
  requested_tender_type text
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
    ec.role_start_date,
    ec.requested_tender_type

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

revoke all on function public.admin_pending_claim_details() from public;
revoke execute on function public.admin_pending_claim_details() from anon;
grant execute on function public.admin_pending_claim_details() to authenticated;

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
      update public.bartenders
      set tender_type = coalesce(v_claim.requested_tender_type, 'bartender')
      where id = v_claim.bartender_id;

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

revoke all on function public.admin_review_claim(uuid, boolean) from public;
revoke execute on function public.admin_review_claim(uuid, boolean) from anon;
grant execute on function public.admin_review_claim(uuid, boolean) to authenticated;
