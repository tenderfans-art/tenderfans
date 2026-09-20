-- ============================================================
-- ADMIN TENDER MANAGEMENT
-- Admin-only Tender directory and policy-removal control.
-- ============================================================

create or replace function public.admin_list_tenders()
returns table (
  id uuid,
  display_name text,
  slug text,
  tender_type text,
  status text,
  current_venue_id uuid,
  current_venue_name text,
  is_claimed boolean
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
    b.id,
    b.display_name,
    b.slug,
    b.tender_type,
    b.status,
    current_spot.venue_id,
    current_spot.venue_name,
    exists (
      select 1
      from public.bartender_permissions bp
      where bp.bartender_id = b.id
    ) as is_claimed
  from public.bartenders b
  left join lateral (
    select
      v.id as venue_id,
      v.name as venue_name
    from public.bartender_venues bv
    join public.venues v
      on v.id = bv.venue_id
    where bv.bartender_id = b.id
      and bv.is_current = true
    order by bv.started_at desc nulls last,
             bv.id desc
    limit 1
  ) current_spot on true
  order by b.display_name;
end;
$$;

revoke all
on function public.admin_list_tenders()
from public;

grant execute
on function public.admin_list_tenders()
to authenticated;


create or replace function public.admin_remove_tender(
  p_bartender_id uuid
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

  update public.bartenders
  set status = 'removed'
  where id = p_bartender_id
    and status <> 'removed';

  if not found then
    raise exception 'Tender not found or already removed.';
  end if;
end;
$$;

revoke all
on function public.admin_remove_tender(uuid)
from public;

grant execute
on function public.admin_remove_tender(uuid)
to authenticated;
