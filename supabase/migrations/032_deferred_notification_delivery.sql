-- ============================================================
-- DEFERRED / EXPIRED NOTIFICATION DELIVERY
--
-- Delivery lifecycle:
--   processing = actively being sent
--   sent       = provider accepted delivery
--   failed     = provider/system failure, retryable
--   deferred   = intentionally waiting for a delivery channel
--   expired    = source is no longer relevant, never retry
--
-- Follow activity itself may also expire when tied to a
-- time-sensitive source such as a past/cancelled Event.
-- ============================================================


-- ============================================================
-- DELIVERY LEDGER STATUS
-- ============================================================

do $$
declare
  v_constraint text;
begin
  select c.conname
  into v_constraint
  from pg_constraint c
  where c.conrelid =
      'public.notification_deliveries'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%status%'
    and pg_get_constraintdef(c.oid) ilike '%processing%'
    and pg_get_constraintdef(c.oid) ilike '%sent%'
    and pg_get_constraintdef(c.oid) ilike '%failed%'
  limit 1;

  if v_constraint is not null then
    execute format(
      'alter table public.notification_deliveries drop constraint %I',
      v_constraint
    );
  end if;
end;
$$;

alter table public.notification_deliveries
  add constraint notification_deliveries_status_check
  check (
    status in (
      'processing',
      'sent',
      'failed',
      'deferred',
      'expired'
    )
  );

alter table public.notification_deliveries
  add column if not exists deferred_at timestamptz,
  add column if not exists expired_at timestamptz;

create index if not exists
  notification_deliveries_status_idx
on public.notification_deliveries(
  status,
  last_attempt_at
);


-- ============================================================
-- FOLLOW QUEUE STATUS
-- ============================================================

do $$
declare
  v_constraint text;
begin
  select c.conname
  into v_constraint
  from pg_constraint c
  where c.conrelid =
      'public.notification_events'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%status%'
    and pg_get_constraintdef(c.oid) ilike '%pending%'
    and pg_get_constraintdef(c.oid) ilike '%processing%'
    and pg_get_constraintdef(c.oid) ilike '%sent%'
    and pg_get_constraintdef(c.oid) ilike '%failed%'
  limit 1;

  if v_constraint is not null then
    execute format(
      'alter table public.notification_events drop constraint %I',
      v_constraint
    );
  end if;
end;
$$;

alter table public.notification_events
  add constraint notification_events_status_check
  check (
    status in (
      'pending',
      'processing',
      'sent',
      'failed',
      'expired'
    )
  );


-- ============================================================
-- REMINDER DELIVERY CLAIM
--
-- Deferred deliveries may be reclaimed once their channel
-- becomes available. Sent and expired deliveries never can.
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
    last_error = null,
    deferred_at = null

  where
    public.notification_deliveries.status in (
      'failed',
      'deferred'
    )
    or (
      public.notification_deliveries.status = 'processing'
      and public.notification_deliveries.last_attempt_at
        < now() - interval '5 minutes'
    )

  returning id into v_id;

  return v_id;
end;
$$;


-- ============================================================
-- FOLLOW DELIVERY CLAIM
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
    last_error = null,
    deferred_at = null

  where
    public.notification_deliveries.status in (
      'failed',
      'deferred'
    )
    or (
      public.notification_deliveries.status = 'processing'
      and public.notification_deliveries.last_attempt_at
        < now() - interval '5 minutes'
    )

  returning id into v_id;

  return v_id;
end;
$$;
