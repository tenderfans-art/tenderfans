import { recoveryFetch } from "@/lib/event-harvester/recovery-fetch";
import type {
  FirstPartyHarvestEvent,
} from "./types";

const USER_AGENT =
  "TenderFans Event Harvester/1.0";

type SociableKitEvent = {
  timezone?: unknown;
  event_timezone?: unknown;
  start_timestamp?: unknown;
  fb_page_id?: unknown;

  start_date_raw?: unknown;
  start_time_raw?: unknown;
  event_start_utc?: unknown;

  end_date_raw?: unknown;
  end_time_raw?: unknown;
  event_end_utc?: unknown;

  event_id?: unknown;
  event_time_id?: unknown;

  name?: unknown;
  description?: unknown;

  location?: unknown;
  location_text?: unknown;
  event_venue?: unknown;
  event_lati?: unknown;
  event_longi?: unknown;

  html_link?: unknown;
  image?: unknown;
  thumbnail_url?: unknown;
  video_url?: unknown;

  is_online?: unknown;
  online_event_format?: unknown;
  attending_count?: unknown;
  recurring_events?: unknown;

  ticket_price?: unknown;
  ticket_uri?: unknown;

  event_status?: unknown;
  event_times?: unknown;

  google_data_structure_json?: unknown;
};

type SociableKitFeed = {
  user_info?: unknown;
  solution_info?: unknown;
  events?: unknown;
};

function clean(
  value: unknown,
): string | null {
  return (
    typeof value === "string" &&
    value.trim()
  )
    ? value.trim()
    : null;
}

function sourceUrlIsSociableKitFeed(
  sourceUrl: string,
): boolean {
  try {
    const url = new URL(sourceUrl);

    return (
      url.hostname.toLowerCase() ===
        "data.accentapi.com" &&
      /^\/feed\/\d+\.json$/i.test(
        url.pathname,
      )
    );
  } catch {
    return false;
  }
}

function validIsoDateTime(
  value: unknown,
): string | null {
  const text = clean(value);

  if (!text) {
    return null;
  }

  const time = Date.parse(text);

  if (!Number.isFinite(time)) {
    return null;
  }

  return new Date(time).toISOString();
}

export async function fetchSociableKitFacebookEvents(
  sourceUrl: string,
): Promise<FirstPartyHarvestEvent[]> {
  if (
    !sourceUrlIsSociableKitFeed(
      sourceUrl,
    )
  ) {
    throw new Error(
      "SociableKIT source URL is not a recognized public feed.",
    );
  }

  const url = new URL(sourceUrl);

  /*
   * The widget appends a nocache query parameter at runtime.
   * The durable provider source is the feed path itself.
   */
  url.searchParams.delete("nocache");

  const durableSourceUrl = url.toString();

  const response = await recoveryFetch(
    durableSourceUrl,
    {
      headers: {
        Accept:
          "application/json,*/*;q=0.8",
        "User-Agent": USER_AGENT,
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(
      `SociableKIT feed returned HTTP ${response.status}.`,
    );
  }

  const payload =
    (await response.json()) as
      SociableKitFeed;

  if (!Array.isArray(payload.events)) {
    throw new Error(
      "SociableKIT feed returned an unexpected payload.",
    );
  }

  const events:
    FirstPartyHarvestEvent[] = [];

  const now = Date.now();

  for (const raw of payload.events) {
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw)
    ) {
      continue;
    }

    const record =
      raw as SociableKitEvent;

    const parentEventId =
      clean(record.event_id);

    const occurrenceId =
      clean(record.event_time_id);

    /*
     * Recurring Facebook events retain one parent event_id
     * while SociableKIT expands individual occurrences into
     * separate rows with stable event_time_id values.
     */
    const externalEventId =
      occurrenceId ??
      parentEventId;

    const title =
      clean(record.name);

    const startsAt =
      validIsoDateTime(
        record.event_start_utc,
      ) ??
      validIsoDateTime(
        record.start_time_raw,
      );

    const endsAt =
      validIsoDateTime(
        record.event_end_utc,
      ) ??
      validIsoDateTime(
        record.end_time_raw,
      );

    if (
      !externalEventId ||
      !title ||
      !startsAt
    ) {
      continue;
    }

    const lifecycleBoundary =
      Date.parse(
        endsAt ?? startsAt,
      );

    if (
      !Number.isFinite(
        lifecycleBoundary,
      ) ||
      lifecycleBoundary < now
    ) {
      continue;
    }

    events.push({
      externalEventId,
      title,
      description:
        clean(record.description),
      startsAt,
      endsAt,
      allDay: false,
      sourceUrl:
        clean(record.html_link) ??
        durableSourceUrl,
      flyerUrl:
        clean(record.image) ??
        clean(record.thumbnail_url),
      location:
        clean(record.location) ??
        clean(record.location_text) ??
        clean(record.event_venue),
      rawPayload: {
        provider:
          "sociablekit_facebook_events",
        feedUrl:
          durableSourceUrl,
        eventId:
          parentEventId,
        eventTimeId:
          occurrenceId,
        facebookPageId:
          clean(record.fb_page_id),
        timeZone:
          clean(record.timezone),
        eventTimeZone:
          clean(record.event_timezone),
        startTimestamp:
          clean(record.start_timestamp),
        startDate:
          clean(record.start_date_raw),
        endDate:
          clean(record.end_date_raw),
        facebookEventUrl:
          clean(record.html_link),
        thumbnailUrl:
          clean(record.thumbnail_url),
        imageUrl:
          clean(record.image),
        videoUrl:
          clean(record.video_url),
        latitude:
          clean(record.event_lati),
        longitude:
          clean(record.event_longi),
        venue:
          clean(record.event_venue),
        isOnline:
          clean(record.is_online),
        onlineEventFormat:
          clean(record.online_event_format),
        attendingCount:
          clean(record.attending_count),
        recurringEvents:
          clean(record.recurring_events),
        ticketPrice:
          clean(record.ticket_price),
        ticketUri:
          clean(record.ticket_uri),
        eventStatus:
          clean(record.event_status),
        eventTimes:
          Array.isArray(
            record.event_times,
          )
            ? record.event_times
            : null,
        schemaOrg:
          clean(
            record.google_data_structure_json,
          ),
      },
    });
  }

  const unique = new Map<
    string,
    FirstPartyHarvestEvent
  >();

  for (const event of events) {
    unique.set(
      event.externalEventId,
      event,
    );
  }

  return [...unique.values()].sort(
    (a, b) =>
      Date.parse(a.startsAt) -
      Date.parse(b.startsAt),
  );
}
