-- ============================================================
-- ADMIN EVENT MANAGEMENT
-- Admin-only event directory and deletion control.
-- ============================================================

create or replace function public.admin_list_events()
returns table (
  id uuid,
  venue_id uuid,
  title text,
  starts_at timestamptz,
  ends_at timestamptz,
  status text,
  venue_approval_status text,
  admin_approval_status text,
  flyer_storage_path text,
  venue_name text
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
    e.id,
    e.venue_id,
    e.title,
    e.starts_at,
    e.ends_at,
    e.status,
    e.venue_approval_status,
    e.admin_approval_status,
    e.flyer_storage_path,
    v.name
  from public.events e
  join public.venues v
    on v.id = e.venue_id
  order by e.starts_at desc;
end;
$$;

revoke all
on function public.admin_list_events()
from public;

grant execute
on function public.admin_list_events()
to authenticated;


create or replace function public.admin_delete_event(
  p_event_id uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_flyer_storage_path text;
begin
  if auth.uid() is null or not exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  ) then
    raise exception 'Admin access required.';
  end if;

  delete from public.events e
  where e.id = p_event_id
  returning e.flyer_storage_path
  into v_flyer_storage_path;

  if not found then
    raise exception 'Event not found.';
  end if;

  return v_flyer_storage_path;
end;
$$;

revoke all
on function public.admin_delete_event(uuid)
from public;

grant execute
on function public.admin_delete_event(uuid)
to authenticated;
