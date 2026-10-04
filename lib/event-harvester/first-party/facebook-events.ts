import { chromium as playwright, type Page } from "playwright-core";
import Chromium from "@sparticuz/chromium";

export type FacebookEvent = {
  externalEventId: string;
  sourceUrl: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  flyerUrl: string | null;
  location: string | null;
  venueName: string | null;
  venueAddress: string | null;
  rawPayload: Record<string, unknown>;
};

type FacebookEventStub = {
  id: string;
  url: string;
  title: string;
};

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";

function canonicalPageUrl(value: string): string {
  const url = new URL(value);

  if (!/(^|\.)facebook\.com$/i.test(url.hostname)) {
    throw new Error(`Not a Facebook URL: ${value}`);
  }

  url.protocol = "https:";
  url.hostname = "www.facebook.com";
  url.search = "";
  url.hash = "";

  url.pathname = url.pathname.replace(/\/+$/, "");

  if (!url.pathname || url.pathname === "/") {
    throw new Error(`Facebook source does not identify a Page: ${value}`);
  }

  return url.toString().replace(/\/$/, "");
}

function eventsUrl(sourceUrl: string): string {
  return `${canonicalPageUrl(sourceUrl)}/events`;
}

function eventIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/events\/(\d+)\/?/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function unixSecondsToIso(value: number): string {
  return new Date(value * 1000).toISOString();
}

type FacebookEventPlace = {
  name: string | null;
  street: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  facebookPlaceId: string | null;
  facebookUrl: string | null;
};

function extractEventPlace(
  html: string,
  eventId: string,
): FacebookEventPlace | null {
  /*
   * Facebook may emit the requested event multiple times with both
   * abbreviated and fully hydrated event_place objects. Inspect every
   * nearby occurrence and retain the richest Place representation.
   */
  const eventMarker = `"id":"${eventId}"`;
  const placeKey = '"event_place":';

  let searchFrom = 0;
  let best: FacebookEventPlace | null = null;
  let bestScore = -1;

  while (true) {
    const eventIndex = html.indexOf(eventMarker, searchFrom);
    if (eventIndex === -1) break;

    searchFrom = eventIndex + eventMarker.length;

    const placeIndex = html.indexOf(placeKey, eventIndex);

    if (
      placeIndex === -1 ||
      placeIndex - eventIndex > 20000
    ) {
      continue;
    }

    const objectStart = html.indexOf(
      "{",
      placeIndex + placeKey.length,
    );

    if (objectStart === -1) continue;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let objectEnd = -1;

    for (let i = objectStart; i < html.length; i += 1) {
      const char = html[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;

        if (depth === 0) {
          objectEnd = i + 1;
          break;
        }
      }
    }

    if (objectEnd === -1) continue;

    try {
      const place = JSON.parse(
        html.slice(objectStart, objectEnd),
      );

      const candidate: FacebookEventPlace = {
        name:
          typeof place.name === "string"
            ? place.name
            : typeof place.contextual_name === "string"
              ? place.contextual_name
              : null,
        street:
          typeof place.address?.street === "string"
            ? place.address.street
            : null,
        city:
          typeof place.city?.contextual_name === "string"
            ? place.city.contextual_name
            : null,
        latitude:
          typeof place.location?.latitude === "number"
            ? place.location.latitude
            : null,
        longitude:
          typeof place.location?.longitude === "number"
            ? place.location.longitude
            : null,
        facebookPlaceId:
          typeof place.id === "string"
            ? place.id
            : null,
        facebookUrl:
          typeof place.url === "string"
            ? place.url
            : null,
      };

      if (!candidate.name) continue;

      /*
       * Prefer attribution evidence over cosmetic richness:
       * address + coordinates + Facebook Place identity are strongest.
       */
      const score =
        (candidate.street ? 8 : 0) +
        (candidate.city ? 4 : 0) +
        (candidate.latitude !== null ? 4 : 0) +
        (candidate.longitude !== null ? 4 : 0) +
        (candidate.facebookPlaceId ? 2 : 0) +
        (candidate.facebookUrl ? 2 : 0) +
        (candidate.name ? 1 : 0);

      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    } catch {
      // Ignore malformed embedded payloads and inspect the next copy.
    }
  }

  return best;
}

function extractTimestamp(
  html: string,
  eventId: string,
  field: "start_timestamp" | "end_timestamp",
): number | null {
  /*
   * Facebook pages contain suggested events in the same document.
   * Do not take the first timestamp globally. Prefer occurrences
   * associated with the requested event ID.
   */
  const escapedId = eventId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const nearbyPatterns = [
    new RegExp(
      `"id":"${escapedId}"[\\s\\S]{0,12000}?"${field}":(\\d+)`,
      "i",
    ),
    new RegExp(
      `"${field}":(\\d+)[\\s\\S]{0,12000}?"id":"${escapedId}"`,
      "i",
    ),
  ];

  for (const pattern of nearbyPatterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) return value;
    }
  }

  /*
   * On the individual event page the primary event payload is also
   * emitted repeatedly with its start timestamp before suggestions.
   * Accept a timestamp only when the requested event ID is present
   * in the document.
   */
  if (html.includes(`"id":"${eventId}"`)) {
    const match = html.match(
      new RegExp(`"${field}":(\\d+)[\\s\\S]{0,5000}?"${eventId}"`, "i"),
    );

    if (match?.[1]) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) return value;
    }
  }

  return null;
}

async function pageText(page: Page): Promise<string> {
  return page.locator("body").innerText().catch(() => "");
}

async function discoverEventStubs(page: Page): Promise<FacebookEventStub[]> {
  const links = await page.locator("a").evaluateAll((anchors) =>
    anchors.map((anchor) => ({
      href: (anchor as HTMLAnchorElement).href,
      text: (anchor.textContent ?? "").trim().replace(/\s+/g, " "),
    })),
  );

  const byId = new Map<string, FacebookEventStub>();

  for (const link of links) {
    const id = eventIdFromUrl(link.href);
    if (!id) continue;

    const existing = byId.get(id);

    if (!existing || (!existing.title && link.text)) {
      byId.set(id, {
        id,
        url: `https://www.facebook.com/events/${id}/`,
        title: link.text,
      });
    }
  }

  return [...byId.values()];
}


function extractFlyerUrl(
  html: string,
  eventId: string,
): string | null {
  /*
   * Search copies of the requested event payload for Facebook's
   * structured cover photo. Prefer full_image.uri when available.
   */
  const eventMarker = `"id":"${eventId}"`;
  let searchFrom = 0;

  while (true) {
    const eventIndex = html.indexOf(eventMarker, searchFrom);
    if (eventIndex === -1) return null;

    searchFrom = eventIndex + eventMarker.length;

    const coverIndex = html.indexOf('"cover_photo":', eventIndex);

    if (
      coverIndex === -1 ||
      coverIndex - eventIndex > 30000
    ) {
      continue;
    }

    const window = html.slice(
      coverIndex,
      Math.min(html.length, coverIndex + 15000),
    );

    const match =
      window.match(
        /"full_image":\{[^{}]*"uri":"((?:\\.|[^"\\])*)"/,
      ) ??
      window.match(
        /"image":\{[^{}]*"uri":"((?:\\.|[^"\\])*)"/,
      );

    if (!match?.[1]) continue;

    try {
      const value = JSON.parse(`"${match[1]}"`);

      if (
        typeof value === "string" &&
        /^https?:\/\//i.test(value)
      ) {
        return value;
      }
    } catch {
      // Inspect another copy of the requested event payload.
    }
  }
}

function extractDescription(
  html: string,
  eventId: string,
): string | null {
  /*
   * Bind the description to the requested event. Facebook may include
   * suggested events elsewhere in the same document.
   */
  const eventMarker = `"id":"${eventId}"`;
  let searchFrom = 0;

  while (true) {
    const eventIndex = html.indexOf(eventMarker, searchFrom);
    if (eventIndex === -1) return null;

    const descriptionKey = '"event_description":';
    const descriptionIndex = html.indexOf(descriptionKey, eventIndex);

    if (
      descriptionIndex === -1 ||
      descriptionIndex - eventIndex > 30000
    ) {
      searchFrom = eventIndex + eventMarker.length;
      continue;
    }

    /*
     * event_description is either null or an object whose first useful
     * field is the Facebook-authored text value.
     */
    const window = html.slice(
      descriptionIndex,
      Math.min(html.length, descriptionIndex + 20000),
    );

    if (/^"event_description":null/.test(window)) {
      return null;
    }

    const match = window.match(
      /^"event_description":\{"text":"((?:\\.|[^"\\])*)"/,
    );

    if (!match?.[1]) {
      searchFrom = eventIndex + eventMarker.length;
      continue;
    }

    try {
      const value = JSON.parse(`"${match[1]}"`);
      return typeof value === "string" && value.trim()
        ? value.trim()
        : null;
    } catch {
      searchFrom = eventIndex + eventMarker.length;
    }
  }
}
async function fetchEventDetail(
  page: Page,
  stub: FacebookEventStub,
): Promise<FacebookEvent | null> {
  try {
    const response = await page.goto(stub.url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    if (!response || !response.ok()) {
      throw new Error(
        `Facebook event ${stub.id} returned HTTP ${response?.status() ?? "unknown"}`,
      );
    }

    await page.waitForTimeout(3000);

    const text = (await pageText(page)).replace(/\s+/g, " ").trim();
    const html = await page.content();

    if (/log in to view this 18\+ content/i.test(text)) {
      return null;
    }

    const startTimestamp = extractTimestamp(
      html,
      stub.id,
      "start_timestamp",
    );

    if (!startTimestamp) {
      throw new Error(
        `Facebook event ${stub.id} did not expose its structured start timestamp`,
      );
    }

    const endTimestamp = extractTimestamp(
      html,
      stub.id,
      "end_timestamp",
    );

    const title =
      (await page.title())
        .replace(/\s*\|\s*Facebook\s*$/i, "")
        .trim() ||
      stub.title ||
      `Facebook event ${stub.id}`;

    const eventPlace = extractEventPlace(html, stub.id);

    const venueAddress = eventPlace
      ? [eventPlace.street, eventPlace.city].filter(Boolean).join(", ") || null
      : null;

    const startsAt = unixSecondsToIso(startTimestamp);

    return {
      externalEventId: `facebook:event:${stub.id}`,
      sourceUrl: stub.url,
      title,
      description: extractDescription(html, stub.id),
      startsAt,
      endsAt:
        endTimestamp && endTimestamp > startTimestamp
          ? unixSecondsToIso(endTimestamp)
          : null,
      allDay: false,
      flyerUrl: extractFlyerUrl(html, stub.id),
      location: venueAddress,
      venueName: eventPlace?.name ?? null,
      venueAddress,
      rawPayload: {
        platform: "facebook_events",
        eventId: stub.id,
        pageTitle: stub.title,
        startTimestamp,
        endTimestamp: endTimestamp ?? 0,
        eventPlace,
        renderedText: text.slice(0, 5000),
      },
    };
  } finally {
    // Reuse the same Chromium page for the complete Facebook source scan.
  }
}

export async function fetchFacebookEvents(
  sourceUrl: string,
): Promise<FacebookEvent[]> {
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

    const response = await page.goto(eventsUrl(sourceUrl), {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    if (!response || !response.ok()) {
      throw new Error(
        `Facebook events page returned HTTP ${response?.status() ?? "unknown"}`,
      );
    }

    await page.waitForTimeout(5000);

    const text = await pageText(page);

    if (/log in to view this 18\+ content/i.test(text)) {
      throw new Error("Facebook Page requires login to view 18+ content");
    }

    const stubs = await discoverEventStubs(page);
    const events: FacebookEvent[] = [];
    const now = Date.now();

    for (const stub of stubs) {
      const event = await fetchEventDetail(page, stub);
      if (!event) continue;

      const startsAt = Date.parse(event.startsAt);
      const endsAt = event.endsAt
        ? Date.parse(event.endsAt)
        : null;

      /*
       * Facebook Page event listings can expose years of historical
       * events. Keep future events and events currently in progress,
       * but do not bootstrap completed history.
       */
      const isPast =
        endsAt !== null && Number.isFinite(endsAt)
          ? endsAt < now
          : Number.isFinite(startsAt) && startsAt < now;

      if (!isPast) {
        events.push(event);
      }
    }

    return events;
  } finally {
    await browser.close();
  }
}
