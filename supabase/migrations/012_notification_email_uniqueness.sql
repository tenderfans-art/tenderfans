-- TenderFans V1 notification duplicate protection.
-- Email uniqueness only for now; SMS constraints will be added when SMS is completed.

create unique index if not exists notification_subscriptions_unique_email_target
on public.notification_subscriptions (
  entity_kind,
  coalesce(bartender_id, venue_id),
  lower(email)
)
where email is not null;

create unique index if not exists event_reminders_unique_email_event_time
on public.event_reminders (
  event_id,
  reminder_minutes_before,
  lower(email)
)
where email is not null;
