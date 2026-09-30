import type { FirstPartyHarvestEvent } from "./types";

const USER_AGENT = "TenderFans Event Harvester/1.0";

type JsonLdEvent = {
  "@type"?: string;
  name?: string;
  url?: string;
  startDate?: string;
  endDate?: string;
  description?: string;
  image?: string | string[];
  eventStatus?: string;
  location?: {
    "@type"?: string;
    name?: string;
    address?: {
      streetAddress?: string;
      addressLocality?: string;
      addressRegion?: string;
      postalCode?: string;
      addressCountry?: string;
    };
  };
};

function decodeHtml(value: string): string {
  return value
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/gi, " ")
    .replace(/&amp;/gi, "&");
}

function stripHtml(value: string | undefined): string | null {
  if (!value) return null;

  const text = decodeHtml(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text || null;
}

function extractJsonLdEvents(html: string): JsonLdEvent[] {
  const events: JsonLdEvent[] = [];

  const pattern =
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html))) {
    try {
      const parsed = JSON.parse(match[1]);
      const values = Array.isArray(parsed)
        ? parsed
        : [parsed];

      for (const value of values) {
        if (
          value &&
          typeof value === "object" &&
          value["@type"] === "Event"
        ) {
          events.push(value as JsonLdEvent);
        }
      }
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  }

  return events;
}

function absoluteUrl(
  value: string | undefined,
  base: string
): string | null {
  if (!value) return null;

  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

function imageUrl(
  image: string | string[] | undefined,
  base: string
): string | null {
  const value = Array.isArray(image)
    ? image[0]
    : image;

  return absoluteUrl(value, base);
}

function extractInternalEventRecord(
  html: string
): Record<string, unknown> | null {
  /*
   * UVTix detail pages currently expose an internal JSON object
   * containing fields such as starttime, endtime, doorsopen,
   * venueid, recurrentid and urclientid.
   *
   * Locate the object conservatively from the known starttime field
   * rather than depending on a surrounding variable name.
   */
  const marker = html.indexOf('"starttime"');

  if (marker < 0) return null;

  let start = marker;

  while (start >= 0 && html[start] !== "{") {
    start -= 1;
  }

  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }

      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;

      if (depth === 0) {
        const raw = html.slice(start, i + 1);

        try {
          const parsed = JSON.parse(raw);

          if (
            parsed &&
            typeof parsed === "object" &&
            typeof parsed.starttime === "string"
          ) {
            return parsed;
          }
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function timeString(
  value: unknown
): string | null {
  if (
    typeof value !== "string" ||
    !/^\d{2}:\d{2}(?::\d{2})?$/.test(value)
  ) {
    return null;
  }

  return value.length === 5
    ? `${value}:00`
    : value;
}

function dateString(value: unknown): string | null {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : null;
}

function addDays(
  date: string,
  days: number
): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function localDateTimeToIso(
  date: string,
  time: string,
  timeZone: string
): string {
  const [year, month, day] =
    date.split("-").map(Number);

  const [hour, minute, second] =
    time.split(":").map(Number);

  let guess = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second || 0
  );

  const formatter = new Intl.DateTimeFormat(
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
  );

  for (let i = 0; i < 4; i += 1) {
    const parts = formatter.formatToParts(
      new Date(guess)
    );

    const values = Object.fromEntries(
      parts.map((part) => [
        part.type,
        part.value,
      ])
    );

    const represented = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second)
    );

    const desired = Date.UTC(
      year,
      month - 1,
      day,
      hour,
      minute,
      second || 0
    );

    const diff = desired - represented;

    if (diff === 0) break;

    guess += diff;
  }

  return new Date(guess).toISOString();
}

function eventIdentity(
  event: JsonLdEvent,
  detailUrl: string
): string {
  const match = detailUrl.match(
    /\/event\/([^/?#]+)/i
  );

  if (match?.[1]) {
    return match[1];
  }

  return [
    event.startDate ?? "unknown-date",
    event.name ?? "unknown-event",
  ]
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function formatLocation(
  location: JsonLdEvent["location"]
): string | null {
  if (!location) return null;

  const address = location.address;

  const parts = [
    location.name,
    address?.streetAddress,
    address?.addressLocality,
    address?.addressRegion,
    address?.postalCode,
  ]
    .filter(
      (value): value is string =>
        typeof value === "string" &&
        value.trim().length > 0
    )
    .map((value) => value.trim());

  return parts.length > 0
    ? parts.join(", ")
    : null;
}

async function fetchHtml(
  url: string
): Promise<{
  url: string;
  html: string;
}> {
  const response = await fetch(url, {
    headers: {
      Accept:
        "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "User-Agent": USER_AGENT,
    },
    redirect: "follow",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `UVTix source returned HTTP ${response.status}.`
    );
  }

  return {
    url: response.url || url,
    html: await response.text(),
  };
}

export async function fetchUvTixEvents(
  sourceUrl: string,
  options?: {
    timeZone?: string;
  }
): Promise<FirstPartyHarvestEvent[]> {
  const timeZone =
    options?.timeZone ?? "America/New_York";

  const calendar = await fetchHtml(sourceUrl);
  const listingEvents =
    extractJsonLdEvents(calendar.html);

  const results: FirstPartyHarvestEvent[] = [];

  for (const listing of listingEvents) {
    if (
      !listing.name ||
      !dateString(listing.startDate)
    ) {
      continue;
    }

    const detailUrl = absoluteUrl(
      listing.url,
      calendar.url
    );

    if (!detailUrl) continue;

    const detail = await fetchHtml(detailUrl);
    const detailEvents =
      extractJsonLdEvents(detail.html);

    const detailEvent =
      detailEvents.find(
        (item) => item["@type"] === "Event"
      ) ?? listing;

    const internal =
      extractInternalEventRecord(detail.html);

    if (!internal) {
      continue;
    }

    const startDate =
      dateString(detailEvent.startDate) ??
      dateString(listing.startDate);

    const startTime =
      timeString(internal.starttime);

    if (!startDate || !startTime) {
      continue;
    }

    const endTime =
      timeString(internal.endtime);

    const startsAt = localDateTimeToIso(
      startDate,
      startTime,
      timeZone
    );

    let endsAt: string | null = null;

    if (endTime) {
      const endDate =
        endTime < startTime
          ? addDays(startDate, 1)
          : startDate;

      endsAt = localDateTimeToIso(
        endDate,
        endTime,
        timeZone
      );
    }

    const title =
      detailEvent.name ??
      listing.name;

    const description =
      stripHtml(
        typeof internal.descr === "string"
          ? internal.descr
          : detailEvent.description
      );

    const flyerUrl =
      imageUrl(
        detailEvent.image ?? listing.image,
        detail.url
      );

    results.push({
      externalEventId: eventIdentity(
        detailEvent,
        detail.url
      ),
      title,
      description,
      startsAt,
      endsAt,
      allDay: false,
      sourceUrl: detail.url,
      flyerUrl,
      location: formatLocation(
        detailEvent.location ??
          listing.location
      ),
      rawPayload: {
        provider: "uvtix",
        listing,
        detail: detailEvent,
        internal,
        timeZone,
      },
    });
  }

  return results;
}
