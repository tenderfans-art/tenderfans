-- ============================================================
-- TENDERFANS NOTIFICATION DELIVERY ENGINE
--
-- 1. Follow notification outbox
-- 2. Per-channel delivery ledger
-- 3. Atomic delivery claim helper
-- 4. Automatically queue published Events for Spot followers
-- ============================================================


-- ============================================================
-- FOLLOW NOTIFICATION OUTBOX
-- ============================================================

create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),

  notification_type text not null,

  entity_kind text not null
    check (entity_kind in ('bartender', 'venue')),

  bartender_id uuid
    references public.bartenders(id)
    on delete cascade,

  venue_id uuid
    references public.venues(id)
    on delete cascade,

  event_id uuid
    references public.events(id)
    on delete cascade,

  title text not null,
  message text not null,
  url_path text,

  created_at timestamptz not null default now(),
  processed_at timestamptz,

  constraint notification_outbox_entity_check
    check (
      (
        entity_kind = 'bartender'
        and bartender_id is not null
        and venue_id is null
      )
      or
      (
        entity_kind = 'venue'
        and venue_id is not null
        and bartender_id is null
      )
    )
);

create index if not exists
  notification_outbox_pending_idx
on public.notification_outbox(created_at)
where processed_at is null;

create index if not exists
  notification_outbox_bartender_idx
on public.notification_outbox(bartender_id)
where bartender_id is not null;

create index if not exists
  notification_outbox_venue_idx
on public.notification_outbox(venue_id)
where venue_id is not null;

/*
 * One Event should only create one publication notification,
 * even if publication code is accidentally invoked twice.
 */
create unique index if not exists
  notification_outbox_event_published_unique
on public.notification_outbox(
  notification_type,
  event_id
)
where event_id is not null;

alter table public.notification_outbox
  enable row level security;



-- ============================================================
-- NOTIFICATION DELIVERY LEDGER
--
-- One row represents one attempted delivery through one channel.
--
-- Examples:
--
-- reminder:<reminder id>:email
--
-- follow:<outbox id>:<subscription id>:email
-- follow:<outbox id>:<subscription id>:sms
-- ============================================================

create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),

  dedupe_key text not null unique,

  source_kind text not null
    check (source_kind in ('reminder', 'follow')),

  reminder_id uuid
    references public.event_reminders(id)
    on delete cascade,

  outbox_id uuid
    references public.notification_outbox(id)
    on delete cascade,

  subscription_id uuid
    references public.notification_subscriptions(id)
    on delete cascade,

  channel text not null
    check (channel in ('email', 'sms')),

  status text not null default 'processing'
    check (
      status in (
        'processing',
        'sent',
        'failed'
      )
    ),

  attempt_count integer not null default 1
    check (attempt_count >= 1),

  provider_reference text,
  last_error text,

  last_attempt_at timestamptz not null default now(),
  sent_at timestamptz,

  created_at timestamptz not null default now()
);

create index if not exists
  notification_deliveries_reminder_idx
on public.notification_deliveries(reminder_id)
where reminder_id is not null;

create index if not exists
  notification_deliveries_outbox_idx
on public.notification_deliveries(outbox_id)
where outbox_id is not null;

create index if not exists
  notification_deliveries_subscription_idx
on public.notification_deliveries(subscription_id)
where subscription_id is not null;

alter table public.notification_deliveries
  enable row level security;



-- ============================================================
-- ATOMIC DELIVERY CLAIM
--
-- Prevents two overlapping cron executions from sending the
-- same notification simultaneously.
--
-- Failed deliveries may retry.
-- "processing" deliveries may retry only if they have been
-- stuck for at least 5 minutes.
-- ============================================================

create or replace function public.claim_notification_delivery(
  p_dedupe_key text,
  p_source_kind text,
  p_reminder_id uuid default null,
  p_outbox_id uuid default null,
  p_subscription_id uuid default null,
  p_channel text default 'email'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin

  insert into public.notification_deliveries (
    dedupe_key,
    source_kind,
    reminder_id,
    outbox_id,
    subscription_id,
    channel,
    status,
    attempt_count,
    last_attempt_at
  )
  values (
    p_dedupe_key,
    p_source_kind,
    p_reminder_id,
    p_outbox_id,
    p_subscription_id,
    p_channel,
    'processing',
    1,
    now()
  )

  on conflict (dedupe_key)
  do update
  set
    status = 'processing',
    attempt_count =
      public.notification_deliveries.attempt_count + 1,
    last_attempt_at = now(),
    last_error = null

  where
    public.notification_deliveries.status = 'failed'
    or (
      public.notification_deliveries.status = 'processing'
      and public.notification_deliveries.last_attempt_at
        < now() - interval '5 minutes'
    )

  returning id into v_id;

  return v_id;
end;
$$;


/*
 * Public clients must never be able to invoke the service-role
 * delivery claim helper directly.
 */
revoke all
on function public.claim_notification_delivery(
  text,
  text,
  uuid,
  uuid,
  uuid,
  text
)
from public;

revoke all
on function public.claim_notification_delivery(
  text,
  text,
  uuid,
  uuid,
  uuid,
  text
)
from anon;

revoke all
on function public.claim_notification_delivery(
  text,
  text,
  uuid,
  uuid,
  uuid,
  text
)
from authenticated;



-- ============================================================
-- EVENT PUBLICATION → FOLLOW OUTBOX
--
-- A newly published Event automatically becomes a notification
-- for followers of that Spot.
-- ============================================================

create or replace function public.queue_published_event_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_venue_name text;
begin

  /*
   * Only fire when an Event becomes published.
   */
  if new.status <> 'published' then
    return new;
  end if;

  if
    tg_op = 'UPDATE'
    and old.status = 'published'
  then
    return new;
  end if;

  select name
  into v_venue_name
  from public.venues
  where id = new.venue_id;

  insert into public.notification_outbox (
    notification_type,
    entity_kind,
    venue_id,
    event_id,
    title,
    message,
    url_path
  )
  values (
    'event_published',
    'venue',
    new.venue_id,
    new.id,
    new.title,
    coalesce(v_venue_name, 'A Spot')
      || ' added a new event: '
      || new.title,
    '/events'
  )

  on conflict do nothing;

  return new;
end;
$$;


drop trigger if exists
  events_queue_follow_notification
on public.events;


create trigger
  events_queue_follow_notification

after insert or update of status
on public.events

for each row

execute function
  public.queue_published_event_notification();
