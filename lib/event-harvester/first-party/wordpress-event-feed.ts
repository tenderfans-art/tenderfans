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

function parseArchiveEventLinks(
  html: string,
  sourceUrl: string,
): string[] {
  const archive = new URL(sourceUrl);
  const links: string[] = [];

  for (
    const match of html.matchAll(
      /<a\b[^>]*href=["']([^"']+)["']/gi,
    )
  ) {
    try {
      const url = new URL(
        decodeHtml(match[1]),
        archive,
      );

      if (
        url.origin !== archive.origin ||
        !/^\/events\/\d{4}\/[^/]+\/?$/i.test(
          url.pathname,
        )
      ) {
        continue;
      }

      url.search = "";
      url.hash = "";

      if (!links.includes(url.toString())) {
        links.push(url.toString());
      }
    } catch {
      // Ignore malformed links.
    }
  }

  return links;
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
  start: TimeParts | null;
  end: TimeParts | null;
} {
  const startHtml = extractClassHtml(
    html,
    "c-events__start-time",
    "span",
  );

  const endHtml = extractClassHtml(
    html,
    "c-events__end-time",
    "span",
  );

  return {
    start: startHtml ? parseClock(startHtml) : null,
    end: endHtml ? parseClock(endHtml) : null,
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

function extractPerformanceDates(
  html: string,
  eventUrl: string,
  firstDate: DateParts,
): DateParts[] {
  const section = html.match(
    /Performance Dates:\s*<\/u>\s*<\/h5>\s*<ul\b[^>]*>([\s\S]*?)<\/ul>/i,
  );

  if (!section) {
    return [];
  }

  const entries = [
    ...section[1].matchAll(
      /<li\b[^>]*>([\s\S]*?)<\/li>/gi,
    ),
  ];

  if (entries.length < 2 || entries.length > 32) {
    return [];
  }

  const dates: DateParts[] = [];

  try {
    for (const entry of entries) {
      const date = parseDisplayedDate(
        entry[1],
        eventUrl,
      );

      const timestamp = Date.UTC(
        date.year,
        date.month - 1,
        date.day,
      );

      const firstTimestamp = Date.UTC(
        firstDate.year,
        firstDate.month - 1,
        firstDate.day,
      );

      if (timestamp < firstTimestamp) {
        return [];
      }

      if (
        dates.some(
          (existing) =>
            existing.year === date.year &&
            existing.month === date.month &&
            existing.day === date.day,
        )
      ) {
        return [];
      }

      dates.push(date);
    }
  } catch {
    return [];
  }

  if (
    !dates.some(
      (date) =>
        date.year === firstDate.year &&
        date.month === firstDate.month &&
        date.day === firstDate.day,
    )
  ) {
    return [];
  }

  return dates.sort(
    (a, b) =>
      Date.UTC(a.year, a.month - 1, a.day) -
      Date.UTC(b.year, b.month - 1, b.day),
  );
}

async function parseEventPage(
  eventUrl: string,
  timeZone: string,
): Promise<FirstPartyHarvestEvent[]> {
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

  const locationEvidence =
    extractLocationEvidence(html);

  const title = extractTitle(html);
  const description = extractDescription(html);
  const flyerUrl = extractFlyerUrl(html, eventUrl);
  const baseId = eventIdFromUrl(eventUrl);

  const performanceDates = extractPerformanceDates(
    html,
    eventUrl,
    date,
  );

  const dates = performanceDates.length
    ? performanceDates
    : [date];

  return dates.map((occurrenceDate) => {
    const allDay = times.start === null;

    const startsAt = zonedDateTimeToUtc(
      occurrenceDate,
      times.start ?? { hour: 0, minute: 0 },
      timeZone,
    );

    let endsAt: Date | null = null;

    if (times.start && times.end) {
      const startMinutes =
        times.start.hour * 60 +
        times.start.minute;

      const endMinutes =
        times.end.hour * 60 +
        times.end.minute;

      endsAt = zonedDateTimeToUtc(
        endMinutes < startMinutes
          ? addDay(occurrenceDate)
          : occurrenceDate,
        times.end,
        timeZone,
      );
    }

    const isFirst =
      occurrenceDate.year === date.year &&
      occurrenceDate.month === date.month &&
      occurrenceDate.day === date.day;

    const dateKey = [
      occurrenceDate.year,
      String(occurrenceDate.month).padStart(2, "0"),
      String(occurrenceDate.day).padStart(2, "0"),
    ].join("-");

    return {
      externalEventId: isFirst
        ? baseId
        : `${baseId}:${dateKey}`,
      title,
      description,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt?.toISOString() ?? null,
      allDay,
      sourceUrl: eventUrl,
      flyerUrl,
      location: locationEvidence.location,
      venueName: locationEvidence.venueName,
      venueAddress: locationEvidence.venueAddress,
      rawPayload: {
        platform: "wordpress_event_feed",
        eventUrl,
        timeZone,
        ...(performanceDates.length
          ? {
              recurrence: "explicit_dates",
              occurrenceDate: dateKey,
            }
          : {}),
      },
    };
  });
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

  // Supplement RSS with event pages linked from the
  // public archive. Some current events are absent
  // from the WordPress RSS feed.
  const archiveUrl = new URL(sourceUrl);

  if (/\/feed\/?$/i.test(archiveUrl.pathname)) {
    archiveUrl.pathname = archiveUrl.pathname.replace(
      /feed\/?$/i,
      "",
    );
  }

  try {
    const archiveHtml = await fetchText(
      archiveUrl.toString(),
      "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    );

    for (
      const link of parseArchiveEventLinks(
        archiveHtml,
        archiveUrl.toString(),
      )
    ) {
      if (!links.includes(link)) {
        links.push(link);
      }
    }
  } catch (error) {
    console.warn(
      "WordPress archive discovery unavailable; using RSS links:",
      error,
    );
  }

  if (links.length === 0) {
    return [];
  }

  const events:
    FirstPartyHarvestEvent[] = [];

  for (const link of links) {
    events.push(
      ...(await parseEventPage(
        link,
        timeZone,
      )),
    );
  }

  return events.sort(
    (a, b) =>
      Date.parse(a.startsAt) -
      Date.parse(b.startsAt),
  );
}
