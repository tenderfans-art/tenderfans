import { recoveryFetch } from "@/lib/event-harvester/recovery-fetch";
import type {
  FirstPartyHarvestEvent,
} from "./types";

import { parseIcsEvents } from "./ics";

const GOOGLE_CALENDAR_HOSTS = new Set([
  "calendar.google.com",
  "www.google.com",
]);

/*
 * Google Calendar embed URLs may encode the calendar ID in Base64.
 * Direct calendar IDs and public ICS URLs must remain supported.
 *
 * Decode only when the result has the structure of a calendar ID.
 * This avoids accidentally transforming an ordinary calendar ID.
 */
function normalizeGoogleCalendarId(
  value: string,
): string {
  const calendarId = value.trim();

  if (
    calendarId.includes("@") ||
    !/^[A-Za-z0-9_-]+={0,2}$/.test(calendarId)
  ) {
    return calendarId;
  }

  try {
    const decoded = Buffer.from(
      calendarId.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8").trim();

    if (
      /^[^\\s@]+@[^\\s@]+$/.test(decoded)
    ) {
      return decoded;
    }
  } catch {
    // Preserve the original calendar identity.
  }

  return calendarId;
}

function calendarIdFromGoogleUrl(
  sourceUrl: string,
): string | null {
  let url: URL;

  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();

  if (!GOOGLE_CALENDAR_HOSTS.has(host)) {
    return null;
  }

  /*
   * Google Calendar embeds expose the calendar identity through
   * the `src` query parameter:
   *
   *   /calendar/embed?src=<calendar-id>
   *
   * Public ICS URLs instead encode that same identity in:
   *
   *   /calendar/ical/<calendar-id>/public/basic.ics
   *
   * Accept both forms so the adapter owns Google Calendar URL
   * semantics while the detector can retain the human-readable
   * embed URL discovered on the Spot's website.
   */
  const queryCalendarId = url.searchParams.get("src")?.trim();

  if (queryCalendarId) {
    return normalizeGoogleCalendarId(queryCalendarId);
  }

  const pathMatch = url.pathname.match(
    /^\/calendar\/ical\/(.+?)\/public\/basic\.ics$/i,
  );

  if (!pathMatch?.[1]) {
    return null;
  }

  try {
    return decodeURIComponent(pathMatch[1]).trim() || null;
  } catch {
    return pathMatch[1].trim() || null;
  }
}

function googleCalendarIcsUrl(
  calendarId: string,
): string {
  return [
    "https://calendar.google.com/calendar/ical/",
    encodeURIComponent(calendarId),
    "/public/basic.ics",
  ].join("");
}

export async function fetchGoogleCalendarEvents(
  sourceUrl: string,
): Promise<FirstPartyHarvestEvent[]> {
  const calendarId =
    calendarIdFromGoogleUrl(sourceUrl);

  if (!calendarId) {
    throw new Error(
      "Google Calendar source URL does not contain a usable calendar identity.",
    );
  }

  const icsUrl =
    googleCalendarIcsUrl(calendarId);

  const response = await recoveryFetch(icsUrl, {
    headers: {
      Accept: "text/calendar,text/plain;q=0.9,*/*;q=0.8",
      "User-Agent": "TenderFans-Event-Harvester/1.0",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `Google Calendar feed returned HTTP ${response.status}.`,
    );
  }

  const rawIcs = await response.text();
  const parsedEvents = parseIcsEvents(rawIcs);

  /*
   * Google public calendars may retain years of historical
   * inventory. Keep an event while its lifecycle boundary
   * (end when available, otherwise start) has not passed.
   *
   * Do not infer clock times for all-day Google Calendar
   * events. The source representation remains authoritative.
   */
  const now = Date.now();

  const upcomingEvents =
    parsedEvents.filter((event) => {
      const lifecycleBoundary =
        Date.parse(
          event.endsAt ??
          event.startsAt,
        );

      return (
        Number.isFinite(lifecycleBoundary) &&
        lifecycleBoundary >= now
      );
    });

  /*
   * UID is the provider lifecycle identity exposed by the
   * shared ICS parser. Keep only one representation per UID.
   */
  const deduped = new Map<
    string,
    FirstPartyHarvestEvent
  >();

  for (const event of upcomingEvents) {
    if (!deduped.has(event.externalEventId)) {
      deduped.set(
        event.externalEventId,
        {
          ...event,
          rawPayload: {
            ...event.rawPayload,
            googleCalendarId: calendarId,
            googleCalendarIcsUrl: icsUrl,
          },
        },
      );
    }
  }

  return [...deduped.values()].sort(
    (a, b) =>
      Date.parse(a.startsAt) -
      Date.parse(b.startsAt),
  );
}
