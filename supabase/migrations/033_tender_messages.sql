-- TenderFans Tender Messages
-- Private in-app system messages for claimed Tenders.
--
-- This is intentionally separate from notification_events.
-- notification_events remains the follower/outbound activity queue.
-- tender_messages is the Tender's persistent private inbox.

create table if not exists public.tender_messages (
  id uuid primary key default gen_random_uuid(),

  bartender_id uuid not null
    references public.bartenders(id)
    on delete cascade,

  message_type text not null
    check (
      message_type in (
        'shout_received',
        'event_tagged',
        'system'
      )
    ),

  title text not null,
  body text not null,

  action_url text,
  source_kind text,
  source_id uuid,

  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists tender_messages_bartender_created_idx
  on public.tender_messages(bartender_id, created_at desc);

create index if not exists tender_messages_bartender_unread_idx
  on public.tender_messages(bartender_id, created_at desc)
  where read_at is null;

-- A Shout should create at most one inbox message.
create unique index if not exists tender_messages_shout_unique
  on public.tender_messages(source_id)
  where source_kind = 'shoutout'
    and message_type = 'shout_received';


alter table public.tender_messages enable row level security;


-- Claimed Tenders may read only their own messages.
drop policy if exists "tenders can read own messages"
on public.tender_messages;

create policy "tenders can read own messages"
on public.tender_messages
for select
to authenticated
using (
  exists (
    select 1
    from public.bartender_permissions bp
    where bp.bartender_id = tender_messages.bartender_id
      and bp.user_id = auth.uid()
  )
);


-- Message content is system-owned. Tenders receive SELECT access
-- through RLS but do not receive direct UPDATE access.
--
-- Read state is changed only through this narrowly scoped RPC.

create or replace function public.mark_tender_messages_read(
  p_message_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;

  update public.tender_messages tm
  set read_at = coalesce(tm.read_at, now())
  where tm.id = any(p_message_ids)
    and exists (
      select 1
      from public.bartender_permissions bp
      where bp.bartender_id = tm.bartender_id
        and bp.user_id = auth.uid()
    );
end;
$$;

revoke all
on function public.mark_tender_messages_read(uuid[])
from public;

grant execute
on function public.mark_tender_messages_read(uuid[])
to authenticated;


-- ============================================================
-- SHOUT -> TENDER MESSAGE
-- ============================================================

create or replace function public.queue_tender_shout_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  spot_name text;
begin
  -- Only published Shouts qualify.
  if new.status <> 'published' then
    return new;
  end if;

  -- Do not build inbox history for an unclaimed Tender.
  if not exists (
    select 1
    from public.bartender_permissions bp
    where bp.bartender_id = new.bartender_id
  ) then
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
  values (
    new.bartender_id,
    'shout_received',
    'You received a new Shout!',
    case
      when spot_name is not null then
        'Someone gave you props at ' || spot_name || '.'
      else
        'Someone gave you props on TenderFans.'
    end,
    '/account/tender',
    'shoutout',
    new.id
  )
  on conflict do nothing;

  return new;
end;
$$;


drop trigger if exists queue_tender_shout_message_trigger
on public.shoutouts;

create trigger queue_tender_shout_message_trigger
after insert
on public.shoutouts
for each row
execute function public.queue_tender_shout_message();
