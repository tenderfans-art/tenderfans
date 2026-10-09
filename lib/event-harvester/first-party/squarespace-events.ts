import { recoveryFetch } from "@/lib/event-harvester/recovery-fetch";
import { parseIcsEvents } from "./ics";

import type {
  FirstPartyHarvestEvent,
} from "./types";

function decodeHtmlText(
  value: string
): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&#38;", "&")
    .replaceAll("&#x26;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function decodeHtmlAttribute(
  value: string
): string {
  return decodeHtmlText(value);
}

function discoverIcalUrls(
  html: string,
  pageUrl: string
): string[] {
  const urls = new Set<string>();

  const pattern =
    /href=["']([^"']+\?format=ical(?:&[^"']*)?)["']/gi;

  for (const match of html.matchAll(pattern)) {
    const href = decodeHtmlAttribute(match[1]);

    try {
      urls.add(new URL(href, pageUrl).href);
    } catch {
      // Ignore malformed links from source markup.
    }
  }

  return [...urls];
}

function eventPageUrl(
  icalUrl: string
): string {
  const url = new URL(icalUrl);

  url.searchParams.delete("format");

  return url.href;
}

export async function fetchSquarespaceEvents(
  sourceUrl: string
): Promise<FirstPartyHarvestEvent[]> {
  const pageResponse = await recoveryFetch(sourceUrl, {
    headers: {
      Accept: "text/html",
      "User-Agent":
        "TenderFans Event Harvester/1.0",
    },
    cache: "no-store",
  });

  if (!pageResponse.ok) {
    throw new Error(
      `Squarespace events page returned ${pageResponse.status}`
    );
  }

  const html = await pageResponse.text();
  const icalUrls =
    discoverIcalUrls(html, sourceUrl);

  if (icalUrls.length === 0) {
    throw new Error(
      "Squarespace events page exposed no iCal event links"
    );
  }

  const byExternalId =
    new Map<string, FirstPartyHarvestEvent>();

  /*
   * Squarespace exposes one ICS document per event rather than a
   * venue-wide feed. Fetch sequentially so one source scan does not
   * fan out into a large burst of requests against the venue site.
   */
  for (const icalUrl of icalUrls) {
    const response = await recoveryFetch(icalUrl, {
      headers: {
        Accept: "text/calendar",
        "User-Agent":
          "TenderFans Event Harvester/1.0",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(
        `Squarespace iCal event returned ${response.status}: ${icalUrl}`
      );
    }

    const rawIcs = await response.text();
    const parsed = parseIcsEvents(rawIcs);
    const pageUrl = eventPageUrl(icalUrl);

    for (const event of parsed) {
      /*
       * Squarespace calendar pages can retain historical events.
       * Keep an event through its scheduled end; when no end exists,
       * its start is the lifecycle boundary.
       */
      const lifecycleBoundary =
        Date.parse(event.endsAt ?? event.startsAt);

      if (
        Number.isNaN(lifecycleBoundary) ||
        lifecycleBoundary < Date.now()
      ) {
        continue;
      }

      /*
       * Squarespace's per-event ICS currently omits URL metadata.
       * Preserve the actual Squarespace event page discovered from
       * the calendar instead.
       */
      const title = decodeHtmlText(event.title);

      const enriched: FirstPartyHarvestEvent = {
        ...event,
        title,
        sourceUrl: event.sourceUrl ?? pageUrl,
        rawPayload: {
          ...event.rawPayload,
          summary: title,
          sourceUrl:
            event.sourceUrl ?? pageUrl,
          icalUrl,
        },
      };

      byExternalId.set(
        enriched.externalEventId,
        enriched
      );
    }
  }

  return [...byExternalId.values()].sort(
    (a, b) =>
      Date.parse(a.startsAt) -
      Date.parse(b.startsAt)
  );
}
