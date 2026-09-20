-- ============================================================
-- SPOT OWNER TENDER MANAGEMENT
-- Allows an authorized Spot manager to end a current
-- Tender/Spot association without deleting relationship history.
-- ============================================================

create or replace function public.end_spot_tender_association(
  p_venue_id uuid,
  p_bartender_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  affected_rows integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;

  if not exists (
    select 1
    from public.venue_permissions vp
    where vp.venue_id = p_venue_id
      and vp.user_id = auth.uid()
      and vp.can_edit = true
  ) then
    raise exception 'You do not have permission to manage this Spot.';
  end if;

  update public.bartender_venues
  set
    is_current = false,
    is_primary = false,
    ended_at = current_date
  where venue_id = p_venue_id
    and bartender_id = p_bartender_id
    and is_current = true;

  get diagnostics affected_rows = row_count;

  if affected_rows = 0 then
    raise exception 'Current Tender association not found.';
  end if;
end;
$$;

revoke all
on function public.end_spot_tender_association(uuid, uuid)
from public;

grant execute
on function public.end_spot_tender_association(uuid, uuid)
to authenticated;
