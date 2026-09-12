-- ============================================================
-- DISABLE REDUNDANT EVENT OUTBOX PRODUCER
--
-- Migration 009/010 already uses notification_events as the
-- canonical Follow activity queue.
--
-- Migration 029 temporarily added a second event-publication
-- producer targeting notification_outbox.
--
-- Keep the 029 tables intact for now, but stop producing
-- duplicate event-publication queue records.
-- ============================================================

drop trigger if exists
  events_queue_follow_notification
on public.events;
