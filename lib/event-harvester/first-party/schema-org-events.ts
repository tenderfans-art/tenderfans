import { recoveryFetch } from "@/lib/event-harvester/recovery-fetch";
const USER_AGENT = "TenderFans Event Harvester/1.0";

type JsonObject = Record<string, unknown>;

export type SchemaOrgEvent = JsonObject & {
  "@type"?: unknown;
  "@id"?: unknown;
  name?: unknown;
  url?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  description?: unknown;
  image?: unknown;
  eventStatus?: unknown;
  location?: unknown;
};

export type SchemaOrgNormalizedEvent = {
  externalEventId: string;
  sourceUrl: string | null;
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

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function typeIncludesEvent(value: unknown): boolean {
  if (typeof value === "string") {
    return value.toLowerCase() === "event";
  }

  if (Array.isArray(value)) {
    return value.some(typeIncludesEvent);
  }

  return false;
}

function collectEvents(value: unknown, events: SchemaOrgEvent[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectEvents(item, events);
    }
    return;
  }

  if (!isObject(value)) {
    return;
  }

  if (typeIncludesEvent(value["@type"])) {
    events.push(value as SchemaOrgEvent);
  }

  const graph = value["@graph"];

  if (Array.isArray(graph)) {
    for (const item of graph) {
      collectEvents(item, events);
    }
  }
}

export function extractSchemaOrgEvents(html: string): SchemaOrgEvent[] {
  const events: SchemaOrgEvent[] = [];

  const pattern =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json(?:\s*;\s*charset=[^"']+)?["'][^>]*>([\s\S]*?)<\/script>/gi;

  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html))) {
    try {
      collectEvents(JSON.parse(match[1]), events);
    } catch {
      // One malformed JSON-LD block must not invalidate the page.
    }
  }

  return events;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

function absoluteUrl(value: unknown, baseUrl: string): string | null {
  const raw = stringValue(value);

  if (!raw) {
    return null;
  }

  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

function imageUrl(value: unknown, baseUrl: string): string | null {
  if (typeof value === "string") {
    return absoluteUrl(value, baseUrl);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = imageUrl(item, baseUrl);

      if (resolved) {
        return resolved;
      }
    }

    return null;
  }

  if (isObject(value)) {
    return (
      absoluteUrl(value.url, baseUrl) ??
      absoluteUrl(value.contentUrl, baseUrl)
    );
  }

  return null;
}

function textFromHtml(value: unknown): string | null {
  const raw = stringValue(value);

  if (!raw) {
    return null;
  }

  const text = raw
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();

  return text || null;
}

function locationFields(value: unknown): {
  location: string | null;
  venueName: string | null;
  venueAddress: string | null;
} {
  if (typeof value === "string") {
    const text = value.trim() || null;

    return {
      location: text,
      venueName: text,
      venueAddress: null,
    };
  }

  if (!isObject(value)) {
    return {
      location: null,
      venueName: null,
      venueAddress: null,
    };
  }

  const venueName = stringValue(value.name);
  const address = value.address;

  if (typeof address === "string") {
    const venueAddress = address.trim() || null;

    return {
      location: venueName ?? venueAddress,
      venueName,
      venueAddress,
    };
  }

  if (!isObject(address)) {
    return {
      location: venueName,
      venueName,
      venueAddress: null,
    };
  }

  const addressParts = [
    stringValue(address.streetAddress),
    stringValue(address.addressLocality),
    stringValue(address.addressRegion),
    stringValue(address.postalCode),
    stringValue(address.addressCountry),
  ].filter((value): value is string => Boolean(value));

  const venueAddress = addressParts.length
    ? addressParts.join(", ")
    : null;

  return {
    location: venueName ?? venueAddress,
    venueName,
    venueAddress,
  };
}

function cancelled(value: unknown): boolean {
  const status = stringValue(value);

  return Boolean(
    status &&
      /(?:^|\/|#)EventCancelled$/i.test(status),
  );
}

function validDate(value: unknown): string | null {
  const raw = stringValue(value);

  if (!raw) {
    return null;
  }

  const parsed = new Date(raw);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function isAllDayValue(value: unknown): boolean {
  const raw = stringValue(value);

  return Boolean(raw && /^\d{4}-\d{2}-\d{2}$/.test(raw));
}

function stableEventId(
  event: SchemaOrgEvent,
  sourceUrl: string,
  title: string,
  startsAt: string,
): string {
  const explicitId =
    stringValue(event["@id"]) ??
    absoluteUrl(event.url, sourceUrl);

  if (explicitId) {
    return explicitId;
  }

  return [
    "schema_org",
    sourceUrl,
    title,
    startsAt,
  ].join(":");
}

export async function fetchSchemaOrgEvents(
  sourceUrl: string,
): Promise<SchemaOrgNormalizedEvent[]> {
  const response = await recoveryFetch(sourceUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "User-Agent": USER_AGENT,
    },
    redirect: "follow",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `Schema.org event source returned HTTP ${response.status}.`,
    );
  }

  const finalUrl = response.url || sourceUrl;
  const html = await response.text();
  const rawEvents = extractSchemaOrgEvents(html);

  const events: SchemaOrgNormalizedEvent[] = [];
  const seen = new Set<string>();

  for (const event of rawEvents) {
    if (cancelled(event.eventStatus)) {
      continue;
    }

    const title = stringValue(event.name);
    const startsAt = validDate(event.startDate);

    if (!title || !startsAt) {
      continue;
    }

    const endsAt = validDate(event.endDate);
    const eventUrl = absoluteUrl(event.url, finalUrl);
    const externalEventId = stableEventId(
      event,
      finalUrl,
      title,
      startsAt,
    );

    if (seen.has(externalEventId)) {
      continue;
    }

    seen.add(externalEventId);

    const location = locationFields(event.location);

    events.push({
      externalEventId,
      sourceUrl: eventUrl ?? finalUrl,
      title,
      description: textFromHtml(event.description),
      startsAt,
      endsAt,
      allDay: isAllDayValue(event.startDate),
      flyerUrl: imageUrl(event.image, finalUrl),
      location: location.location,
      venueName: location.venueName,
      venueAddress: location.venueAddress,
      rawPayload: event,
    });
  }

  events.sort(
    (a, b) =>
      Date.parse(a.startsAt) - Date.parse(b.startsAt),
  );

  return events;
}
