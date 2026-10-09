import { recoveryFetch } from "@/lib/event-harvester/recovery-fetch";
import type {
  FirstPartyHarvestEvent,
} from "./types";

const USER_AGENT = "TenderFans Event Harvester/1.0";

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

type DateParts = {
  year: number;
  month: number;
  day: number;
};

type TimeParts = {
  hour: number;
  minute: number;
};

function decodeHtml(value: string): string {
  return value
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCodePoint(Number(n)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16)),
    )
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ");
}

function textContent(value: string): string {
  return decodeHtml(
    value.replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(
  url: string,
  accept: string,
): Promise<string> {
  const response = await recoveryFetch(url, {
    headers: {
      Accept: accept,
      "User-Agent": USER_AGENT,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `WordPress event source returned HTTP ${response.status}: ${url}`,
    );
  }

  return response.text();
}

function feedUrlFromArchive(
  sourceUrl: string,
): string {
  const url = new URL(sourceUrl);

  if (/\/feed\/?$/i.test(url.pathname)) {
    return url.toString();
  }

  url.pathname =
    url.pathname.replace(/\/+$/, "") +
    "/feed/";

  url.search = "";
  url.hash = "";

  return url.toString();
}

function parseFeedLinks(
  xml: string,
): string[] {
  const items = [
    ...xml.matchAll(
      /<item\b[\s\S]*?<\/item>/gi,
    ),
  ];

  const links: string[] = [];

  for (const match of items) {
    const block = match[0];

    const linkMatch = block.match(
      /<link[^>]*>([\s\S]*?)<\/link>/i,
    );

    if (!linkMatch) {
      continue;
    }

    const link = textContent(
      linkMatch[1],
    );

    try {
      const parsed = new URL(link);

      if (
        /^https?:$/i.test(parsed.protocol) &&
        !links.includes(parsed.toString())
      ) {
        links.push(parsed.toString());
      }
    } catch {
      // Ignore malformed feed items.
    }
  }

  return links;
}

function extractClassHtml(
  html: string,
  className: string,
  tag = "[a-z0-9]+",
): string | null {
  const escaped = className.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );

  const match = html.match(
    new RegExp(
      `<(${tag})\\b[^>]*class=["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
      "i",
    ),
  );

  return match?.[2] ?? null;
}

function parseDisplayedDate(
  value: string,
  eventUrl: string,
): DateParts {
  const text = textContent(value);

  const match = text.match(
    /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,\s*(\d{4}))?$/i,
  );

  if (!match) {
    throw new Error(
      `Could not parse WordPress event date: ${text}`,
    );
  }

  const urlYear = eventUrl.match(
    /\/events\/(\d{4})(?:\/|$)/i,
  )?.[1];

  const explicitYear = match[4];

  const year = Number(
    explicitYear ?? urlYear,
  );

  if (!Number.isInteger(year)) {
    throw new Error(
      `Event year was not available for ${eventUrl}`,
    );
  }

  if (
    explicitYear &&
    urlYear &&
    explicitYear !== urlYear
  ) {
    throw new Error(
      `Event year disagrees with canonical URL for ${eventUrl}`,
    );
  }

  const month =
    MONTHS[match[2].toLowerCase()];

  const day = Number(match[3]);

  const date = new Date(
    Date.UTC(year, month - 1, day, 12),
  );

  const expectedWeekday =
    WEEKDAYS[match[1].toLowerCase()];

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCDay() !== expectedWeekday
  ) {
    throw new Error(
      `Event date failed weekday validation: ${text} (${year})`,
    );
  }

  return {
    year,
    month,
    day,
  };
}

function parseClock(
  value: string,
): TimeParts {
  const text = textContent(value);

  const match = text.match(
    /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i,
  );

  if (!match) {
    throw new Error(
      `Could not parse event time: ${text}`,
    );
  }

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");

  const meridiem =
    match[3].toLowerCase();

  if (hour === 12) {
    hour = 0;
  }

  if (meridiem === "pm") {
    hour += 12;
  }

  return { hour, minute };
}

function parseTimes(
  html: string,
): {
  start: TimeParts;
  end: TimeParts | null;
} {
  const startHtml = extractClassHtml(
    html,
    "c-events__start-time",
    "span",
  );

  if (!startHtml) {
    throw new Error(
      "WordPress event detail exposed no start time",
    );
  }

  const endHtml = extractClassHtml(
    html,
    "c-events__end-time",
    "span",
  );

  return {
    start: parseClock(startHtml),
    end: endHtml
      ? parseClock(endHtml)
      : null,
  };
}

function partsInTimeZone(
  date: Date,
  timeZone: string,
): Record<string, number> {
  const formatter =
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });

  const result:
    Record<string, number> = {};

  for (
    const part of formatter.formatToParts(
      date,
    )
  ) {
    if (
      part.type === "year" ||
      part.type === "month" ||
      part.type === "day" ||
      part.type === "hour" ||
      part.type === "minute" ||
      part.type === "second"
    ) {
      result[part.type] =
        Number(part.value);
    }
  }

  return result;
}

function zonedDateTimeToUtc(
  date: DateParts,
  time: TimeParts,
  timeZone: string,
): Date {
  const targetAsUtc = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    time.hour,
    time.minute,
    0,
  );

  let guess = new Date(targetAsUtc);

  for (let i = 0; i < 3; i += 1) {
    const actual = partsInTimeZone(
      guess,
      timeZone,
    );

    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );

    const difference =
      targetAsUtc - actualAsUtc;

    if (difference === 0) {
      break;
    }

    guess = new Date(
      guess.getTime() + difference,
    );
  }

  return guess;
}

function addDay(
  date: DateParts,
): DateParts {
  const next = new Date(
    Date.UTC(
      date.year,
      date.month - 1,
      date.day + 1,
      12,
    ),
  );

  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function extractTitle(
  html: string,
): string {
  const h1 = html.match(
    /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
  );

  if (!h1) {
    throw new Error(
      "WordPress event detail exposed no H1 title",
    );
  }

  return textContent(h1[1]);
}

function extractLocationEvidence(
  html: string,
): {
  location: string | null;
  venueName: string | null;
  venueAddress: string | null;
} {
  const address = extractClassHtml(
    html,
    "c-events-details__address",
    "div",
  );

  if (!address) {
    return {
      location: null,
      venueName: null,
      venueAddress: null,
    };
  }

  const paragraphs = [
    ...address.matchAll(
      /<p\b[^>]*>([\s\S]*?)<\/p>/gi,
    ),
  ]
    .map((match) =>
      textContent(match[1]),
    )
    .filter(Boolean);

  const location =
    paragraphs.join(", ").trim() || null;

  return {
    location,
    venueName: paragraphs[0] ?? null,
    venueAddress:
      paragraphs.length > 1
        ? paragraphs.slice(1).join(", ")
        : null,
  };
}

function extractDescription(
  html: string,
): string | null {
  const candidates = [
    "c-events-details__description",
    "c-events__description",
    "entry-content",
  ];

  for (const className of candidates) {
    const block = extractClassHtml(
      html,
      className,
      "div",
    );

    if (!block) {
      continue;
    }

    const text = textContent(block);

    if (text) {
      return text;
    }
  }

  const meta = html.match(
    /<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i,
  );

  return meta
    ? textContent(meta[1])
    : null;
}

function extractFlyerUrl(
  html: string,
  eventUrl: string,
): string | null {
  const og = html.match(
    /<meta\b[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i,
  );

  if (!og) {
    return null;
  }

  try {
    return new URL(
      decodeHtml(og[1]),
      eventUrl,
    ).toString();
  } catch {
    return null;
  }
}

function eventIdFromUrl(
  eventUrl: string,
): string {
  const url = new URL(eventUrl);

  const match = url.pathname.match(
    /\/events\/(\d{4})\/([^/]+)\/?$/i,
  );

  if (!match) {
    return `wordpress-event:${url.pathname}`;
  }

  return `wordpress-event:${match[1]}:${match[2]}`;
}

async function parseEventPage(
  eventUrl: string,
  timeZone: string,
): Promise<FirstPartyHarvestEvent> {
  const html = await fetchText(
    eventUrl,
    "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  );

  const dateHtml = extractClassHtml(
    html,
    "c-event__start-date",
    "span",
  );

  if (!dateHtml) {
    throw new Error(
      `WordPress event detail exposed no event date: ${eventUrl}`,
    );
  }

  const date = parseDisplayedDate(
    dateHtml,
    eventUrl,
  );

  const times = parseTimes(html);

  const startsAt = zonedDateTimeToUtc(
    date,
    times.start,
    timeZone,
  );

  let endsAt: Date | null = null;

  if (times.end) {
    const startMinutes =
      times.start.hour * 60 +
      times.start.minute;

    const endMinutes =
      times.end.hour * 60 +
      times.end.minute;

    endsAt = zonedDateTimeToUtc(
      endMinutes < startMinutes
        ? addDay(date)
        : date,
      times.end,
      timeZone,
    );
  }

  const locationEvidence =
    extractLocationEvidence(html);

  return {
    externalEventId:
      eventIdFromUrl(eventUrl),
    title: extractTitle(html),
    description:
      extractDescription(html),
    startsAt: startsAt.toISOString(),
    endsAt:
      endsAt?.toISOString() ?? null,
    allDay: false,
    sourceUrl: eventUrl,
    flyerUrl:
      extractFlyerUrl(html, eventUrl),
    location: locationEvidence.location,
    venueName: locationEvidence.venueName,
    venueAddress: locationEvidence.venueAddress,
    rawPayload: {
      platform: "wordpress_event_feed",
      eventUrl,
      timeZone,
    },
  };
}

export async function fetchWordPressEventFeedEvents(
  sourceUrl: string,
  options: {
    timeZone?: string;
  } = {},
): Promise<FirstPartyHarvestEvent[]> {
  const timeZone =
    options.timeZone ??
    "America/New_York";

  const feedUrl =
    feedUrlFromArchive(sourceUrl);

  const xml = await fetchText(
    feedUrl,
    "application/rss+xml,application/xml,text/xml,*/*;q=0.8",
  );

  if (
    !/<rss\b/i.test(xml) ||
    !/<item\b/i.test(xml)
  ) {
    throw new Error(
      "WordPress event feed did not expose RSS event items",
    );
  }

  const links = parseFeedLinks(xml);

  if (links.length === 0) {
    return [];
  }

  const events:
    FirstPartyHarvestEvent[] = [];

  for (const link of links) {
    events.push(
      await parseEventPage(
        link,
        timeZone,
      ),
    );
  }

  return events.sort(
    (a, b) =>
      Date.parse(a.startsAt) -
      Date.parse(b.startsAt),
  );
}
