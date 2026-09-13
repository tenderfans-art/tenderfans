import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import {
  outboundSmsEnabled,
  sendNotificationEmail,
  sendNotificationSms,
} from "@/lib/notificationDelivery";

const QUIET_WINDOW_MS = 5 * 60 * 1000;
const RETRY_DELAY_MS = 5 * 60 * 1000;

const QUIET_EVENT_TYPES = new Set([
  "spot.menu_updated",
  "spot.special_updated",
  "spot.photo_updated",
  "tender.profile_updated",
  "tender.photo_updated",
]);

type NotificationEvent = {
  id: string;
  entity_kind: "bartender" | "venue";
  bartender_id: string | null;
  venue_id: string | null;
  event_type: string;
  source_kind: string | null;
  source_id: string | null;
  metadata: Record<string, unknown> | null;
  status: string;
  attempts: number;
  available_at: string;
  created_at: string;
};

type Subscription = {
  id: string;
  entity_kind: "bartender" | "venue";
  bartender_id: string | null;
  venue_id: string | null;
  email: string | null;
  phone_e164: string | null;
  wants_email: boolean;
  wants_sms: boolean;
  email_verified: boolean;
  phone_verified: boolean;
  status: string;
  created_at: string;
};

type EventReminder = {
  id: string;
  event_id: string;
  email: string | null;
  phone_e164: string | null;
  wants_email: boolean;
  wants_sms: boolean;
  email_verified: boolean;
  phone_verified: boolean;
  reminder_minutes_before: number;
  status: string;
  reminder_sent_at: string | null;
};

function getAdminClient() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const secret =
    process.env.SUPABASE_SECRET_KEY;

  if (!url || !secret) {
    throw new Error(
      "Server Supabase credentials are not configured."
    );
  }

  return createClient(url, secret, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function safeError(error: unknown) {
  if (error instanceof Error) {
    return error.message.slice(0, 1000);
  }

  if (
    error &&
    typeof error === "object"
  ) {
    const value =
      error as Record<string, unknown>;

    const parts = [
      value.message,
      value.code
        ? `code=${value.code}`
        : null,
      value.details
        ? `details=${value.details}`
        : null,
      value.hint
        ? `hint=${value.hint}`
        : null,
    ].filter(Boolean);

    if (parts.length) {
      return parts
        .join(" | ")
        .slice(0, 1000);
    }

    try {
      return JSON.stringify(error)
        .slice(0, 1000);
    } catch {
      return "Unknown object error";
    }
  }

  return String(error).slice(0, 1000);
}

function metadataUuid(
  metadata: Record<string, unknown> | null,
  key: string
) {
  const value = metadata?.[key];

  return typeof value === "string" && value
    ? value
    : null;
}

async function loadBartender(
  admin: ReturnType<typeof getAdminClient>,
  id: string | null
) {
  if (!id) return null;

  const { data } = await admin
    .from("bartenders")
    .select("id, display_name, slug")
    .eq("id", id)
    .maybeSingle();

  return data ?? null;
}

async function loadVenue(
  admin: ReturnType<typeof getAdminClient>,
  id: string | null
) {
  if (!id) return null;

  const { data } = await admin
    .from("venues")
    .select("id, name, slug")
    .eq("id", id)
    .maybeSingle();

  return data ?? null;
}

async function buildFollowMessage(
  admin: ReturnType<typeof getAdminClient>,
  event: NotificationEvent
) {
  const bartender =
    event.bartender_id
      ? await loadBartender(
          admin,
          event.bartender_id
        )
      : null;

  const venue =
    event.venue_id
      ? await loadVenue(
          admin,
          event.venue_id
        )
      : null;

  switch (event.event_type) {
    case "spot.menu_updated":
      return {
        subject: `${venue?.name ?? "A TenderFans Spot"} updated its menu`,
        text:
          `${venue?.name ?? "A TenderFans Spot"} updated its menu on TenderFans.`,
        url:
          venue?.slug
            ? `/s/${venue.slug}`
            : "/discover",
      };

    case "spot.special_updated":
      return {
        subject: `${venue?.name ?? "A TenderFans Spot"} posted a new special`,
        text:
          `${venue?.name ?? "A TenderFans Spot"} posted a new special on TenderFans.`,
        url:
          venue?.slug
            ? `/s/${venue.slug}`
            : "/discover",
      };

    case "spot.photo_updated":
      return {
        subject: `${venue?.name ?? "A TenderFans Spot"} added new photos`,
        text:
          `${venue?.name ?? "A TenderFans Spot"} added new photos on TenderFans.`,
        url:
          venue?.slug
            ? `/s/${venue.slug}`
            : "/discover",
      };

    case "tender.profile_updated":
      return {
        subject: `${bartender?.display_name ?? "A Tender"} updated their profile`,
        text:
          `${bartender?.display_name ?? "A Tender"} updated their TenderFans profile.`,
        url:
          bartender?.slug
            ? `/t/${bartender.slug}`
            : "/discover",
      };

    case "tender.photo_updated":
      return {
        subject: `${bartender?.display_name ?? "A Tender"} added new photos`,
        text:
          `${bartender?.display_name ?? "A Tender"} added new photos on TenderFans.`,
        url:
          bartender?.slug
            ? `/t/${bartender.slug}`
            : "/discover",
      };

    case "spot.event_published": {
      const eventId =
        metadataUuid(
          event.metadata,
          "event_id"
        ) ||
        event.source_id;

      let eventTitle: string | null = null;

      if (eventId) {
        const { data } = await admin
          .from("events")
          .select("title")
          .eq("id", eventId)
          .maybeSingle();

        eventTitle = data?.title ?? null;
      }

      return {
        subject:
          eventTitle
            ? `${venue?.name ?? "A TenderFans Spot"} posted ${eventTitle}`
            : `${venue?.name ?? "A TenderFans Spot"} posted a new event`,
        text:
          eventTitle
            ? `${venue?.name ?? "A TenderFans Spot"} posted a new event: ${eventTitle}.`
            : `${venue?.name ?? "A TenderFans Spot"} posted a new event on TenderFans.`,
        url: "/events",
      };
    }

    case "spot.tender_added": {
      const relatedBartender =
        await loadBartender(
          admin,
          metadataUuid(
            event.metadata,
            "bartender_id"
          )
        );

      return {
        subject:
          `${relatedBartender?.display_name ?? "A Tender"} joined ${venue?.name ?? "a TenderFans Spot"}`,
        text:
          `${relatedBartender?.display_name ?? "A Tender"} is now tending at ${venue?.name ?? "a TenderFans Spot"}.`,
        url:
          venue?.slug
            ? `/s/${venue.slug}`
            : "/discover",
      };
    }

    case "spot.tender_removed": {
      const relatedBartender =
        await loadBartender(
          admin,
          metadataUuid(
            event.metadata,
            "bartender_id"
          )
        );

      return {
        subject:
          `${relatedBartender?.display_name ?? "A Tender"} left ${venue?.name ?? "a TenderFans Spot"}`,
        text:
          `${relatedBartender?.display_name ?? "A Tender"} is no longer listed at ${venue?.name ?? "that TenderFans Spot"}.`,
        url:
          venue?.slug
            ? `/s/${venue.slug}`
            : "/discover",
      };
    }

    case "tender.spot_added": {
      const relatedVenue =
        await loadVenue(
          admin,
          metadataUuid(
            event.metadata,
            "venue_id"
          )
        );

      return {
        subject:
          `${bartender?.display_name ?? "A Tender"} joined ${relatedVenue?.name ?? "a new Spot"}`,
        text:
          `${bartender?.display_name ?? "A Tender"} is now tending at ${relatedVenue?.name ?? "a new Spot"}.`,
        url:
          bartender?.slug
            ? `/t/${bartender.slug}`
            : "/discover",
      };
    }

    case "tender.spot_removed": {
      const relatedVenue =
        await loadVenue(
          admin,
          metadataUuid(
            event.metadata,
            "venue_id"
          )
        );

      return {
        subject:
          `${bartender?.display_name ?? "A Tender"} changed Spots`,
        text:
          `${bartender?.display_name ?? "A Tender"} is no longer listed at ${relatedVenue?.name ?? "their previous Spot"}.`,
        url:
          bartender?.slug
            ? `/t/${bartender.slug}`
            : "/discover",
      };
    }

    default:
      return {
        subject: "New activity on TenderFans",
        text: "There's new activity from something you follow on TenderFans.",
        url: "/discover",
      };
  }
}

async function claimFollowDelivery(
  admin: ReturnType<typeof getAdminClient>,
  input: {
    dedupeKey: string;
    eventId: string;
    subscriptionId: string;
    channel: "email" | "sms";
  }
) {
  const { data, error } = await admin.rpc(
    "claim_follow_notification_delivery",
    {
      p_dedupe_key: input.dedupeKey,
      p_notification_event_id:
        input.eventId,
      p_subscription_id:
        input.subscriptionId,
      p_channel: input.channel,
    }
  );

  if (error) {
    throw error;
  }

  return typeof data === "string"
    ? data
    : null;
}

async function claimReminderDelivery(
  admin: ReturnType<typeof getAdminClient>,
  input: {
    dedupeKey: string;
    reminderId: string;
    channel: "email" | "sms";
  }
) {
  const { data, error } = await admin.rpc(
    "claim_notification_delivery",
    {
      p_dedupe_key: input.dedupeKey,
      p_source_kind: "reminder",
      p_reminder_id: input.reminderId,
      p_outbox_id: null,
      p_subscription_id: null,
      p_channel: input.channel,
    }
  );

  if (error) {
    throw error;
  }

  return typeof data === "string"
    ? data
    : null;
}

async function markDeliverySent(
  admin: ReturnType<typeof getAdminClient>,
  deliveryId: string,
  providerReference: string | null
) {
  const { error } = await admin
    .from("notification_deliveries")
    .update({
      status: "sent",
      provider_reference:
        providerReference,
      sent_at:
        new Date().toISOString(),
      last_error: null,
    })
    .eq("id", deliveryId);

  if (error) {
    throw error;
  }
}

async function markDeliveryFailed(
  admin: ReturnType<typeof getAdminClient>,
  deliveryId: string,
  error: unknown
) {
  await admin
    .from("notification_deliveries")
    .update({
      status: "failed",
      last_error: safeError(error),
    })
    .eq("id", deliveryId);
}

async function deliveryRetryReady(
  admin: ReturnType<typeof getAdminClient>,
  dedupeKey: string
) {
  const { data, error } = await admin
    .from("notification_deliveries")
    .select("status, last_attempt_at")
    .eq("dedupe_key", dedupeKey)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return true;
  }

  if (
    data.status === "sent" ||
    data.status === "expired"
  ) {
    return false;
  }

  if (data.status === "deferred") {
    return true;
  }

  const lastAttempt =
    data.last_attempt_at
      ? new Date(data.last_attempt_at).getTime()
      : 0;

  if (
    lastAttempt &&
    Date.now() - lastAttempt <
      RETRY_DELAY_MS
  ) {
    return false;
  }

  return true;
}

async function ensureDeferredSmsDelivery(
  admin: ReturnType<typeof getAdminClient>,
  input: {
    dedupeKey: string;
    sourceKind: "follow" | "reminder";
    notificationEventId?: string | null;
    reminderId?: string | null;
    subscriptionId?: string | null;
  }
) {
  const { data: existing, error } =
    await admin
      .from("notification_deliveries")
      .select(
        "id, status, last_attempt_at"
      )
      .eq("dedupe_key", input.dedupeKey)
      .maybeSingle();

  if (error) {
    throw error;
  }

  if (existing) {
    if (
      existing.status === "sent" ||
      existing.status === "expired" ||
      existing.status === "deferred"
    ) {
      return existing.status;
    }

    if (
      existing.status === "processing"
    ) {
      const lastAttempt =
        existing.last_attempt_at
          ? new Date(
              existing.last_attempt_at
            ).getTime()
          : 0;

      if (
        lastAttempt &&
        Date.now() - lastAttempt <
          RETRY_DELAY_MS
      ) {
        return "processing";
      }
    }

    const { error: updateError } =
      await admin
        .from("notification_deliveries")
        .update({
          status: "deferred",
          deferred_at:
            new Date().toISOString(),
          last_error: null,
        })
        .eq("id", existing.id);

    if (updateError) {
      throw updateError;
    }

    return "deferred";
  }

  const now =
    new Date().toISOString();

  const { error: insertError } =
    await admin
      .from("notification_deliveries")
      .insert({
        dedupe_key: input.dedupeKey,
        source_kind: input.sourceKind,
        reminder_id:
          input.reminderId ?? null,
        outbox_id: null,
        notification_event_id:
          input.notificationEventId ?? null,
        subscription_id:
          input.subscriptionId ?? null,
        channel: "sms",
        status: "deferred",
        attempt_count: 1,
        last_attempt_at: now,
        deferred_at: now,
      });

  if (insertError) {
    throw insertError;
  }

  return "deferred";
}

async function expireFollowDeliveries(
  admin: ReturnType<typeof getAdminClient>,
  eventIds: string[],
  reason: string
) {
  if (!eventIds.length) return;

  await admin
    .from("notification_deliveries")
    .update({
      status: "expired",
      expired_at:
        new Date().toISOString(),
      last_error: reason,
    })
    .in(
      "notification_event_id",
      eventIds
    )
    .in(
      "status",
      [
        "processing",
        "failed",
        "deferred",
      ]
    );
}

async function expireReminderDeliveries(
  admin: ReturnType<typeof getAdminClient>,
  reminderId: string,
  reason: string
) {
  await admin
    .from("notification_deliveries")
    .update({
      status: "expired",
      expired_at:
        new Date().toISOString(),
      last_error: reason,
    })
    .eq("reminder_id", reminderId)
    .in(
      "status",
      [
        "processing",
        "failed",
        "deferred",
      ]
    );
}

async function followEventStillRelevant(
  admin: ReturnType<typeof getAdminClient>,
  event: NotificationEvent
) {
  /*
   * Ordinary Tender/Spot activity has no expiration.
   * Published Event notifications do.
   */
  if (
    event.event_type !==
    "spot.event_published"
  ) {
    return true;
  }

  const sourceEventId =
    metadataUuid(
      event.metadata,
      "event_id"
    ) ||
    event.source_id;

  if (!sourceEventId) {
    return false;
  }

  const { data, error } =
    await admin
      .from("events")
      .select(
        "id, status, starts_at"
      )
      .eq("id", sourceEventId)
      .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return false;
  }

  const startsAt =
    new Date(
      data.starts_at
    ).getTime();

  return (
    data.status === "published" &&
    Number.isFinite(startsAt) &&
    startsAt > Date.now()
  );
}

async function loadSubscriptions(
  admin: ReturnType<typeof getAdminClient>,
  event: NotificationEvent,
  eligibleAt: string
) {
  let query = admin
    .from("notification_subscriptions")
    .select(`
      id,
      entity_kind,
      bartender_id,
      venue_id,
      email,
      phone_e164,
      wants_email,
      wants_sms,
      email_verified,
      phone_verified,
      status,
      created_at
    `)
    .eq("status", "active")
    .eq(
      "entity_kind",
      event.entity_kind
    )
    /*
     * Never notify someone about activity
     * that predates their Follow.
     *
     * For a five-minute batch, eligibleAt is
     * the newest activity in that batch.
     */
    .lte("created_at", eligibleAt);

  query =
    event.entity_kind === "bartender"
      ? query.eq(
          "bartender_id",
          event.bartender_id
        )
      : query.eq(
          "venue_id",
          event.venue_id
        );

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return (data ?? []) as Subscription[];
}

async function processFollowBatch(
  admin: ReturnType<typeof getAdminClient>,
  events: NotificationEvent[],
  dryRun: boolean
) {
  const leader = events[0];

  if (!leader) {
    return {
      sent: 0,
      failed: 0,
      skipped: 0,
      deferred: 0,
      expired: 0,
    };
  }

  const ids =
    events.map(
      (event) => event.id
    );

  const relevant =
    await followEventStillRelevant(
      admin,
      leader
    );

  if (!relevant) {
    if (!dryRun) {
      const now =
        new Date().toISOString();

      await admin
        .from("notification_events")
        .update({
          status: "expired",
          processed_at: now,
          last_error:
            "Notification source is no longer active.",
        })
        .in("id", ids);

      await expireFollowDeliveries(
        admin,
        ids,
        "Notification source is no longer active."
      );
    }

    return {
      sent: 0,
      failed: 0,
      skipped: 0,
      deferred: 0,
      expired: events.length,
      preview: dryRun
        ? {
            expired: true,
            reason:
              "Notification source is no longer active.",
          }
        : undefined,
    };
  }

  /*
   * For a quiet batch, a follower is eligible if
   * they were following by the time the newest
   * activity in the batch happened.
   */
  const eligibleAt =
    events.reduce(
      (latest, event) =>
        new Date(event.created_at) >
        new Date(latest)
          ? event.created_at
          : latest,
      leader.created_at
    );

  const subscriptions =
    await loadSubscriptions(
      admin,
      leader,
      eligibleAt
    );

  const message =
    await buildFollowMessage(
      admin,
      leader
    );

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let deferred = 0;

  if (dryRun) {
    for (
      const subscription
      of subscriptions
    ) {
      if (
        subscription.wants_email &&
        subscription.email_verified &&
        subscription.email
      ) {
        sent += 1;
      }

      if (
        subscription.wants_sms &&
        subscription.phone_verified &&
        subscription.phone_e164
      ) {
        if (outboundSmsEnabled()) {
          sent += 1;
        } else {
          deferred += 1;
        }
      }
    }

    return {
      sent,
      failed,
      skipped,
      deferred,
      expired: 0,
      preview: message,
    };
  }

  await admin
    .from("notification_events")
    .update({
      status: "processing",
      attempts:
        Math.max(
          ...events.map(
            (event) =>
              event.attempts
          )
        ) + 1,
      last_error: null,
    })
    .in("id", ids);

  for (
    const subscription
    of subscriptions
  ) {
    if (
      subscription.wants_email &&
      subscription.email_verified &&
      subscription.email
    ) {
      const dedupeKey =
        `follow:${leader.id}:` +
        `${subscription.id}:email`;

      let deliveryId:
        string | null = null;

      try {
        const ready =
          await deliveryRetryReady(
            admin,
            dedupeKey
          );

        if (!ready) {
          skipped += 1;
        } else {
          deliveryId =
            await claimFollowDelivery(
              admin,
              {
                dedupeKey,
                eventId: leader.id,
                subscriptionId:
                  subscription.id,
                channel: "email",
              }
            );

          if (!deliveryId) {
            skipped += 1;
          } else {
            const result =
              await sendNotificationEmail({
                to:
                  subscription.email,
                subject:
                  message.subject,
                text:
                  message.text,
                url:
                  message.url,
              });

            await markDeliverySent(
              admin,
              deliveryId,
              result.providerReference
            );

            sent += 1;
          }
        }
      } catch (error) {
        failed += 1;

        if (deliveryId) {
          await markDeliveryFailed(
            admin,
            deliveryId,
            error
          );
        }
      }
    }

    if (
      subscription.wants_sms &&
      subscription.phone_verified &&
      subscription.phone_e164
    ) {
      const dedupeKey =
        `follow:${leader.id}:` +
        `${subscription.id}:sms`;

      if (!outboundSmsEnabled()) {
        try {
          const state =
            await ensureDeferredSmsDelivery(
              admin,
              {
                dedupeKey,
                sourceKind:
                  "follow",
                notificationEventId:
                  leader.id,
                subscriptionId:
                  subscription.id,
              }
            );

          if (state === "deferred") {
            deferred += 1;
          } else {
            skipped += 1;
          }
        } catch (error) {
          failed += 1;
        }

        continue;
      }

      let deliveryId:
        string | null = null;

      try {
        const ready =
          await deliveryRetryReady(
            admin,
            dedupeKey
          );

        if (!ready) {
          skipped += 1;
        } else {
          deliveryId =
            await claimFollowDelivery(
              admin,
              {
                dedupeKey,
                eventId:
                  leader.id,
                subscriptionId:
                  subscription.id,
                channel: "sms",
              }
            );

          if (!deliveryId) {
            skipped += 1;
          } else {
            const result =
              await sendNotificationSms({
                to:
                  subscription.phone_e164,
                text:
                  message.text,
                url:
                  message.url,
              });

            await markDeliverySent(
              admin,
              deliveryId,
              result.providerReference
            );

            sent += 1;
          }
        }
      } catch (error) {
        failed += 1;

        if (deliveryId) {
          await markDeliveryFailed(
            admin,
            deliveryId,
            error
          );
        }
      }
    }
  }

  const now = new Date();

  /*
   * A Follow queue item may close once every
   * immediately deliverable channel has either
   * sent or been safely captured as deferred.
   *
   * Deferred SMS lives independently in the
   * delivery ledger and will be picked up later.
   */
  if (failed === 0) {
    await admin
      .from("notification_events")
      .update({
        status: "sent",
        processed_at:
          now.toISOString(),
        last_error: null,
      })
      .in("id", ids);
  } else {
    await admin
      .from("notification_events")
      .update({
        status: "failed",
        available_at:
          new Date(
            now.getTime() +
            RETRY_DELAY_MS
          ).toISOString(),
        last_error:
          `${failed} notification delivery attempt(s) failed.`,
      })
      .in("id", ids);
  }

  return {
    sent,
    failed,
    skipped,
    deferred,
    expired: 0,
  };
}

async function processDeferredFollowSms(
  admin: ReturnType<typeof getAdminClient>,
  dryRun: boolean
) {
  const retryBefore =
    new Date(
      Date.now() -
      RETRY_DELAY_MS
    ).toISOString();

  const { data, error } =
    await admin
      .from("notification_deliveries")
      .select(`
        id,
        dedupe_key,
        notification_event_id,
        subscription_id,
        status,
        last_attempt_at
      `)
      .eq("source_kind", "follow")
      .eq("channel", "sms")
      .in(
        "status",
        ["deferred", "failed"]
      )
      .limit(250);

  if (error) {
    throw error;
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let deferred = 0;
  let expired = 0;

  for (const delivery of data ?? []) {
    if (
      !delivery.notification_event_id ||
      !delivery.subscription_id
    ) {
      continue;
    }

    /*
     * Failed provider attempts wait five minutes.
     * Deferred rows can send immediately once SMS
     * becomes available.
     */
    if (
      delivery.status === "failed" &&
      delivery.last_attempt_at &&
      delivery.last_attempt_at >
        retryBefore
    ) {
      skipped += 1;
      continue;
    }

    const {
      data: event,
      error: eventError,
    } = await admin
      .from("notification_events")
      .select(`
        id,
        entity_kind,
        bartender_id,
        venue_id,
        event_type,
        source_kind,
        source_id,
        metadata,
        status,
        attempts,
        available_at,
        created_at
      `)
      .eq(
        "id",
        delivery.notification_event_id
      )
      .maybeSingle();

    if (eventError) {
      throw eventError;
    }

    if (!event) {
      if (!dryRun) {
        await admin
          .from(
            "notification_deliveries"
          )
          .update({
            status: "expired",
            expired_at:
              new Date().toISOString(),
            last_error:
              "Follow notification source no longer exists.",
          })
          .eq("id", delivery.id);
      }

      expired += 1;
      continue;
    }

    /*
     * If the original queue item is still failed or
     * processing, that queue owns the retry.
     */
    if (
      event.status !== "sent" &&
      event.status !== "expired"
    ) {
      skipped += 1;
      continue;
    }

    const relevant =
      event.status !== "expired" &&
      await followEventStillRelevant(
        admin,
        event as NotificationEvent
      );

    if (!relevant) {
      if (!dryRun) {
        await admin
          .from(
            "notification_deliveries"
          )
          .update({
            status: "expired",
            expired_at:
              new Date().toISOString(),
            last_error:
              "Notification source is no longer active.",
          })
          .eq("id", delivery.id);
      }

      expired += 1;
      continue;
    }

    const {
      data: subscription,
      error: subscriptionError,
    } = await admin
      .from(
        "notification_subscriptions"
      )
      .select(`
        id,
        phone_e164,
        wants_sms,
        phone_verified,
        status
      `)
      .eq(
        "id",
        delivery.subscription_id
      )
      .maybeSingle();

    if (subscriptionError) {
      throw subscriptionError;
    }

    /*
     * Unsubscribed / invalid destinations should
     * never receive delayed messages.
     */
    if (
      !subscription ||
      subscription.status !== "active" ||
      !subscription.wants_sms ||
      !subscription.phone_verified ||
      !subscription.phone_e164
    ) {
      if (!dryRun) {
        await admin
          .from(
            "notification_deliveries"
          )
          .update({
            status: "expired",
            expired_at:
              new Date().toISOString(),
            last_error:
              "Subscription is no longer eligible for SMS.",
          })
          .eq("id", delivery.id);
      }

      expired += 1;
      continue;
    }

    if (!outboundSmsEnabled()) {
      deferred += 1;
      continue;
    }

    const message =
      await buildFollowMessage(
        admin,
        event as NotificationEvent
      );

    if (dryRun) {
      sent += 1;
      continue;
    }

    let deliveryId:
      string | null = null;

    try {
      deliveryId =
        await claimFollowDelivery(
          admin,
          {
            dedupeKey:
              delivery.dedupe_key,
            eventId:
              event.id,
            subscriptionId:
              subscription.id,
            channel: "sms",
          }
        );

      if (!deliveryId) {
        skipped += 1;
        continue;
      }

      const result =
        await sendNotificationSms({
          to:
            subscription.phone_e164,
          text:
            message.text,
          url:
            message.url,
        });

      await markDeliverySent(
        admin,
        deliveryId,
        result.providerReference
      );

      sent += 1;
    } catch (error) {
      failed += 1;

      if (deliveryId) {
        await markDeliveryFailed(
          admin,
          deliveryId,
          error
        );
      }
    }
  }

  return {
    backlog:
      (data ?? []).length,
    sent,
    failed,
    skipped,
    deferred,
    expired,
  };
}

async function processFollowEvents(
  admin: ReturnType<typeof getAdminClient>,
  dryRun: boolean
) {
  const now = Date.now();

  const { data, error } = await admin
    .from("notification_events")
    .select(`
      id,
      entity_kind,
      bartender_id,
      venue_id,
      event_type,
      source_kind,
      source_id,
      metadata,
      status,
      attempts,
      available_at,
      created_at
    `)
    .in(
      "status",
      ["pending", "failed"]
    )
    .lte(
      "available_at",
      new Date(now).toISOString()
    )
    .order(
      "created_at",
      { ascending: true }
    )
    .limit(250);

  if (error) {
    throw error;
  }

  const rows =
    (data ?? []) as NotificationEvent[];

  const immediate:
    NotificationEvent[] = [];

  const quietGroups =
    new Map<
      string,
      NotificationEvent[]
    >();

  for (const event of rows) {
    if (
      !QUIET_EVENT_TYPES.has(
        event.event_type
      )
    ) {
      immediate.push(event);
      continue;
    }

    const entityId =
      event.entity_kind === "bartender"
        ? event.bartender_id
        : event.venue_id;

    const key =
      `${event.entity_kind}:` +
      `${entityId}:` +
      `${event.event_type}`;

    const group =
      quietGroups.get(key) ?? [];

    group.push(event);

    quietGroups.set(
      key,
      group
    );
  }

  const batches:
    NotificationEvent[][] =
      immediate.map(
        (event) => [event]
      );

  for (
    const group
    of quietGroups.values()
  ) {
    const newest =
      Math.max(
        ...group.map(
          (event) =>
            new Date(
              event.created_at
            ).getTime()
        )
      );

    if (
      now - newest >=
      QUIET_WINDOW_MS
    ) {
      batches.push(group);
    }
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let deferred = 0;
  let expired = 0;

  const previews:
    unknown[] = [];

  for (const batch of batches) {
    const result =
      await processFollowBatch(
        admin,
        batch,
        dryRun
      );

    sent += result.sent;
    failed += result.failed;
    skipped += result.skipped;
    deferred += result.deferred;
    expired += result.expired;

    if (
      dryRun &&
      "preview" in result
    ) {
      previews.push({
        eventIds:
          batch.map(
            (event) => event.id
          ),
        eventType:
          batch[0]?.event_type,
        sendNow:
          result.sent,
        defer:
          result.deferred,
        expired:
          result.expired,
        message:
          result.preview,
      });
    }
  }

  const deferredSms =
    await processDeferredFollowSms(
      admin,
      dryRun
    );

  return {
    queueRows: rows.length,
    batches: batches.length,
    sent,
    failed,
    skipped,
    deferred,
    expired,
    deferredSms,
    previews,
  };
}

async function processReminders(
  admin: ReturnType<typeof getAdminClient>,
  dryRun: boolean
) {
  const now = Date.now();

  const { data, error } =
    await admin
      .from("event_reminders")
      .select(`
        id,
        event_id,
        email,
        phone_e164,
        wants_email,
        wants_sms,
        email_verified,
        phone_verified,
        reminder_minutes_before,
        status,
        reminder_sent_at
      `)
      .eq("status", "active")
      .is(
        "reminder_sent_at",
        null
      )
      .limit(500);

  if (error) {
    throw error;
  }

  const reminders =
    (data ?? []) as EventReminder[];

  if (!reminders.length) {
    return {
      active: 0,
      due: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      deferred: 0,
      expired: 0,
      previews: [],
    };
  }

  const eventIds = [
    ...new Set(
      reminders.map(
        (reminder) =>
          reminder.event_id
      )
    ),
  ];

  const {
    data: events,
    error: eventError,
  } = await admin
    .from("events")
    .select(`
      id,
      title,
      starts_at,
      status,
      venue_id
    `)
    .in("id", eventIds);

  if (eventError) {
    throw eventError;
  }

  const venueIds = [
    ...new Set(
      (events ?? [])
        .map(
          (event) =>
            event.venue_id
        )
        .filter(Boolean)
    ),
  ];

  const { data: venues } =
    venueIds.length
      ? await admin
          .from("venues")
          .select(
            "id, name, slug"
          )
          .in("id", venueIds)
      : { data: [] };

  const eventMap =
    new Map(
      (events ?? []).map(
        (event) => [
          event.id,
          event,
        ]
      )
    );

  const venueMap =
    new Map(
      (venues ?? []).map(
        (venue) => [
          venue.id,
          venue,
        ]
      )
    );

  let due = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let deferred = 0;
  let expired = 0;

  const previews:
    unknown[] = [];

  for (
    const reminder
    of reminders
  ) {
    const event =
      eventMap.get(
        reminder.event_id
      );

    /*
     * A deleted source should normally cascade-delete
     * the reminder, but if we ever encounter a missing
     * source, don't leave the reminder hanging forever.
     */
    if (!event) {
      if (!dryRun) {
        await expireReminderDeliveries(
          admin,
          reminder.id,
          "Event no longer exists."
        );

        await admin
          .from("event_reminders")
          .update({
            status: "cancelled",
            updated_at:
              new Date().toISOString(),
          })
          .eq("id", reminder.id);
      }

      expired += 1;
      continue;
    }

    const startsAt =
      new Date(
        event.starts_at
      ).getTime();

    const stillRelevant =
      Number.isFinite(startsAt) &&
      startsAt > now &&
      event.status === "published";

    /*
     * Stuck reminders always re-check their Event.
     * Never send a late reminder.
     */
    if (!stillRelevant) {
      if (!dryRun) {
        await expireReminderDeliveries(
          admin,
          reminder.id,
          "Event is no longer active or has already started."
        );

        await admin
          .from("event_reminders")
          .update({
            status: "cancelled",
            updated_at:
              new Date().toISOString(),
          })
          .eq("id", reminder.id);
      }

      expired += 1;
      continue;
    }

    const reminderAt =
      startsAt -
      reminder.reminder_minutes_before *
        60 *
        1000;

    if (reminderAt > now) {
      continue;
    }

    due += 1;

    const venue =
      venueMap.get(
        event.venue_id
      );

    const text =
      `${event.title} at ` +
      `${venue?.name ?? "a TenderFans Spot"} ` +
      `starts ${
        reminder.reminder_minutes_before ===
        1440
          ? "tomorrow"
          : reminder.reminder_minutes_before ===
              180
            ? "in 3 hours"
            : "in 1 hour"
      }.`;

    const url = "/events";

    /*
     * Only verified channels are required for
     * completion. Email and SMS remain independent.
     */
    const requiresEmail =
      Boolean(
        reminder.wants_email &&
        reminder.email_verified &&
        reminder.email
      );

    const requiresSms =
      Boolean(
        reminder.wants_sms &&
        reminder.phone_verified &&
        reminder.phone_e164
      );

    if (dryRun) {
      const channels:
        string[] = [];

      if (requiresEmail) {
        channels.push("email");
        sent += 1;
      }

      if (requiresSms) {
        if (outboundSmsEnabled()) {
          channels.push("sms");
          sent += 1;
        } else {
          channels.push(
            "sms-deferred"
          );
          deferred += 1;
        }
      }

      previews.push({
        reminderId:
          reminder.id,
        event:
          event.title,
        channels,
        text,
      });

      continue;
    }

    if (
      !requiresEmail &&
      !requiresSms
    ) {
      skipped += 1;
      continue;
    }

    if (
      requiresEmail &&
      reminder.email
    ) {
      const dedupeKey =
        `reminder:${reminder.id}:email`;

      let deliveryId:
        string | null = null;

      try {
        const ready =
          await deliveryRetryReady(
            admin,
            dedupeKey
          );

        if (!ready) {
          skipped += 1;
        } else {
          deliveryId =
            await claimReminderDelivery(
              admin,
              {
                dedupeKey,
                reminderId:
                  reminder.id,
                channel:
                  "email",
              }
            );

          if (!deliveryId) {
            skipped += 1;
          } else {
            const result =
              await sendNotificationEmail({
                to:
                  reminder.email,
                subject:
                  `Reminder: ${event.title}`,
                text,
                url,
              });

            await markDeliverySent(
              admin,
              deliveryId,
              result.providerReference
            );

            sent += 1;
          }
        }
      } catch (error) {
        failed += 1;

        if (deliveryId) {
          await markDeliveryFailed(
            admin,
            deliveryId,
            error
          );
        }
      }
    }

    if (
      requiresSms &&
      reminder.phone_e164
    ) {
      const dedupeKey =
        `reminder:${reminder.id}:sms`;

      if (!outboundSmsEnabled()) {
        try {
          const state =
            await ensureDeferredSmsDelivery(
              admin,
              {
                dedupeKey,
                sourceKind:
                  "reminder",
                reminderId:
                  reminder.id,
              }
            );

          if (state === "deferred") {
            deferred += 1;
          } else {
            skipped += 1;
          }
        } catch (error) {
          failed += 1;
        }
      } else {
        let deliveryId:
          string | null = null;

        try {
          const ready =
            await deliveryRetryReady(
              admin,
              dedupeKey
            );

          if (!ready) {
            skipped += 1;
          } else {
            deliveryId =
              await claimReminderDelivery(
                admin,
                {
                  dedupeKey,
                  reminderId:
                    reminder.id,
                  channel:
                    "sms",
                }
              );

            if (!deliveryId) {
              skipped += 1;
            } else {
              const result =
                await sendNotificationSms({
                  to:
                    reminder.phone_e164,
                  text,
                  url,
                });

              await markDeliverySent(
                admin,
                deliveryId,
                result.providerReference
              );

              sent += 1;
            }
          }
        } catch (error) {
          failed += 1;

          if (deliveryId) {
            await markDeliveryFailed(
              admin,
              deliveryId,
              error
            );
          }
        }
      }
    }

    /*
     * Completion is based on actual ledger status,
     * not merely on which channels happened to be
     * enabled during this worker run.
     */
    const {
      data: deliveryRows,
      error: deliveryError,
    } = await admin
      .from(
        "notification_deliveries"
      )
      .select(
        "channel, status"
      )
      .eq(
        "reminder_id",
        reminder.id
      );

    if (deliveryError) {
      throw deliveryError;
    }

    const statusByChannel =
      new Map(
        (deliveryRows ?? []).map(
          (row) => [
            row.channel,
            row.status,
          ]
        )
      );

    const emailComplete =
      !requiresEmail ||
      statusByChannel.get(
        "email"
      ) === "sent";

    const smsComplete =
      !requiresSms ||
      statusByChannel.get(
        "sms"
      ) === "sent";

    if (
      emailComplete &&
      smsComplete
    ) {
      const completedAt =
        new Date().toISOString();

      await admin
        .from("event_reminders")
        .update({
          status: "sent",
          reminder_sent_at:
            completedAt,
          updated_at:
            completedAt,
        })
        .eq("id", reminder.id);
    }
  }

  return {
    active:
      reminders.length,
    due,
    sent,
    failed,
    skipped,
    deferred,
    expired,
    previews,
  };
}

export async function POST(
  request: NextRequest
) {
  const expectedSecret =
    process.env.NOTIFICATION_JOB_SECRET;

  if (!expectedSecret) {
    return NextResponse.json(
      {
        error:
          "Notification job secret is not configured.",
      },
      { status: 500 }
    );
  }

  const auth =
    request.headers.get(
      "authorization"
    );

  if (
    auth !==
    `Bearer ${expectedSecret}`
  ) {
    return NextResponse.json(
      { error: "Unauthorized." },
      { status: 401 }
    );
  }

  let dryRun = false;

  try {
    const body =
      await request.json();

    dryRun =
      body?.dryRun === true;
  } catch {
    /*
     * Empty POST body is valid for cron.
     */
  }

  async function runProcessors() {
    const admin =
      getAdminClient();

    const [
      follow,
      reminders,
    ] = await Promise.all([
      processFollowEvents(
        admin,
        dryRun
      ),
      processReminders(
        admin,
        dryRun
      ),
    ]);

    return {
      follow,
      reminders,
    };
  }

  function isTransientJobError(
    error: unknown
  ) {
    const message =
      safeError(error).toLowerCase();

    return (
      message.includes(
        "gateway timeout"
      ) ||
      message.includes(
        "bad gateway"
      ) ||
      message.includes(
        "service unavailable"
      ) ||
      message.includes(
        "upstream"
      )
    );
  }

  try {
    let result;

    try {
      result =
        await runProcessors();
    } catch (error) {
      if (
        !isTransientJobError(
          error
        )
      ) {
        throw error;
      }

      console.warn(
        "Notification job transient failure; retrying once:",
        safeError(error)
      );

      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            1500
          )
      );

      result =
        await runProcessors();
    }

    return NextResponse.json({
      ok: true,
      dryRun,
      outboundSmsEnabled:
        outboundSmsEnabled(),
      follow:
        result.follow,
      reminders:
        result.reminders,
    });
  } catch (error) {
    console.error(
      "Notification job failed:",
      error
    );

    return NextResponse.json(
      {
        ok: false,
        error:
          safeError(error),
      },
      { status: 500 }
    );
  }
}
