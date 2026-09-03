-- TenderFans V1 authenticated claimant foundation
--
-- Public users do not require accounts.
-- Authenticated accounts are for Tenders and Spot representatives.
--
-- Privacy rule:
-- Supabase Auth stores the account email.
-- TenderFans does not collect/store personal phone numbers,
-- DOB, home addresses, IDs or verification documents.

-- ============================================================
-- 1. CREATE PROFILE AUTOMATICALLY AFTER AUTH SIGNUP
-- ============================================================

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    id,
    username
  )
  values (
    new.id,
    'tf_' || left(replace(new.id::text, '-', ''), 20)
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
after insert on auth.users
for each row
execute procedure public.handle_new_auth_user();


-- ============================================================
-- 2. CLAIM SAFETY
-- Prevent duplicate pending/approved claims from the same user
-- against the same entity.
-- ============================================================

create unique index if not exists entity_claims_user_bartender_active_idx
on public.entity_claims (claimant_user_id, bartender_id)
where bartender_id is not null
  and status in ('pending', 'approved');


create unique index if not exists entity_claims_user_venue_active_idx
on public.entity_claims (claimant_user_id, venue_id)
where venue_id is not null
  and status in ('pending', 'approved');


-- Only one approved authenticated account may control a
-- Tender profile in V1.
create unique index if not exists entity_claims_one_approved_bartender_idx
on public.entity_claims (bartender_id)
where bartender_id is not null
  and status = 'approved';


-- ============================================================
-- 3. TENDER CLAIMS NEED A VERIFYING SPOT
--
-- entity_claims currently intentionally allows only bartender_id
-- OR venue_id. We therefore add a separate reference identifying
-- which Spot is being asked to verify a Tender claim.
-- ============================================================

alter table public.entity_claims
add column if not exists verifying_venue_id uuid
references public.venues(id) on delete set null;


-- A Spot claim must NOT have a verifying venue.
-- A Tender claim may have one.
alter table public.entity_claims
drop constraint if exists entity_claims_verifying_venue_check;

alter table public.entity_claims
add constraint entity_claims_verifying_venue_check
check (
  entity_kind = 'bartender'
  or verifying_venue_id is null
);


create index if not exists entity_claims_verifying_venue_idx
on public.entity_claims (verifying_venue_id, status)
where verifying_venue_id is not null;


-- ============================================================
-- 4. VERIFIED SPOT REPRESENTATIVES MAY SEE TENDER CLAIMS
-- SENT TO THEIR SPOT.
-- ============================================================

drop policy if exists "verified venue reps read tender claims"
on public.entity_claims;

create policy "verified venue reps read tender claims"
on public.entity_claims
for select
to authenticated
using (
  entity_kind = 'bartender'
  and verifying_venue_id is not null
  and exists (
    select 1
    from public.venue_permissions vp
    where vp.venue_id = entity_claims.verifying_venue_id
      and vp.user_id = auth.uid()
  )
);


-- ============================================================
-- 5. SAFE SPOT → TENDER VERIFICATION RPC
--
-- Do NOT give venue users unrestricted UPDATE access to claims.
-- This function verifies that the caller actually has permission
-- for the exact Spot attached to the Tender claim.
-- ============================================================

create or replace function public.review_tender_claim(
  p_claim_id uuid,
  p_approve boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.entity_claims%rowtype;
begin

  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select *
  into v_claim
  from public.entity_claims
  where id = p_claim_id
  for update;

  if not found then
    raise exception 'Claim not found';
  end if;

  if v_claim.entity_kind <> 'bartender' then
    raise exception 'This function only reviews Tender claims';
  end if;

  if v_claim.status <> 'pending' then
    raise exception 'Claim has already been reviewed';
  end if;

  if v_claim.verifying_venue_id is null then
    raise exception 'Tender claim has no verifying Spot';
  end if;

  if not exists (
    select 1
    from public.venue_permissions vp
    where vp.venue_id = v_claim.verifying_venue_id
      and vp.user_id = auth.uid()
  ) then
    raise exception 'You are not authorized to verify this Tender';
  end if;

  if p_approve then

    update public.entity_claims
    set
      status = 'approved',
      verification_method = 'verified_spot',
      verification_notes = null,
      reviewed_at = now()
    where id = p_claim_id;

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

  else

    update public.entity_claims
    set
      status = 'rejected',
      verification_method = 'verified_spot',
      verification_notes = null,
      reviewed_at = now()
    where id = p_claim_id;

  end if;

end;
$$;


revoke all on function public.review_tender_claim(uuid, boolean)
from public;

grant execute on function public.review_tender_claim(uuid, boolean)
to authenticated;
