-- ============================================================
-- FOLLOW DELIVERY LEDGER LINK
--
-- notification_events is the canonical Follow activity queue.
-- Extend the delivery ledger so each Follow delivery can point
-- directly to the notification event that produced it.
--
-- Reminder delivery continues using claim_notification_delivery().
-- Follow delivery uses claim_follow_notification_delivery().
-- ============================================================


alter table public.notification_deliveries
  add column if not exists notification_event_id uuid
    references public.notification_events(id)
    on delete cascade;


create index if not exists
  notification_deliveries_notification_event_idx
on public.notification_deliveries(notification_event_id)
where notification_event_id is not null;


-- ============================================================
-- ATOMIC FOLLOW DELIVERY CLAIM
--
-- Returns a delivery ID only when this worker successfully
-- claims the recipient/channel combination.
--
-- Previously sent rows cannot be reclaimed.
-- Failed rows may retry.
-- Processing rows may retry after being stuck for 5 minutes.
-- ============================================================

create or replace function public.claim_follow_notification_delivery(
  p_dedupe_key text,
  p_notification_event_id uuid,
  p_subscription_id uuid,
  p_channel text
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
    notification_event_id,
    subscription_id,
    channel,
    status,
    attempt_count,
    last_attempt_at
  )
  values (
    p_dedupe_key,
    'follow',
    p_notification_event_id,
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


revoke all
on function public.claim_follow_notification_delivery(
  text,
  uuid,
  uuid,
  text
)
from public;

revoke all
on function public.claim_follow_notification_delivery(
  text,
  uuid,
  uuid,
  text
)
from anon;

revoke all
on function public.claim_follow_notification_delivery(
  text,
  uuid,
  uuid,
  text
)
from authenticated;
