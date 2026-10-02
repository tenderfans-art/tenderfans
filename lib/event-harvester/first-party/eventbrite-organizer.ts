import type { FirstPartyHarvestEvent } from "./types";

type EventbriteOrganizerOptions = {
  organizerId?: string | null;
  venueId?: string | null;
  sessionHorizonDays?: number;
};

type EventbriteSession = {
  sessionId: string;
  startDatetime: string;
  endDatetime: string | null;
  checkoutEnabled: boolean;
  isPublished: boolean;
  soldOut: boolean;
  urgencySignals?: Record<string, unknown>;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function stringValue(
  value: unknown
): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

function htmlEntityDecode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function zonedLocalToIso(
  date: string,
  time: string,
  timeZone: string
): string {
  const [year, month, day] = date
    .split("-")
    .map(Number);

  const [hour, minute, second] = time
    .split(":")
    .map(Number);

  if (
    !year ||
    !month ||
    !day ||
    Number.isNaN(hour) ||
    Number.isNaN(minute)
  ) {
    throw new Error(
      `Invalid Eventbrite local datetime: ${date} ${time}`
    );
  }

  const desiredUtc = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second || 0
  );

  let guess = desiredUtc;

  for (let i = 0; i < 4; i++) {
    const parts = new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }
    ).formatToParts(new Date(guess));

    const values = Object.fromEntries(
      parts.map((part) => [
        part.type,
        part.value,
      ])
    );

    const representedUtc = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second)
    );

    const delta = desiredUtc - representedUtc;

    if (delta === 0) {
      break;
    }

    guess += delta;
  }

  return new Date(guess).toISOString();
}

function findEventRecords(
  value: unknown,
  results: JsonObject[] = [],
  seen = new Set<string>()
): JsonObject[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      findEventRecords(item, results, seen);
    }
    return results;
  }

  if (!isObject(value)) {
    return results;
  }

  const id =
    stringValue(value.eventbrite_event_id) ??
    stringValue(value.eid) ??
    stringValue(value.id);

  const name = stringValue(value.name);
  const startDate = stringValue(value.start_date);
  const startTime = stringValue(value.start_time);
  const type = stringValue(value._type);

  if (
    id &&
    name &&
    startDate &&
    startTime &&
    (type === "event" ||
      value.eventbrite_event_id !== undefined)
  ) {
    if (!seen.has(id)) {
      seen.add(id);
      results.push(value);
    }
  }

  for (const child of Object.values(value)) {
    findEventRecords(child, results, seen);
  }

  return results;
}

function parseNextData(
  html: string
): unknown {
  const match = html.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );

  if (!match) {
    throw new Error(
      "Eventbrite organizer page did not contain __NEXT_DATA__."
    );
  }

  try {
    return JSON.parse(
      htmlEntityDecode(match[1])
    );
  } catch {
    throw new Error(
      "Could not parse Eventbrite organizer __NEXT_DATA__."
    );
  }
}

export type EventbriteEventIdentity = {
  eventId: string;
  title: string;
  status: string | null;
  isOnline: boolean;
  organizer: {
    id: string | null;
    name: string | null;
    url: string | null;
  };
  venue: {
    id: string | null;
    name: string | null;
    streetAddress: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
};

function numberValue(
  value: unknown
): number | null {
  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return value;
  }

  if (
    typeof value === "string" &&
    value.trim()
  ) {
    const parsed = Number(value);
    return Number.isFinite(parsed)
      ? parsed
      : null;
  }

  return null;
}

function eventbriteBasicInfo(
  data: unknown
): JsonObject | null {
  if (!isObject(data)) return null;

  const props = isObject(data.props)
    ? data.props
    : null;

  const pageProps =
    props && isObject(props.pageProps)
      ? props.pageProps
      : null;

  const context =
    pageProps && isObject(pageProps.context)
      ? pageProps.context
      : null;

  return context &&
    isObject(context.basicInfo)
    ? context.basicInfo
    : null;
}

function firstString(
  value: unknown
): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = stringValue(item);
      if (found) return found;
    }
  }

  return stringValue(value);
}

export async function fetchEventbriteEventIdentity(
  sourceUrl: string
): Promise<EventbriteEventIdentity> {
  const response = await fetch(sourceUrl, {
    headers: {
      Accept:
        "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "User-Agent":
        "TenderFans-Event-Harvester/1.0",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `Eventbrite event source returned HTTP ${response.status}.`
    );
  }

  const html = await response.text();
  const data = parseNextData(html);
  const basicInfo = eventbriteBasicInfo(data);

  if (!basicInfo) {
    throw new Error(
      "Eventbrite event page did not expose basicInfo."
    );
  }

  const eventId = stringValue(basicInfo.id);
  const title = stringValue(basicInfo.name);

  if (!eventId || !title) {
    throw new Error(
      "Eventbrite event basicInfo did not contain event identity."
    );
  }

  const organizer = isObject(
    basicInfo.organizer
  )
    ? basicInfo.organizer
    : null;

  const venue = isObject(basicInfo.venue)
    ? basicInfo.venue
    : null;

  const address =
    venue && isObject(venue.address)
      ? venue.address
      : null;

  return {
    eventId,
    title,
    status: stringValue(basicInfo.status),
    isOnline: basicInfo.isOnline === true,
    organizer: {
      id:
        (organizer
          ? stringValue(organizer.id)
          : null) ??
        stringValue(basicInfo.organizationId),
      name: organizer
        ? stringValue(organizer.name)
        : null,
      url: organizer
        ? stringValue(organizer.url)
        : null,
    },
    venue: venue
      ? {
          id: stringValue(venue.id),
          name: stringValue(venue.name),
          streetAddress: address
            ? firstString(
                address.localizedMultiLineAddressDisplay
              )
            : null,
          city: address
            ? stringValue(address.city)
            : null,
          region: address
            ? stringValue(address.region)
            : null,
          postalCode: address
            ? (
                stringValue(address.postalCode) ??
                stringValue(address.postal_code)
              )
            : null,
          country: address
            ? stringValue(address.country)
            : null,
          latitude: address
            ? numberValue(address.latitude)
            : null,
          longitude: address
            ? numberValue(address.longitude)
            : null,
        }
      : null,
  };
}

function localDateKey(
  date: Date,
  timeZone: string
): string {
  const parts = new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }
  ).formatToParts(date);

  const values = Object.fromEntries(
    parts.map((part) => [
      part.type,
      part.value,
    ])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function addUtcDays(
  date: Date,
  days: number
): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function hasAdditionalSessions(
  value: unknown
): boolean {
  if (typeof value === "number") {
    return value > 0;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0;
  }

  return false;
}

function isEventbriteSession(
  value: unknown
): value is EventbriteSession {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.sessionId === "string" &&
    typeof value.startDatetime === "string" &&
    (typeof value.endDatetime === "string" ||
      value.endDatetime === null) &&
    typeof value.checkoutEnabled === "boolean" &&
    typeof value.isPublished === "boolean" &&
    typeof value.soldOut === "boolean"
  );
}

async function fetchEventbriteSessionsForDate(
  parentEventId: string,
  date: string,
  timeZone: string
): Promise<EventbriteSession[]> {
  const url =
    `https://checkoutfairy.ernt4vxu.ext.eventbrite.com/main/event/` +
    `${encodeURIComponent(parentEventId)}/date/` +
    `${encodeURIComponent(date)}/sessions?tzIdentifier=` +
    encodeURIComponent(timeZone);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent":
        "TenderFans-Event-Harvester/1.0",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `Eventbrite session source returned HTTP ${response.status} ` +
      `for event ${parentEventId} on ${date}.`
    );
  }

  const payload: unknown = await response.json();

  if (!Array.isArray(payload)) {
    throw new Error(
      `Eventbrite session source returned an unexpected payload ` +
      `for event ${parentEventId} on ${date}.`
    );
  }

  return payload.filter(isEventbriteSession);
}

async function expandEventbriteSeries(
  parentEventId: string,
  timeZone: string,
  horizonDays: number
): Promise<EventbriteSession[]> {
  const sessions = new Map<
    string,
    EventbriteSession
  >();

  const now = new Date();

  for (let day = 0; day <= horizonDays; day++) {
    const date = localDateKey(
      addUtcDays(now, day),
      timeZone
    );

    const found =
      await fetchEventbriteSessionsForDate(
        parentEventId,
        date,
        timeZone
      );

    for (const session of found) {
      if (session.isPublished) {
        sessions.set(
          session.sessionId,
          session
        );
      }
    }
  }

  return [...sessions.values()].sort(
    (a, b) =>
      new Date(a.startDatetime).getTime() -
      new Date(b.startDatetime).getTime()
  );
}

function venueName(
  venue: JsonObject | null
): string | null {
  return venue
    ? stringValue(venue.name)
    : null;
}

function venueLocation(
  venue: JsonObject | null
): string | null {
  if (!venue) return null;

  const address = isObject(venue.address)
    ? venue.address
    : null;

  if (!address) return null;

  return (
    stringValue(
      address.localized_address_display
    ) ??
    (
      [
        stringValue(address.address_1),
        stringValue(address.city),
        stringValue(address.region),
        stringValue(address.postal_code),
      ]
        .filter(Boolean)
        .join(", ") || null
    )
  );
}

export async function fetchEventbriteOrganizerEvents(
  sourceUrl: string,
  options: EventbriteOrganizerOptions = {}
): Promise<FirstPartyHarvestEvent[]> {
  const response = await fetch(sourceUrl, {
    headers: {
      Accept:
        "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "User-Agent":
        "TenderFans-Event-Harvester/1.0",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `Eventbrite organizer source returned HTTP ${response.status}.`
    );
  }

  const html = await response.text();
  const data = parseNextData(html);
  const records = findEventRecords(data);

  const expectedOrganizerId =
    options.organizerId?.trim() || null;

  const expectedVenueId =
    options.venueId?.trim() || null;

  const sessionHorizonDays = Math.max(
    1,
    Math.min(
      180,
      options.sessionHorizonDays ?? 120
    )
  );

  const events: FirstPartyHarvestEvent[] = [];

  for (const record of records) {
    const externalEventId =
      stringValue(record.eventbrite_event_id) ??
      stringValue(record.eid) ??
      stringValue(record.id);

    const title = stringValue(record.name);
    const startDate =
      stringValue(record.start_date);
    const startTime =
      stringValue(record.start_time);

    const timeZone =
      stringValue(record.timezone) ??
      "America/New_York";

    if (
      !externalEventId ||
      !title ||
      !startDate ||
      !startTime
    ) {
      continue;
    }

    const organizerId =
      stringValue(record.primary_organizer_id);

    if (
      expectedOrganizerId &&
      organizerId !== expectedOrganizerId
    ) {
      continue;
    }

    const primaryVenue = isObject(
      record.primary_venue
    )
      ? record.primary_venue
      : null;

    const primaryVenueId =
      stringValue(record.primary_venue_id) ??
      (primaryVenue
        ? stringValue(primaryVenue.id)
        : null);

    if (
      expectedVenueId &&
      primaryVenueId !== expectedVenueId
    ) {
      continue;
    }

    if (
      record.is_cancelled === true ||
      record.is_online_event === true
    ) {
      continue;
    }

    const startsAt = zonedLocalToIso(
      startDate,
      startTime,
      timeZone
    );

    const endDate =
      stringValue(record.end_date);

    const endTime =
      stringValue(record.end_time);

    let endsAt: string | null = null;

    if (endDate && endTime) {
      const candidateEnd = zonedLocalToIso(
        endDate,
        endTime,
        timeZone
      );

      if (
        new Date(candidateEnd).getTime() >
        new Date(startsAt).getTime()
      ) {
        endsAt = candidateEnd;
      }
    }

    const image = isObject(record.image)
      ? record.image
      : null;

    const flyerUrl = image
      ? stringValue(image.url)
      : null;

    const sourceEventUrl =
      stringValue(record.url) ??
      `https://www.eventbrite.com/e/${externalEventId}`;

    const commonRawPayload = {
      platform: "eventbrite",
      eventbriteEventId: externalEventId,
      organizerId,
      venueId: primaryVenueId,
      timezone: timeZone,
      isCancelled:
        record.is_cancelled === true,
      isOnlineEvent:
        record.is_online_event === true,
      ticketAvailability:
        record.ticket_availability ?? null,
      salesStatus:
        record.event_sales_status ?? null,
      seriesId:
        record.series_id ?? null,
      additionalSessionsCount:
        record.additionalSessionsCount ?? null,
      primaryVenue:
        primaryVenue ?? null,
      sourceRecord: record,
    };

    if (
      hasAdditionalSessions(
        record.additionalSessionsCount
      )
    ) {
      const sessions =
        await expandEventbriteSeries(
          externalEventId,
          timeZone,
          sessionHorizonDays
        );

      if (sessions.length === 0) {
        throw new Error(
          `Eventbrite series ${externalEventId} reported ` +
          `additional sessions but none were found.`
        );
      }

      for (const session of sessions) {
        events.push({
          externalEventId: session.sessionId,
          title,
          description:
            stringValue(record.summary),
          startsAt: new Date(
            session.startDatetime
          ).toISOString(),
          endsAt: session.endDatetime
            ? new Date(
                session.endDatetime
              ).toISOString()
            : null,
          allDay: false,
          sourceUrl: sourceEventUrl,
          flyerUrl,
          location:
            venueLocation(primaryVenue),
          venueName:
            venueName(primaryVenue),
          venueAddress:
            venueLocation(primaryVenue),
          rawPayload: {
            ...commonRawPayload,
            eventbriteParentEventId:
              externalEventId,
            eventbriteSessionId:
              session.sessionId,
            session,
          },
        });
      }

      continue;
    }

    events.push({
      externalEventId,
      title,
      description:
        stringValue(record.summary),
      startsAt,
      endsAt,
      allDay: false,
      sourceUrl: sourceEventUrl,
      flyerUrl,
      location: venueLocation(primaryVenue),
      venueName: venueName(primaryVenue),
      venueAddress:
        venueLocation(primaryVenue),
      rawPayload: commonRawPayload,
    });
  }

  return events.sort(
    (a, b) =>
      new Date(a.startsAt).getTime() -
      new Date(b.startsAt).getTime()
  );
}
