-- TenderFans published-event Tender messaging
--
-- Events remain owned by Spots only.
-- There is intentionally no persistent event <-> Tender relationship.
--
-- When a Spot event becomes published, currently associated claimed
-- Tenders receive a private TenderFans Message.

create unique index if not exists tender_messages_event_unique
  on public.tender_messages(bartender_id, source_id)
  where source_kind = 'event'
    and message_type = 'event_tagged';


create or replace function public.queue_current_tender_event_messages()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  spot_name text;
begin
  -- Only act when an event actually transitions into published.
  if new.status <> 'published' then
    return new;
  end if;

  if old.status = 'published' then
    return new;
  end if;

  select v.name
  into spot_name
  from public.venues v
  where v.id = new.venue_id;

  insert into public.tender_messages (
    bartender_id,
    message_type,
    title,
    body,
    action_url,
    source_kind,
    source_id
  )
  select distinct
    bv.bartender_id,
    'event_tagged',
    coalesce(spot_name, 'Your Spot') || ' has a new event',
    case
      when new.title is not null then
        coalesce(spot_name, 'Your Spot') ||
        ' has published an upcoming event: ' ||
        new.title || '.'
      else
        coalesce(spot_name, 'Your Spot') ||
        ' has published a new upcoming event.'
    end,
    '/events',
    'event',
    new.id
  from public.bartender_venues bv
  where bv.venue_id = new.venue_id
    and bv.is_current = true

    -- Private Messages only exist for claimed Tenders.
    and exists (
      select 1
      from public.bartender_permissions bp
      where bp.bartender_id = bv.bartender_id
    )

  on conflict do nothing;

  return new;
end;
$$;


drop trigger if exists queue_current_tender_event_messages_trigger
on public.events;

create trigger queue_current_tender_event_messages_trigger
after update of status
on public.events
for each row
when (
  new.status = 'published'
  and old.status is distinct from new.status
)
execute function public.queue_current_tender_event_messages();
