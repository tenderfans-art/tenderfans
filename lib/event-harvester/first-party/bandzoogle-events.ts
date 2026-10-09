import { recoveryFetch } from "@/lib/event-harvester/recovery-fetch";
import type {
  FirstPartyHarvestEvent,
} from "./types";

type BandzoogleOccurrence = {
  eventId: string;
  occurrenceId: string;
  eventUrl: string;
};

function decodeHtmlText(value: string): string {
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

function stripHtml(value: string): string {
  return decodeHtmlText(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function metaContent(
  html: string,
  name: string
): string | null {
  const escaped = name.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );

  const patterns = [
    new RegExp(
      `<meta\\b[^>]*\\bname=["']${escaped}["'][^>]*\\bcontent=["']([^"']*)["'][^>]*>`,
      "i"
    ),
    new RegExp(
      `<meta\\b[^>]*\\bcontent=["']([^"']*)["'][^>]*\\bname=["']${escaped}["'][^>]*>`,
      "i"
    ),
    new RegExp(
      `<meta\\b[^>]*\\bproperty=["']${escaped}["'][^>]*\\bcontent=["']([^"']*)["'][^>]*>`,
      "i"
    ),
    new RegExp(
      `<meta\\b[^>]*\\bcontent=["']([^"']*)["'][^>]*\\bproperty=["']${escaped}["'][^>]*>`,
      "i"
    ),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (match?.[1]) {
      return decodeHtmlText(match[1]).trim();
    }
  }

  return null;
}

function discoverFeatureId(
  html: string
): string | null {
  return (
    html.match(
      /\bclass=["'][^"']*\bcalendar_feature\b[^"']*["'][^>]*\bdata-feature-id=["'](\d+)["']/i
    )?.[1] ??
    html.match(
      /\bdata-feature-id=["'](\d+)["'][^>]*\bclass=["'][^"']*\bcalendar_feature\b/i
    )?.[1] ??
    html.match(
      /\bid=["']calendar_feature_(\d+)["']/i
    )?.[1] ??
    null
  );
}

function discoverPageCount(
  html: string
): number {
  let highest = 1;

  for (
    const match of html.matchAll(
      /[?&]calendar_page=(\d+)/gi
    )
  ) {
    const page = Number(match[1]);

    if (
      Number.isInteger(page) &&
      page > highest
    ) {
      highest = page;
    }
  }

  return highest;
}

function discoverOccurrences(
  html: string,
  pageUrl: string
): BandzoogleOccurrence[] {
  const byOccurrenceId =
    new Map<string, BandzoogleOccurrence>();

  const pattern =
    /<div\b[^>]*\bclass=["'][^"']*\bevent-detail\b[^"']*["'][^>]*\bdata-event-id=["'](\d+)["'][^>]*\bdata-occurrence-id=["'](\d+)["'][^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass=["'][^"']*\bevent-detail\b|<\/article>|<\/section>|$)/gi;

  for (const match of html.matchAll(pattern)) {
    const eventId = match[1];
    const occurrenceId = match[2];
    const block = match[3];

    const href =
      block.match(
        /href=["']([^"']*\/event\/\d+\/\d+\/[^"']+)["']/i
      )?.[1] ?? null;

    if (!href) {
      continue;
    }

    try {
      const eventUrl =
        new URL(decodeHtmlText(href), pageUrl).href;

      byOccurrenceId.set(occurrenceId, {
        eventId,
        occurrenceId,
        eventUrl,
      });
    } catch {
      // Ignore malformed occurrence links.
    }
  }

  return [...byOccurrenceId.values()];
}

function pageTitle(html: string): string | null {
  /*
   * Bandzoogle's metadata title appends the occurrence date/time.
   * The native event-title heading preserves the canonical event
   * name, so prefer it and retain metadata only as a fallback.
   */
  const value =
    html.match(
      /<h2\b[^>]*class=["'][^"']*\bevent-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i
    )?.[1] ??
    metaContent(html, "og:title") ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ??
    null;

  return value ? stripHtml(value) : null;
}

function eventDescription(
  html: string
): string | null {
  const value =
    metaContent(html, "description") ??
    metaContent(html, "og:description");

  return value ? stripHtml(value) : null;
}

function eventImage(
  html: string,
  pageUrl: string
): string | null {
  const value = metaContent(html, "og:image");

  if (!value) {
    return null;
  }

  try {
    return new URL(value, pageUrl).href;
  } catch {
    return null;
  }
}

function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function lifecycleTime(
  startsAt: string,
  endsAt: string | null
): number {
  const boundary = endsAt ?? startsAt;

  if (isDateOnly(boundary)) {
    /*
     * Date-only Bandzoogle events are all-day occurrences.
     * Keep them through the named calendar date without inventing
     * a source timezone.
     */
    return Date.parse(`${boundary}T23:59:59.999Z`);
  }

  return Date.parse(boundary);
}

async function fetchHtml(
  url: string,
  accept = "text/html"
): Promise<string> {
  const response = await recoveryFetch(url, {
    headers: {
      Accept: accept,
      "User-Agent":
        "TenderFans Event Harvester/1.0",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `Bandzoogle source returned ${response.status}: ${url}`
    );
  }

  return response.text();
}

export async function fetchBandzoogleEvents(
  sourceUrl: string
): Promise<FirstPartyHarvestEvent[]> {
  const sourceHtml = await fetchHtml(sourceUrl);

  const featureId = discoverFeatureId(sourceHtml);

  if (!featureId) {
    throw new Error(
      "Bandzoogle page exposed no calendar feature ID"
    );
  }

  const source = new URL(sourceUrl);
  const featurePath =
    `/home/features/load/calendar_feature_${featureId}.turbo_stream`;

  const occurrences =
    new Map<string, BandzoogleOccurrence>();

  /*
   * The first Turbo response advertises the last calendar page.
   * Re-check page references while traversing so the adapter is not
   * tied to the 13 pages observed on the validation venue.
   */
  let highestPage = 1;

  for (
    let page = 1;
    page <= highestPage;
    page += 1
  ) {
    const pageUrl = new URL(
      featurePath,
      source.origin
    );

    pageUrl.searchParams.set(
      "calendar_page",
      String(page)
    );

    const html = await fetchHtml(
      pageUrl.href,
      "text/vnd.turbo-stream.html,text/html,*/*"
    );

    highestPage = Math.max(
      highestPage,
      discoverPageCount(html)
    );

    for (
      const occurrence of discoverOccurrences(
        html,
        sourceUrl
      )
    ) {
      occurrences.set(
        occurrence.occurrenceId,
        occurrence
      );
    }
  }

  if (occurrences.size === 0) {
    throw new Error(
      "Bandzoogle calendar exposed no event occurrences"
    );
  }

  const events =
    new Map<string, FirstPartyHarvestEvent>();

  /*
   * Fetch occurrence pages sequentially. Bandzoogle's calendar
   * listing is the inventory surface, while each detail page exposes
   * canonical start_time/end_time metadata.
   */
  for (const occurrence of occurrences.values()) {
    const html = await fetchHtml(
      occurrence.eventUrl
    );

    const startsAt =
      metaContent(html, "start_time");

    if (!startsAt) {
      continue;
    }

    const endsAt =
      metaContent(html, "end_time");

    const title = pageTitle(html);

    if (!title) {
      continue;
    }

    const boundary = lifecycleTime(
      startsAt,
      endsAt
    );

    if (
      Number.isNaN(boundary) ||
      boundary < Date.now()
    ) {
      continue;
    }

    const canonicalUrl =
      metaContent(html, "url") ??
      metaContent(html, "og:url") ??
      occurrence.eventUrl;

    const flyerUrl =
      eventImage(html, occurrence.eventUrl);

    const description =
      eventDescription(html);

    const event: FirstPartyHarvestEvent = {
      externalEventId: occurrence.occurrenceId,
      title,
      description,
      startsAt,
      endsAt,
      allDay: isDateOnly(startsAt),
      sourceUrl: canonicalUrl,
      flyerUrl,
      location: null,
      rawPayload: {
        provider: "bandzoogle",
        eventId: occurrence.eventId,
        occurrenceId:
          occurrence.occurrenceId,
        featureId,
        startTime: startsAt,
        endTime: endsAt,
        eventUrl: canonicalUrl,
      },
    };

    events.set(
      event.externalEventId,
      event
    );
  }

  return [...events.values()].sort(
    (a, b) =>
      Date.parse(
        isDateOnly(a.startsAt)
          ? `${a.startsAt}T00:00:00Z`
          : a.startsAt
      ) -
      Date.parse(
        isDateOnly(b.startsAt)
          ? `${b.startsAt}T00:00:00Z`
          : b.startsAt
      )
  );
}
