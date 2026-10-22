import { chromium as playwright } from "playwright-core";
import Chromium from "@sparticuz/chromium";

import type { FirstPartyHarvestEvent } from "./types";

const USER_AGENT = "TenderFans Event Harvester/1.0";

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
  const browser = await playwright.launch({
    args: Chromium.args,
    executablePath: await Chromium.executablePath(),
    headless: true,
  });

  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1600 },
      userAgent: USER_AGENT,
    });

    const responses: unknown[] = [];
    const pending: Promise<void>[] = [];
    let observedEndpoint = false;
    let successfulResponse = false;

    page.on("response", (response) => {
      if (!ticketSpotEventsEndpoint(response.url())) return;

      observedEndpoint = true;

      const task = (async () => {
        if (!response.ok()) return;

        const payload: unknown = await response.json();

        if (!Array.isArray(payload)) {
          throw new Error(
            "Ticket Spot events endpoint returned a non-array payload.",
          );
        }

        successfulResponse = true;
        responses.push(...payload);
      })();

      pending.push(task);
    });

    const navigation = await page.goto(sourceUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    if (!navigation || !navigation.ok()) {
      throw new Error(
        `Ticket Spot source returned HTTP ${navigation?.status() ?? "unknown"}.`,
      );
    }

    // Match the existing browser transport's widget initialization
    // window, then allow observed API responses to finish parsing.
    await page.waitForTimeout(5000);
    await Promise.all(pending);

    if (!observedEndpoint || !successfulResponse) {
      throw new Error(
        "Ticket Spot widget did not return a successful events API response.",
      );
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
  } finally {
    await browser.close();
  }
}
