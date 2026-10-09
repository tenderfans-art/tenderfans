import { recoveryFetch } from "@/lib/event-harvester/recovery-fetch";
import type { FirstPartyHarvestEvent } from "./types";

type ShopifyVariant = {
  price?: unknown;
  available?: unknown;
};

type ShopifyImage = {
  src?: unknown;
};

type ShopifyProduct = {
  id?: unknown;
  title?: unknown;
  handle?: unknown;
  body_html?: unknown;
  product_type?: unknown;
  tags?: unknown;
  variants?: ShopifyVariant[] | null;
  images?: ShopifyImage[] | null;
  image?: ShopifyImage | null;
};

type ShopifyProductsResponse = {
  products?: ShopifyProduct[];
};

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sundays: 0,
  monday: 1,
  mondays: 1,
  tuesday: 2,
  tuesdays: 2,
  wednesday: 3,
  wednesdays: 3,
  thursday: 4,
  thursdays: 4,
  friday: 5,
  fridays: 5,
  saturday: 6,
  saturdays: 6,
};

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value.trim();
  return cleaned || null;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    rsquo: "’",
    lsquo: "‘",
    rdquo: "”",
    ldquo: "“",
  };

  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (match, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const code = Number.parseInt(entity.slice(2), 16);

        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }

      if (entity.startsWith("#")) {
        const code = Number.parseInt(entity.slice(1), 10);

        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }

      return named[entity.toLowerCase()] ?? match;
    },
  );
}

function htmlToText(value: unknown): string | null {
  const raw = cleanText(value);

  if (!raw) {
    return null;
  }

  const text = decodeHtmlEntities(
    raw
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p\s*>/gi, "\n")
      .replace(/<\/div\s*>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text || null;
}

function partsInTimeZone(date: Date, timeZone: string): Record<string, number> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts: Record<string, number> = {};

  for (const part of formatter.formatToParts(date)) {
    if (
      part.type === "year" ||
      part.type === "month" ||
      part.type === "day" ||
      part.type === "hour" ||
      part.type === "minute" ||
      part.type === "second"
    ) {
      parts[part.type] = Number(part.value);
    }
  }

  return parts;
}

function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wanted = Date.UTC(year, month - 1, day, hour, minute, 0);

  let guess = new Date(wanted);

  for (let i = 0; i < 3; i += 1) {
    const actual = partsInTimeZone(guess, timeZone);

    const rendered = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );

    const adjustment = wanted - rendered;

    if (adjustment === 0) {
      break;
    }

    guess = new Date(guess.getTime() + adjustment);
  }

  return guess;
}

function localDateKey(date: Date, timeZone: string): string {
  const parts = partsInTimeZone(date, timeZone);

  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function addLocalDays(
  year: number,
  month: number,
  day: number,
  days: number,
): {
  year: number;
  month: number;
  day: number;
} {
  const date = new Date(Date.UTC(year, month - 1, day + days));

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function parseClock(raw: string): {
  hour: number;
  minute: number;
} | null {
  const match = raw
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);

  if (!match) {
    return null;
  }

  const rawHour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = match[3];

  if (rawHour < 1 || rawHour > 12 || minute < 0 || minute > 59) {
    return null;
  }

  let hour = rawHour % 12;

  if (meridiem === "pm") {
    hour += 12;
  }

  return { hour, minute };
}

function tagsOf(product: ShopifyProduct): string[] {
  if (Array.isArray(product.tags)) {
    return product.tags
      .filter((tag): tag is string => typeof tag === "string")
      .map((tag) => tag.toLowerCase());
  }

  if (typeof product.tags === "string") {
    return product.tags
      .split(",")
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean);
  }

  return [];
}

function isEventProduct(product: ShopifyProduct): boolean {
  const productType = cleanText(product.product_type)?.toLowerCase();

  const tags = tagsOf(product);

  return (
    productType === "events" ||
    productType === "event" ||
    tags.includes("event") ||
    tags.includes("events")
  );
}

function isPrivateEventProduct(product: ShopifyProduct): boolean {
  const title = cleanText(product.title)?.toLowerCase() ?? "";

  const tags = tagsOf(product);

  return (
    /\bprivate\s+event\b/i.test(title) ||
    tags.includes("private event") ||
    (tags.includes("private") && tags.includes("event"))
  );
}

function productUrl(sourceUrl: string, product: ShopifyProduct): string | null {
  const handle = cleanText(product.handle);

  if (!handle) {
    return null;
  }

  try {
    const source = new URL(sourceUrl);

    return new URL(
      `/products/${encodeURIComponent(handle)}`,
      source.origin,
    ).toString();
  } catch {
    return null;
  }
}

function flyerUrl(product: ShopifyProduct): string | null {
  const primary = cleanText(product.image?.src);

  if (primary) {
    return primary;
  }

  if (Array.isArray(product.images)) {
    for (const image of product.images) {
      const src = cleanText(image?.src);

      if (src) {
        return src;
      }
    }
  }

  return null;
}

function parseExplicitOccurrence(
  text: string,
  timeZone: string,
  now: Date,
): {
  startsAt: Date;
  endsAt: Date | null;
  matchedDate: string;
  matchedTime: string;
} | null {
  /*
   * Observed Shopify event forms include:
   *
   * October 8th, 6:30PM
   * Oct.29th @ 6:30pm
   * November 3rd, 6:30 PM
   * December 13th 2-5PM
   * December 19th, 3:00PM-5:00PM
   * January 14th @ 6:30PM
   *
   * The first clock in a range may inherit AM/PM from
   * the second clock.
   */
  const match = text.match(
    /\b(January|February|March|April|May|June|July|August|September|Sept|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s*(\d{1,2})(?:st|nd|rd|th)?(?:\s*,)?(?:\s+(?:at\s+|@\s*)?|\s*@\s*)(\d{1,2}(?::\d{2})?)\s*(AM|PM)?(?:\s*[-–—]\s*(\d{1,2}(?::\d{2})?)\s*(AM|PM))?\b/i,
  );

  if (!match) {
    return null;
  }

  const month = MONTHS[match[1].toLowerCase()];

  const day = Number(match[2]);

  const startMeridiem = (match[4] ?? match[6])?.toUpperCase();

  if (!startMeridiem) {
    return null;
  }

  const startClock = parseClock(`${match[3]}${startMeridiem}`);

  const endClock =
    match[5] && match[6] ? parseClock(`${match[5]}${match[6]}`) : null;

  if (!month || !startClock || day < 1 || day > 31) {
    return null;
  }

  const localNow = partsInTimeZone(now, timeZone);

  let year = localNow.year;

  let startsAt = zonedDateTimeToUtc(
    year,
    month,
    day,
    startClock.hour,
    startClock.minute,
    timeZone,
  );

  if (startsAt.getTime() < now.getTime()) {
    year += 1;

    startsAt = zonedDateTimeToUtc(
      year,
      month,
      day,
      startClock.hour,
      startClock.minute,
      timeZone,
    );
  }

  let endsAt: Date | null = null;

  if (endClock) {
    endsAt = zonedDateTimeToUtc(
      year,
      month,
      day,
      endClock.hour,
      endClock.minute,
      timeZone,
    );

    if (endsAt <= startsAt) {
      const nextDay = addLocalDays(year, month, day, 1);

      endsAt = zonedDateTimeToUtc(
        nextDay.year,
        nextDay.month,
        nextDay.day,
        endClock.hour,
        endClock.minute,
        timeZone,
      );
    }
  }

  return {
    startsAt,
    endsAt,
    matchedDate: `${match[1]} ${match[2]}`,
    matchedTime: match[0],
  };
}

function parseWeeklyRecurrence(text: string): {
  weekday: number;
  weekdayName: string;
  hour: number;
  minute: number;
} | null {
  const match = text.match(
    /\b(Sundays?|Mondays?|Tuesdays?|Wednesdays?|Thursdays?|Fridays?|Saturdays?)\b(?:\s+(?:at|@))?\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM))\b/i,
  );

  if (!match) {
    return null;
  }

  const weekdayName = match[1].toLowerCase();

  const weekday = WEEKDAYS[weekdayName];
  const clock = parseClock(match[2]);

  if (weekday === undefined || !clock) {
    return null;
  }

  return {
    weekday,
    weekdayName: match[1],
    hour: clock.hour,
    minute: clock.minute,
  };
}

function productId(product: ShopifyProduct): string | null {
  if (typeof product.id === "string" || typeof product.id === "number") {
    const id = String(product.id).trim();
    return id || null;
  }

  return null;
}

export async function fetchShopifyEvents(
  sourceUrl: string,
  options: {
    timeZone?: string;
    weeksForward?: number;
  } = {},
): Promise<FirstPartyHarvestEvent[]> {
  const timeZone = options.timeZone ?? "America/New_York";

  const weeksForward = Math.max(1, Math.min(options.weeksForward ?? 8, 16));

  const response = await recoveryFetch(sourceUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": "TenderFans-Event-Harvester/1.0",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Shopify events source returned HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as ShopifyProductsResponse;

  const products = Array.isArray(payload.products) ? payload.products : [];

  if (products.length === 0) {
    return [];
  }

  const now = new Date();
  const localNow = partsInTimeZone(now, timeZone);

  const localNoon = zonedDateTimeToUtc(
    localNow.year,
    localNow.month,
    localNow.day,
    12,
    0,
    timeZone,
  );

  const weekdayFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  });

  const weekdayLookup: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  const todayWeekday = weekdayLookup[weekdayFormatter.format(localNoon)];

  const events: FirstPartyHarvestEvent[] = [];

  for (const product of products) {
    if (!isEventProduct(product) || isPrivateEventProduct(product)) {
      continue;
    }

    const id = productId(product);
    const title = cleanText(product.title);

    if (!id || !title) {
      continue;
    }

    const description = htmlToText(product.body_html);

    const searchable = [title, description ?? ""].join("\n");

    const url = productUrl(sourceUrl, product);

    const image = flyerUrl(product);

    /*
     * Prefer an explicit dated occurrence over recurrence
     * language if both somehow appear in the same product.
     */
    const explicit = parseExplicitOccurrence(searchable, timeZone, now);

    if (explicit) {
      events.push({
        externalEventId: `shopify:product:${id}`,
        title,
        description,
        startsAt: explicit.startsAt.toISOString(),
        endsAt: explicit.endsAt?.toISOString() ?? null,
        allDay: false,
        sourceUrl: url,
        flyerUrl: image,
        location: null,
        rawPayload: {
          platform: "shopify",
          productId: id,
          handle: cleanText(product.handle),
          occurrenceType: "explicit_date",
          matchedDate: explicit.matchedDate,
          matchedTime: explicit.matchedTime,
          timeZone,
        },
      });

      continue;
    }

    const recurring = parseWeeklyRecurrence(searchable);

    if (!recurring) {
      /*
       * Do not manufacture dates from Shopify lifecycle
       * timestamps. An event product without a parseable
       * occurrence remains unpublishable.
       */
      continue;
    }

    const daysUntil = (recurring.weekday - todayWeekday + 7) % 7;

    for (let weekOffset = 0; weekOffset < weeksForward; weekOffset += 1) {
      const occurrenceDate = addLocalDays(
        localNow.year,
        localNow.month,
        localNow.day,
        daysUntil + weekOffset * 7,
      );

      const startsAt = zonedDateTimeToUtc(
        occurrenceDate.year,
        occurrenceDate.month,
        occurrenceDate.day,
        recurring.hour,
        recurring.minute,
        timeZone,
      );

      if (startsAt.getTime() < now.getTime()) {
        continue;
      }

      const dateKey = localDateKey(startsAt, timeZone);

      events.push({
        externalEventId: `shopify:product:${id}:${dateKey}`,
        title,
        description,
        startsAt: startsAt.toISOString(),
        endsAt: null,
        allDay: false,
        sourceUrl: url,
        flyerUrl: image,
        location: null,
        rawPayload: {
          platform: "shopify",
          productId: id,
          handle: cleanText(product.handle),
          occurrenceType: "weekly",
          weekday: recurring.weekdayName,
          occurrenceDate: dateKey,
          timeZone,
        },
      });
    }
  }

  const unique = new Map<string, FirstPartyHarvestEvent>();

  for (const event of events) {
    unique.set(event.externalEventId, event);
  }

  return [...unique.values()].sort(
    (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt),
  );
}
