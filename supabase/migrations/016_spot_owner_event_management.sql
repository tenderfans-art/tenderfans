-- ============================================================
-- TenderFans
-- Spot Owner Event Management
-- ============================================================
-- Allows an authorized Spot owner/manager to edit an event
-- belonging to a venue they manage.
--
-- Any edit returns the event to Admin verification and removes
-- it from the public calendar until re-approved.
-- ============================================================

create or replace function public.spot_owner_update_event(
  p_event_id uuid,
  p_venue_id uuid,
  p_title text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_flyer_url text,
  p_flyer_storage_path text
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  -- User must have management permission for this Spot.
  if not exists (
    select 1
    from public.venue_permissions vp
    where vp.user_id = auth.uid()
      and vp.venue_id = p_venue_id
      and vp.can_edit = true
  ) then
    raise exception 'Spot management access required';
  end if;

  if trim(coalesce(p_title, '')) = '' then
    raise exception 'Event title is required';
  end if;

  if p_starts_at is null then
    raise exception 'Event start time is required';
  end if;

  if p_ends_at is not null and p_ends_at <= p_starts_at then
    raise exception 'End time must be after start time';
  end if;

  if trim(coalesce(p_flyer_url, '')) = ''
     or trim(coalesce(p_flyer_storage_path, '')) = '' then
    raise exception 'Event flyer is required';
  end if;

  update public.events e
  set
    title = trim(p_title),
    starts_at = p_starts_at,
    ends_at = p_ends_at,
    flyer_url = p_flyer_url,
    flyer_storage_path = p_flyer_storage_path,

    -- Any Owner edit requires Admin re-verification.
    status = 'draft',

    -- The Spot itself does not need to re-approve its own edit.
    venue_approval_status = 'approved',
    admin_approval_status = 'pending',

    reviewed_by = null,
    reviewed_at = null,
    updated_at = now()

  where e.id = p_event_id
    and e.venue_id = p_venue_id;

  if not found then
    raise exception 'Event not found for this Spot';
  end if;
end;
$function$;

revoke execute on function public.spot_owner_update_event(
  uuid,
  uuid,
  text,
  timestamptz,
  timestamptz,
  text,
  text
)
from public, anon;

grant execute on function public.spot_owner_update_event(
  uuid,
  uuid,
  text,
  timestamptz,
  timestamptz,
  text,
  text
)
to authenticated, service_role;
