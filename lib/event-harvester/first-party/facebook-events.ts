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
  allowSourceDefaultAttribution: boolean;
  rawPayload: Record<string, unknown>;
};

type FacebookEventStub = {
  id: string;
  url: string;
  title: string;
};

type FacebookOccurrence = {
  id: string;
  parentId: string;
  startTimestamp: number;
  endTimestamp: number | null;
};

function validFacebookTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    Number.isFinite(value * 1000) &&
    !Number.isNaN(new Date(value * 1000).getTime())
  );
}

/*
 * Facebook embeds recurring occurrences in comet_neighboring_siblings.
 * Each record must independently identify its parent and timestamp.
 * Never associate timestamps using proximity alone.
 */
function extractFacebookOccurrences(
  html: string,
  parentId: string,
): FacebookOccurrence[] {
  const results = new Map<string, FacebookOccurrence>();
  const conflicts = new Set<string>();
  const marker = '"comet_neighboring_siblings":';
  let cursor = 0;

  while (true) {
    const index = html.indexOf(marker, cursor);
    if (index === -1) break;

    cursor = index + marker.length;

    const start = html.indexOf("[", cursor);
    if (start === -1 || start - cursor > 30) continue;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let i = start; i < html.length; i++) {
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
      } else if (char === "[") {
        depth++;
      } else if (char === "]") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }

    if (end === -1) continue;

    let records: unknown;

    try {
      records = JSON.parse(html.slice(start, end));
    } catch {
      continue;
    }

    if (!Array.isArray(records)) continue;

    for (const raw of records) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }

      const record = raw as Record<string, unknown>;
      const parent = record.parent_event;

      if (
        !parent ||
        typeof parent !== "object" ||
        Array.isArray(parent)
      ) {
        continue;
      }

      const parentRecord = parent as Record<string, unknown>;
      const id = record.id;
      const startTimestamp = record.start_timestamp;
      const endTimestamp = record.end_timestamp;

      if (
        typeof id !== "string" ||
        !/^\d+$/.test(id) ||
        parentRecord.parent_id !== parentId ||
        parentRecord.id !== parentId ||
        !validFacebookTimestamp(startTimestamp)
      ) {
        continue;
      }

      if (
        endTimestamp !== null &&
        endTimestamp !== undefined &&
        (!validFacebookTimestamp(endTimestamp) ||
          endTimestamp <= startTimestamp)
      ) {
        continue;
      }

      const occurrence: FacebookOccurrence = {
        id,
        parentId,
        startTimestamp,
        endTimestamp:
          typeof endTimestamp === "number"
            ? endTimestamp
            : null,
      };

      if (conflicts.has(id)) continue;

      const existing = results.get(id);

      // Once conflicting dates are detected, reject this ID permanently.
      if (
        existing &&
        (existing.startTimestamp !== occurrence.startTimestamp ||
          existing.endTimestamp !== occurrence.endTimestamp)
      ) {
        results.delete(id);
        conflicts.add(id);
        continue;
      }

      results.set(id, occurrence);
    }
  }

  return [...results.values()];
}

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

  /*
   * Normalize Facebook Page links before requesting the Events tab.
   * Remove unrelated Page tabs and support /people/name/id URLs.
   */
  const peoplePage = url.pathname.match(
    /^\/people\/[^/]+\/(\d+)(?:\/(?:events|reviews|posts|photos|about))?$/i,
  );

  if (peoplePage) {
    url.pathname = `/${peoplePage[1]}`;
  } else {
    url.pathname = url.pathname.replace(
      /\/(?:reviews|posts|photos|about)$/i,
      "",
    );
  }


  if (!url.pathname || url.pathname === "/") {
    throw new Error(`Facebook source does not identify a Page: ${value}`);
  }

  return url.toString().replace(/\/$/, "");
}

function eventsUrl(sourceUrl: string): string {
  const pageUrl = canonicalPageUrl(sourceUrl);

  // Detected sources may already point directly to the Events tab.
  // Avoid constructing /events/events.
  return /\/events$/i.test(new URL(pageUrl).pathname)
    ? pageUrl
    : `${pageUrl}/events`;
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

/*
 * Extract Facebook's displayed organizer names separately from the
 * physical event place. This is evidence, not automatic ownership.
 */
function extractFacebookOrganizerNames(text: string): string[] {
  /*
   * Preserve explicitly labeled Facebook organizer text.
   *
   * Rendered Facebook pages can concatenate multiple organizer
   * links without delimiters. Business names can also contain
   * commas and "and". Neither is a safe name separator.
   *
   * Matching against registered Spot identities happens later.
   */
  const normalized = text.replace(/\s+/g, " ").trim();

  const eventBy = normalized.match(
    /\bEvent by\s+(.+?)(?=\s+(?:Public|Private)\s*[·•]|\s+Suggested events\b|$)/i,
  );

  const hosts = normalized.match(
    /\bHosts?\s+(.+?)(?=\s+Suggested events\b|$)/i,
  );

  const fields = [eventBy?.[1], hosts?.[1]]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim())
    .filter((value) => value.length <= 500);

  return [...new Set(fields)];
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

    const visibleText = await pageText(page);
    const text = visibleText.replace(/\s+/g, " ").trim();
    const html = await page.content();

    if (/log in to view this 18\+ content/i.test(text)) {
      return null;
    }

    const verifiedOccurrences =
      extractFacebookOccurrences(html, stub.id);

    const startTimestamp =
      extractTimestamp(html, stub.id, "start_timestamp") ??
      verifiedOccurrences[0]?.startTimestamp ??
      null;

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
      allowSourceDefaultAttribution: false,
      rawPayload: {
        platform: "facebook_events",
        allowSourceDefaultAttribution: false,
        eventId: stub.id,
        pageTitle: stub.title,
        startTimestamp,
        endTimestamp: endTimestamp ?? 0,
        eventPlace,
        facebookOrganizerNames: extractFacebookOrganizerNames(visibleText),
        renderedText: text.slice(0, 5000),
        verifiedOccurrences,
        hasRecurrenceMarker:
          html.includes('"comet_neighboring_siblings":'),
      },
    };
  } finally {
    // Reuse the same Chromium page for the complete Facebook source scan.
  }
}

/*
 * Facebook's neighboring siblings are a small window, not the complete
 * recurring series. Follow verified child occurrences forward to discover
 * further real Facebook identities and timestamps.
 *
 * Never synthesize occurrence IDs or dates. A child must independently
 * identify the same parent. Keep navigation bounded.
 */
async function discoverFacebookSeriesOccurrences(
  page: Page,
  parentId: string,
  initial: FacebookOccurrence[],
): Promise<FacebookOccurrence[]> {
  if (initial.length === 0) return initial;

  const occurrences = new Map<string, FacebookOccurrence>();
  const conflicts = new Set<string>();
  const visited = new Set<string>();

  const horizon = Date.now() + 12 * 7 * 24 * 60 * 60 * 1000;
  const maxChildVisits = 12;

  function merge(items: FacebookOccurrence[]): void {
    for (const item of items) {
      if (item.parentId !== parentId || conflicts.has(item.id)) {
        continue;
      }

      const existing = occurrences.get(item.id);

      if (
        existing &&
        (existing.startTimestamp !== item.startTimestamp ||
          existing.endTimestamp !== item.endTimestamp)
      ) {
        occurrences.delete(item.id);
        conflicts.add(item.id);
        continue;
      }

      occurrences.set(item.id, item);
    }
  }

  merge(initial);

  for (let visit = 0; visit < maxChildVisits; visit += 1) {
    const next = [...occurrences.values()]
      .filter((item) =>
        !visited.has(item.id) &&
        item.startTimestamp * 1000 >= Date.now() &&
        item.startTimestamp * 1000 <= horizon
      )
      .sort((a, b) =>
        b.startTimestamp - a.startTimestamp ||
        b.id.localeCompare(a.id)
      )[0];

    if (!next) break;

    visited.add(next.id);

    const url =
      `https://www.facebook.com/events/${parentId}/${next.id}/`;

    let html: string;

    try {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      if (!response?.ok()) break;

      await page.waitForTimeout(750);
      html = await page.content();
    } catch {
      // Keep already verified occurrences if a child is unavailable.
      break;
    }

    const discovered = extractFacebookOccurrences(html, parentId);
    const before = occurrences.size;

    merge(discovered);

    /*
     * The newest occurrence should expose a forward-moving sibling
     * window. If it does not, further navigation cannot establish
     * additional verified dates from this window.
     */
    if (occurrences.size <= before) break;
  }

  return [...occurrences.values()]
    .sort((a, b) =>
      a.startTimestamp - b.startTimestamp ||
      a.id.localeCompare(b.id)
    );
}

/*
 * Convert a verified recurring series into independently dated events.
 * Ordinary events retain their existing identity and metadata.
 */
/*
 * Preserve independently verified Facebook occurrences with stable
 * parent/occurrence identities. Distinct dates remain distinct events.
 * Repeated occurrence identities are emitted only once per expansion.
 */
function expandFacebookEventCandidates(
  stub: FacebookEventStub,
  event: FacebookEvent,
): FacebookEvent[] {
  const raw = event.rawPayload.verifiedOccurrences;
  const occurrences = Array.isArray(raw)
    ? raw as FacebookOccurrence[]
    : [];

  if (occurrences.length === 0) {
    return [event];
  }

  const now = Date.now();
  const seen = new Set<string>();

  return occurrences
    .filter((occurrence) => {
      const end = occurrence.endTimestamp;
      return (end ?? occurrence.startTimestamp) * 1000 >= now;
    })
    .sort((a, b) =>
      a.startTimestamp - b.startTimestamp ||
      a.id.localeCompare(b.id),
    )
    .filter((occurrence) => {
      if (seen.has(occurrence.id)) return false;
      seen.add(occurrence.id);
      return true;
    })
    .map((occurrence) => ({
      ...event,
      externalEventId:
        `facebook:event:${stub.id}:${occurrence.id}`,
      sourceUrl:
        `https://www.facebook.com/events/${stub.id}/${occurrence.id}/`,
      startsAt: unixSecondsToIso(occurrence.startTimestamp),
      endsAt: occurrence.endTimestamp
        ? unixSecondsToIso(occurrence.endTimestamp)
        : null,
      rawPayload: {
        ...event.rawPayload,
        parentEventId: stub.id,
        occurrenceId: occurrence.id,
        startTimestamp: occurrence.startTimestamp,
        endTimestamp: occurrence.endTimestamp,
      },
    }));
}

/*
 * Preserve ongoing and upcoming events, exclude completed history,
 * and deduplicate across the entire Facebook source scan.
 */
function appendEligibleFacebookEvents(
  candidates: FacebookEvent[],
  events: FacebookEvent[],
  seenExternalIds: Set<string>,
  now: number,
): void {
  for (const candidate of candidates) {
    if (seenExternalIds.has(candidate.externalEventId)) continue;

    const startsAt = Date.parse(candidate.startsAt);
    const endsAt = candidate.endsAt
      ? Date.parse(candidate.endsAt)
      : null;

    const isPast =
      endsAt !== null && Number.isFinite(endsAt)
        ? endsAt < now
        : Number.isFinite(startsAt) && startsAt < now;

    if (!isPast) {
      seenExternalIds.add(candidate.externalEventId);
      events.push(candidate);
    }
  }
}

export async function fetchFacebookEvents(
  sourceUrl: string,
  options: { validatePageIdentity?: boolean } = {},
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

    const initialEventsUrl = eventsUrl(sourceUrl);
    let response;

    try {
      response = await page.goto(initialEventsUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("net::ERR_NETWORK_CHANGED")
      ) {
        throw error;
      }

      // Retry one transient Chromium network-change failure.
      // All HTTP responses and access restrictions retain their
      // existing validation behavior.
      response = await page.goto(initialEventsUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
    }

    /*
     * Legacy Facebook /pages/name/numeric-id URLs may no longer
     * serve an Events endpoint. Try the corresponding name-id
     * route only when the original Events URL returns 404.
     */
    if (response?.status() === 404) {
      const parsed = new URL(sourceUrl);
      const match = parsed.pathname.match(
        /^\/pages\/([^/]+)\/(\d+)\/?$/i,
      );

      if (match) {
        const alternate = new URL(
          `/${match[1]}-${match[2]}/events/`,
          "https://www.facebook.com",
        );

        response = await page.goto(alternate.href, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
      }
    }

    if (!response || !response.ok()) {
      throw new Error(
        `Facebook events page returned HTTP ${response?.status() ?? "unknown"}`,
      );
    }

    await page.waitForTimeout(5000);

    const text = await pageText(page);

    /*
     * Facebook may return HTTP 200 with an unavailable-content page.
     * This is not evidence that the Page has no Events source.
     * Preserve the validation failure without marking Facebook exhausted.
     */
    if (/This content isn't available right now/i.test(text)) {
      throw new Error(
        "Facebook Events page is unavailable or access restricted",
      );
    }

    if (/log in to view this 18\+ content/i.test(text)) {
      throw new Error("Facebook Page requires login to view 18+ content");
    }

    if (/\bUnofficial Page\b/i.test(text)) {
      throw new Error("Facebook Page is unofficial and has no supported event source");
    }

    const currentUrl = page.url();

    // Detector validation only: Facebook's global discovery feed is
    // not evidence that the requested Page publishes these events.
    // Harvesting does not use this validation-only check.
    if (options.validatePageIdentity) {
      const destination = new URL(currentUrl);
      if (
        /(^|\\.)facebook\\.com$/i.test(destination.hostname) &&
        /^\\/events\\/?$/i.test(destination.pathname)
      ) {
        throw new Error(
          "Facebook Page Events redirected to global Events discovery feed",
        );
      }
    }

    if (
      /facebook\.com\/(?:login|login\.php|checkpoint)(?:[/?]|$)/i.test(currentUrl)
    ) {
      throw new Error("Facebook Events page requires login");
    }

    const hasLoginForm =
      /\bLog In\b/i.test(text) &&
      /\bEmail or phone number\b/i.test(text) &&
      /\bPassword\b/i.test(text);

    const hasEventsSurface = /\bEvents\b/i.test(text);

    if (!hasEventsSurface) {
      if (hasLoginForm && !/\bPosts\b/i.test(text)) {
        throw new Error("Facebook Events page requires login");
      }

      throw new Error("Facebook Page has no public Events surface");
    }

    const stubs = await discoverEventStubs(page);
    const events: FacebookEvent[] = [];
    const now = Date.now();
    const seenExternalIds = new Set<string>();

    for (const stub of stubs) {
      const event = await fetchEventDetail(page, stub);
      if (!event) continue;

      if (
        event.rawPayload.hasRecurrenceMarker === true &&
        Array.isArray(event.rawPayload.verifiedOccurrences)
      ) {
        event.rawPayload.verifiedOccurrences =
          await discoverFacebookSeriesOccurrences(
            page,
            stub.id,
            event.rawPayload.verifiedOccurrences as FacebookOccurrence[],
          );
      }

      const candidates =
        expandFacebookEventCandidates(stub, event);

      appendEligibleFacebookEvents(
        candidates,
        events,
        seenExternalIds,
        now,
      );
    }

    return events;
  } finally {
    await browser.close();
  }
}
