-- ============================================================
-- ADMIN SPOT MANAGEMENT
-- Admin-only Spot directory and policy-removal controls.
-- Removal preserves the venue and all historical relationships.
-- ============================================================

create or replace function public.admin_list_spots()
returns table (
  id uuid,
  name text,
  slug text,
  city text,
  state_region text,
  status text,
  manager_name text,
  manager_role text,
  manager_email text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  ) then
    raise exception 'Admin access required.';
  end if;

  return query
  select
    v.id,
    v.name,
    v.slug,
    v.city,
    v.state_region,
    v.status,
    manager.claimant_name,
    manager.claimant_role,
    manager.business_email
  from public.venues v
  left join lateral (
    select
      ec.claimant_name,
      ec.claimant_role,
      ec.business_email
    from public.entity_claims ec
    where ec.entity_kind = 'venue'
      and ec.venue_id = v.id
      and ec.status = 'approved'
    order by ec.reviewed_at desc nulls last,
             ec.created_at desc
    limit 1
  ) manager on true
  order by v.name;
end;
$$;

revoke all
on function public.admin_list_spots()
from public;

grant execute
on function public.admin_list_spots()
to authenticated;


create or replace function public.admin_remove_spot(
  p_venue_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  ) then
    raise exception 'Admin access required.';
  end if;

  update public.venues
  set status = 'removed'
  where id = p_venue_id
    and status <> 'removed';

  if not found then
    raise exception 'Spot not found or already removed.';
  end if;
end;
$$;

revoke all
on function public.admin_remove_spot(uuid)
from public;

grant execute
on function public.admin_remove_spot(uuid)
to authenticated;
