-- Atomic Market-scoped event deletion.
-- Original global admin_delete_event remains unchanged.

begin;

create function public.admin_delete_market_event(
  p_event_id uuid,
  p_market_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text;
begin
  if auth.uid() is null or not exists (
    select 1 from public.platform_admins
    where user_id = auth.uid()
  ) then
    raise exception 'Admin access required';
  end if;

  if p_event_id is null or p_market_id is null then
    raise exception 'Event and Market are required';
  end if;

  -- Event ownership is its publishing Spot, not
  -- the physical location where an event occurs.
  --
  -- Lock both records to prevent a concurrent
  -- membership change between checking and deleting.
  select e.flyer_storage_path
  into v_path
  from public.events e
  join public.event_processing_market_venues mv
    on mv.venue_id = e.venue_id
   and mv.market_id = p_market_id
  where e.id = p_event_id
  for update of e, mv;

  if not found then
    raise exception 'Event not found in this Market';
  end if;

  delete from public.events where id = p_event_id;

  if not found then
    raise exception 'Event deletion failed';
  end if;

  -- Preserve flyers still referenced by other events.
  if v_path is not null and exists (
    select 1 from public.events
    where flyer_storage_path = v_path
  ) then
    return null;
  end if;

  return v_path;
end;
$$;

revoke all on function
  public.admin_delete_market_event(uuid, uuid)
from public, anon, authenticated;

grant execute on function
  public.admin_delete_market_event(uuid, uuid)
to authenticated;

commit;
