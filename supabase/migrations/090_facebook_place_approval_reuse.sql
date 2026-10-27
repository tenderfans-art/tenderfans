-- Reuse explicitly approved Facebook place identities.
-- Preserve event-level IDs, dates, existing review functions,
-- and all non-Facebook attribution behavior.

create or replace function public.resolved_facebook_place_venue(
  p_facebook_place_id text
)
returns table(venue_id uuid)
language sql
security definer
set search_path = public
stable
as $$
  with approved as (
    select distinct u.resolved_venue_id
    from public.event_harvest_unresolved_venues u
    join public.event_harvest_sources s
      on s.id = u.source_id
    join public.venues v
      on v.id = u.resolved_venue_id
    where s.source_type = 'facebook_events'
      and u.status = 'resolved'
      and v.status = 'active'
      and nullif(trim(p_facebook_place_id), '') is not null
      and u.evidence->>'facebookPlaceId' =
          trim(p_facebook_place_id)
  )
  select resolved_venue_id
  from approved
  where (select count(*) from approved) = 1;
$$;

revoke all on function
  public.resolved_facebook_place_venue(text)
from public, anon, authenticated;

grant execute on function
  public.resolved_facebook_place_venue(text)
to service_role;


-- Keep the existing Admin review RPC unchanged.
-- When it approves a Facebook place, propagate that exact
-- approved place identity to other pending occurrences.
-- Conflicting prior approvals are never overwritten.

create or replace function
public.propagate_approved_facebook_place()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_place_id text;
  v_conflicting_approvals boolean;
begin
  if new.status <> 'resolved'
     or new.resolved_venue_id is null
     or (
       old.status = 'resolved'
       and old.resolved_venue_id is not distinct from
           new.resolved_venue_id
     )
  then
    return new;
  end if;

  if not exists (
    select 1
    from public.event_harvest_sources s
    where s.id = new.source_id
      and s.source_type = 'facebook_events'
  ) then
    return new;
  end if;

  v_place_id :=
    nullif(trim(new.evidence->>'facebookPlaceId'), '');

  if v_place_id is null then
    return new;
  end if;

  select exists (
    select 1
    from public.event_harvest_unresolved_venues u
    join public.event_harvest_sources s
      on s.id = u.source_id
    where s.source_type = 'facebook_events'
      and u.status = 'resolved'
      and u.resolved_venue_id <> new.resolved_venue_id
      and u.evidence->>'facebookPlaceId' = v_place_id
  )
  into v_conflicting_approvals;

  if v_conflicting_approvals then
    return new;
  end if;

  update public.event_harvest_unresolved_venues u
  set
    status = 'resolved',
    resolved_venue_id = new.resolved_venue_id,
    reviewed_by = new.reviewed_by,
    reviewed_at = now(),
    updated_at = now()
  from public.event_harvest_sources s
  where s.id = u.source_id
    and s.source_type = 'facebook_events'
    and u.id <> new.id
    and u.status = 'pending'
    and u.evidence->>'facebookPlaceId' = v_place_id;

  return new;
end;
$$;

drop trigger if exists
  propagate_approved_facebook_place_trigger
on public.event_harvest_unresolved_venues;

create trigger propagate_approved_facebook_place_trigger
after update of status, resolved_venue_id
on public.event_harvest_unresolved_venues
for each row
execute function public.propagate_approved_facebook_place();
