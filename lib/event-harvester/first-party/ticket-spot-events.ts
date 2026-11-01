import { fetchBrowserJsonResponses } from "./browser-transport";

import type { FirstPartyHarvestEvent } from "./types";

type RecordObject = Record<string, unknown>;

function object(value: unknown): RecordObject | null {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? (value as RecordObject)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

function ticketSpotEventsEndpoint(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      (
        (
          url.hostname === "api.geteventviewer.com" &&
          url.pathname === "/api/v1/events"
        ) ||
        (
          url.hostname === "ticketspotapp.com" &&
          url.pathname === "/api/api/v1/events"
        )
      )
    );
  } catch {
    return false;
  }
}

function venueAddress(value: unknown): string | null {
  const address = object(value);
  if (!address) return null;

  const street = string(address.address_1);
  const city = string(address.city);
  const region = string(address.region);
  const postal = string(address.postal_code);

  if (!street || !city || !region || !postal) {
    return null;
  }

  return `${street}, ${city}, ${region} ${postal}`;
}

function eventDate(value: unknown): string | null {
  const date = object(value);
  return date ? string(date.utc) : null;
}

function normalizeEvent(
  value: unknown,
): FirstPartyHarvestEvent | null {
  const record = object(value);
  if (!record) return null;

  const id =
    string(record.third_party_event_id) ??
    string(record.id);

  const title = string(record.title);
  const date = object(record.date);
  const startsAt = date ? eventDate(date.start) : null;

  if (!id || !title || !startsAt) return null;
  if (!Number.isFinite(Date.parse(startsAt))) return null;

  if (record.online_event === true) return null;

  const status = string(record.status);
  if (status && status !== "live") return null;

  const venue = object(record.venue);
  const logo = object(record.logo);

  const address = venueAddress(venue?.address);
  const name = string(venue?.name);

  // Never allow an incomplete physical venue identity to
  // silently inherit the calendar publisher's Spot.
  if (!name || !address) return null;

  const endsAt = date ? eventDate(date.end) : null;

  const url = string(record.url);
  const eventbriteUrl =
    url && /^https:\/\/(?:www\.)?eventbrite\.com\/e\//i.test(url)
      ? url
      : null;

  if (!eventbriteUrl) return null;

  return {
    externalEventId: id,
    title,
    description:
      string(record.description) ??
      string(record.long_description),
    startsAt,
    endsAt:
      endsAt && Number.isFinite(Date.parse(endsAt))
        ? endsAt
        : null,
    allDay: false,
    sourceUrl: eventbriteUrl,
    flyerUrl: string(logo?.url),
    location: address,
    venueName: name,
    venueAddress: address,
    rawPayload: {
      platform: "ticket_spot",
      upstreamPlatform: string(record.type),
      eventbriteEventId: id,
      publisherVenueName: name,
      publisherVenueAddress: address,
      sourceRecord: record,
    },
  };
}

export async function fetchTicketSpotEvents(
  sourceUrl: string,
): Promise<FirstPartyHarvestEvent[]> {
  // Retry a transient browser resource failure through the shared
  // transport, which owns browser creation and cleanup.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetchTicketSpotEventsOnce(sourceUrl);
    } catch (error) {
      const resourceFailure =
        error instanceof Error &&
        /net::ERR_INSUFFICIENT_RESOURCES/.test(error.message);
      if (!resourceFailure || attempt === 1) throw error;
    }
  }
  throw new Error("Ticket Spot browser resource recovery exhausted.");
}

async function fetchTicketSpotEventsOnce(
  sourceUrl: string,
): Promise<FirstPartyHarvestEvent[]> {
  const observed = await fetchBrowserJsonResponses(
    sourceUrl,
    ticketSpotEventsEndpoint,
  );

  if (
    observed.status === null ||
    observed.status < 200 ||
    observed.status >= 300
  ) {
    throw new Error(
      `Ticket Spot source returned HTTP ${observed.status ?? "unknown"}.`,
    );
  }

  if (!observed.observedEndpoint || !observed.successfulResponse) {
    throw new Error(
      "Ticket Spot widget did not return a successful events API response.",
    );
  }

  const responses: unknown[] = [];

  for (const payload of observed.payloads) {
    if (!Array.isArray(payload)) {
      throw new Error(
        "Ticket Spot events endpoint returned a non-array payload.",
      );
    }

    responses.push(...payload);
  }

  const events = responses
    .map(normalizeEvent)
    .filter(
      (event): event is FirstPartyHarvestEvent =>
        event !== null,
    );

  if (responses.length > 0 && events.length === 0) {
    throw new Error(
      "Ticket Spot returned event records, but none passed normalization.",
    );
  }

  const unique = new Map<string, FirstPartyHarvestEvent>();

  for (const event of events) {
    unique.set(
      `${event.externalEventId}:${event.startsAt}`,
      event,
    );
  }

  return [...unique.values()];
}
