import { recoveryFetch } from "@/lib/event-harvester/recovery-fetch";
import type { FirstPartyHarvestEvent } from "./types";

type WooProduct = {
  id?: unknown;
  name?: unknown;
  permalink?: unknown;
  description?: unknown;
  short_description?: unknown;
  categories?: Array<{ name?: unknown; slug?: unknown }>;
  images?: Array<{ src?: unknown }>;
  is_in_stock?: unknown;
  is_purchasable?: unknown;
};

const EVENT_CATEGORIES = /\b(event|events|dinner|dinners|comedy|concert|music|show|shows|ticket|tickets)\b/i;

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4,
  may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
};

function text(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#8211;|&ndash;/gi, "–")
    .replace(/\s+/g, " ")
    .trim();
}

function isEvent(product: WooProduct): boolean {
  return (product.categories ?? []).some((category) =>
    EVENT_CATEGORIES.test(
      `${text(category.name)} ${text(category.slug).replace(/-/g, " ")}`
    )
  );
}

function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  let candidate = utcGuess;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(candidate))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)])
    );

    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
    );

    const adjustment = utcGuess - represented;
    candidate += adjustment;

    if (adjustment === 0) break;
  }

  return new Date(candidate);
}

function extractVenueName(value: string): string | null {
  const match = value.match(
    /\\b(?:at|hosted by|held at)\\s+([A-Z][A-Za-z0-9&'’.-]*(?:\\s+[A-Z][A-Za-z0-9&'’.-]*){1,5})(?=\\s*(?:[,.!]|\\bon\\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)|$))/i
  );

  return match?.[1]?.trim() ?? null;
}

function parseDate(value: string, timeZone: string): Date | null {
  const match = value.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+)(20\d{2})(?:\s+(?:at|@)\s*)?(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i
  );

  if (!match) return null;

  const month = MONTHS[match[1].toLowerCase()];
  const day = Number(match[2]);
  const year = Number(match[3]);
  const rawHour = Number(match[4]);
  const minute = Number(match[5] ?? "0");

  if (!month || day < 1 || day > 31 ||
      rawHour < 1 || rawHour > 12 || minute > 59) {
    return null;
  }

  const hour = rawHour % 12 + (match[6].toUpperCase() === "PM" ? 12 : 0);

  const candidate = zonedDateTimeToUtc(
    year, month, day, hour, minute, timeZone
  );

  if (Number.isNaN(candidate.getTime())) return null;

  const localParts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(candidate);

  const local = Object.fromEntries(
    localParts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );

  if (
    local.year !== year ||
    local.month !== month ||
    local.day !== day ||
    local.hour !== hour ||
    local.minute !== minute
  ) return null;

  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day) return null;

  return candidate;
}

export async function fetchWooCommerceEvents(
  sourceUrl: string,
  options: {
    timeZone?: string;
    fetcher?: typeof fetch;
  } = {},
): Promise<FirstPartyHarvestEvent[]> {
  const timeZone = options.timeZone ?? "America/New_York";
  const fetcher = options.fetcher ?? recoveryFetch;

  const products: WooProduct[] = [];
  const seenIds = new Set<string>();

  for (let page = 1; page <= 20; page += 1) {
    const url = new URL(sourceUrl);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    const response = await fetcher(url.toString(), {
      headers: {
        Accept: "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": "Mozilla/5.0",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(
        `WooCommerce source returned HTTP ${response.status} on page ${page}.`
      );
    }

    const payload: unknown = await response.json();

    if (!Array.isArray(payload)) {
      throw new Error("WooCommerce Store API did not return a product array.");
    }

    if (payload.length === 0) break;

    let added = 0;

    for (const product of payload as WooProduct[]) {
      const id = String(product.id ?? "");
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      products.push(product);
      added += 1;
    }

    if (added === 0 || payload.length < 100) break;
  }

  const events: FirstPartyHarvestEvent[] = [];
  const now = Date.now();

  for (const product of products) {
    if (!isEvent(product)) continue;

    const id = product.id;
    const title = text(product.name);
    const description = text(product.description);
    const shortDescription = text(product.short_description);

    if ((typeof id !== "number" && typeof id !== "string") || !title) {
      continue;
    }

    const start = parseDate(
      `${title} ${shortDescription} ${description}`,
      timeZone,
    );

    if (!start || start.getTime() < now) continue;

    const venueName = extractVenueName(
      `${title} ${shortDescription} ${description}`
    );

    events.push({
      externalEventId: `woocommerce:product:${id}`,
      title,
      description: description || shortDescription || null,
      startsAt: start.toISOString(),
      endsAt: null,
      allDay: false,
      sourceUrl: text(product.permalink) || null,
      flyerUrl: text(product.images?.[0]?.src) || null,
      location: null,
      venueName,
      venueAddress: null,
      rawPayload: {
        platform: "woocommerce",
        productId: id,
        dateEvidence: "explicit_year_in_product",
        venueEvidence: venueName ? "publisher_text" : "none",
      },
    });
  }

  return events.sort(
    (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)
  );
}
