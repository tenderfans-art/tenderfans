create table if not exists public.platform_admins (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;

drop policy if exists "admins can read platform admins" on public.platform_admins;

create policy "admins can read platform admins"
on public.platform_admins
for select
to authenticated
using (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);

drop policy if exists "admins can read all claims" on public.entity_claims;

create policy "admins can read all claims"
on public.entity_claims
for select
to authenticated
using (
  exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  )
);

create or replace function public.admin_review_claim(
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

revoke all on function public.admin_review_claim(uuid, boolean) from public;
grant execute on function public.admin_review_claim(uuid, boolean) to authenticated;
