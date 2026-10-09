import { recoveryFetch } from "@/lib/event-harvester/recovery-fetch";
import type {
  FirstPartyHarvestEvent,
} from "./types";

const USER_AGENT =
  "TenderFans Event Harvester/1.0";

type DateParts = {
  year: number;
  month: number;
  day: number;
};

type TimeParts = {
  hour: number;
  minute: number;
};

type Occurrence = {
  date: DateParts;
  startTime: TimeParts;
  endTime: TimeParts | null;
};

type EventCard = {
  url: string;
  title: string;
  description: string | null;
  flyerUrl: string | null;
};

function decodeHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replace(/&#0*39;/gi, "'")
    .replace(/&#x0*27;/gi, "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteUrl(
  value: string | null,
  baseUrl: string,
): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(
      value.replace(/^\/\//, "https://"),
      baseUrl,
    ).toString();
  } catch {
    return null;
  }
}

function attribute(
  html: string,
  name: string,
): string | null {
  const escaped = name.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );

  const match = html.match(
    new RegExp(
      `\\b${escaped}=(?:"([^"]*)"|'([^']*)')`,
      "i",
    ),
  );

  return match?.[1] ?? match?.[2] ?? null;
}

function partsInTimeZone(
  date: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
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
    },
  );

  const values: Record<string, number> = {};

  for (const part of formatter.formatToParts(date)) {
    if (
      part.type === "year" ||
      part.type === "month" ||
      part.type === "day" ||
      part.type === "hour" ||
      part.type === "minute" ||
      part.type === "second"
    ) {
      values[part.type] = Number(part.value);
    }
  }

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wanted = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    0,
  );

  let guess = new Date(wanted);

  for (let i = 0; i < 3; i += 1) {
    const actual = partsInTimeZone(
      guess,
      timeZone,
    );

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

    guess = new Date(
      guess.getTime() + adjustment,
    );
  }

  return guess;
}

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

function parseTime(
  value: string,
): TimeParts | null {
  const match = value
    .trim()
    .match(
      /^(\d{1,2}):(\d{2})\s*(am|pm)$/i,
    );

  if (!match) {
    return null;
  }

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3].toLowerCase();

  if (hour === 12) {
    hour = 0;
  }

  if (meridiem === "pm") {
    hour += 12;
  }

  return { hour, minute };
}

function parseOccurrence(
  value: string,
): Occurrence | null {
  const text = decodeHtml(value);

  const match = text.match(
    /(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}:\d{2}\s*(?:am|pm))(?:\s*-\s*(\d{1,2}:\d{2}\s*(?:am|pm)))?/i,
  );

  if (!match) {
    return null;
  }

  const month =
    MONTHS[match[1].toLowerCase()];

  const startTime = parseTime(match[4]);

  if (!month || !startTime) {
    return null;
  }

  return {
    date: {
      year: Number(match[3]),
      month,
      day: Number(match[2]),
    },
    startTime,
    endTime: match[5]
      ? parseTime(match[5])
      : null,
  };
}

function eventCards(
  html: string,
  pageUrl: string,
): EventCard[] {
  const cards: EventCard[] = [];

  const cardPattern =
    /<div\b[^>]*class=(?:"[^"]*\bevent-card\b[^"]*"|'[^']*\bevent-card\b[^']*')[^>]*>([\s\S]*?)(?=<div\b[^>]*class=(?:"[^"]*\bevent-card\b|'[^']*\bevent-card\b)|<\/div><\/div><\/div><\/div>|$)/gi;

  for (
    const match of html.matchAll(cardPattern)
  ) {
    const block = match[1];

    const hrefMatch = block.match(
      /<a\b[^>]*href=(?:"([^"]+)"|'([^']+)')[^>]*>/i,
    );

    const titleMatch = block.match(
      /<h2\b[^>]*class=(?:"[^"]*\buk-card-title\b[^"]*"|'[^']*\buk-card-title\b[^']*')[^>]*>([\s\S]*?)<\/h2>/i,
    );

    if (!hrefMatch || !titleMatch) {
      continue;
    }

    const url = absoluteUrl(
      hrefMatch[1] ?? hrefMatch[2],
      pageUrl,
    );

    const title = decodeHtml(titleMatch[1]);

    if (!url || !title) {
      continue;
    }

    const descriptionMatch = block.match(
      /<p\b[^>]*>([\s\S]*?)<\/p>/i,
    );

    const imageMatch = block.match(
      /<img\b[^>]*>/i,
    );

    const image = imageMatch
      ? absoluteUrl(
          attribute(imageMatch[0], "src"),
          pageUrl,
        )
      : null;

    cards.push({
      url,
      title,
      description: descriptionMatch
        ? decodeHtml(descriptionMatch[1]) || null
        : null,
      flyerUrl: image,
    });
  }

  const unique = new Map<
    string,
    EventCard
  >();

  for (const card of cards) {
    unique.set(card.url, card);
  }

  return [...unique.values()];
}

function upcomingOccurrences(
  html: string,
): Occurrence[] {
  const marker =
    html.search(/All upcoming dates:/i);

  if (marker < 0) {
    return [];
  }

  const tail = html.slice(
    marker,
    marker + 12000,
  );

  const listEnd = tail.search(
    /<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/i,
  );

  const section =
    listEnd >= 0
      ? tail.slice(0, listEnd)
      : tail;

  const occurrences: Occurrence[] = [];

  for (
    const match of section.matchAll(
      /<li\b[^>]*>([\s\S]*?)<\/li>/gi,
    )
  ) {
    const occurrence = parseOccurrence(
      match[1],
    );

    if (occurrence) {
      occurrences.push(occurrence);
    }
  }

  return occurrences;
}

function detailDescription(
  html: string,
): string | null {
  const marker =
    html.search(/All upcoming dates:/i);

  if (marker < 0) {
    return null;
  }

  const tail = html.slice(marker);

  const matches = [
    ...tail.matchAll(
      /<p\b[^>]*>([\s\S]*?)<\/p>/gi,
    ),
  ];

  for (const match of matches) {
    const text = decodeHtml(match[1]);

    if (
      text &&
      !/^All upcoming dates:?$/i.test(text)
    ) {
      return text;
    }
  }

  return null;
}

function detailImage(
  html: string,
  pageUrl: string,
): string | null {
  const og = html.match(
    /<meta\b[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i,
  );

  if (og) {
    return absoluteUrl(og[1], pageUrl);
  }

  const main = html.match(
    /<div\b[^>]*class=["'][^"']*\bmain-image\b[^"']*["'][^>]*>[\s\S]*?<img\b[^>]*src=["']([^"']+)["']/i,
  );

  return main
    ? absoluteUrl(main[1], pageUrl)
    : null;
}

function dateKey(
  occurrence: Occurrence,
): string {
  return [
    occurrence.date.year,
    String(occurrence.date.month)
      .padStart(2, "0"),
    String(occurrence.date.day)
      .padStart(2, "0"),
    String(occurrence.startTime.hour)
      .padStart(2, "0"),
    String(occurrence.startTime.minute)
      .padStart(2, "0"),
  ].join("-");
}

export async function fetchPwpcEventsCalendarEvents(
  sourceUrl: string,
  options: {
    timeZone?: string;
  } = {},
): Promise<FirstPartyHarvestEvent[]> {
  const timeZone =
    options.timeZone ??
    "America/New_York";

  const response = await recoveryFetch(sourceUrl, {
    headers: {
      Accept: "text/html,*/*;q=0.8",
      "User-Agent": USER_AGENT,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `PWPC events calendar returned HTTP ${response.status}.`,
    );
  }

  const html = await response.text();

  const cards = eventCards(
    html,
    response.url || sourceUrl,
  );

  const events: FirstPartyHarvestEvent[] =
    [];

  for (const card of cards) {
    const detailResponse = await recoveryFetch(
      card.url,
      {
        headers: {
          Accept: "text/html,*/*;q=0.8",
          "User-Agent": USER_AGENT,
        },
        cache: "no-store",
      },
    );

    if (!detailResponse.ok) {
      continue;
    }

    const detailHtml =
      await detailResponse.text();

    const occurrences =
      upcomingOccurrences(detailHtml);

    if (occurrences.length === 0) {
      continue;
    }

    const description =
      detailDescription(detailHtml) ??
      card.description;

    const flyerUrl =
      detailImage(
        detailHtml,
        detailResponse.url || card.url,
      ) ?? card.flyerUrl;

    for (const occurrence of occurrences) {
      const startsAt =
        zonedDateTimeToUtc(
          occurrence.date.year,
          occurrence.date.month,
          occurrence.date.day,
          occurrence.startTime.hour,
          occurrence.startTime.minute,
          timeZone,
        );

      let endsAt: Date | null = null;

      if (occurrence.endTime) {
        let endDate = {
          ...occurrence.date,
        };

        const startMinutes =
          occurrence.startTime.hour * 60 +
          occurrence.startTime.minute;

        const endMinutes =
          occurrence.endTime.hour * 60 +
          occurrence.endTime.minute;

        if (endMinutes <= startMinutes) {
          const next = new Date(
            Date.UTC(
              endDate.year,
              endDate.month - 1,
              endDate.day + 1,
            ),
          );

          endDate = {
            year: next.getUTCFullYear(),
            month:
              next.getUTCMonth() + 1,
            day: next.getUTCDate(),
          };
        }

        endsAt = zonedDateTimeToUtc(
          endDate.year,
          endDate.month,
          endDate.day,
          occurrence.endTime.hour,
          occurrence.endTime.minute,
          timeZone,
        );
      }

      events.push({
        externalEventId: [
          "pwpc",
          new URL(card.url).pathname,
          dateKey(occurrence),
        ].join(":"),
        title: card.title,
        description,
        startsAt: startsAt.toISOString(),
        endsAt:
          endsAt?.toISOString() ?? null,
        allDay: false,
        sourceUrl: card.url,
        flyerUrl,
        location: null,
        rawPayload: {
          platform: "pwpc_events_calendar",
          eventUrl: card.url,
          occurrenceDate: dateKey(
            occurrence,
          ),
          timeZone,
        },
      });
    }
  }

  const unique = new Map<
    string,
    FirstPartyHarvestEvent
  >();

  for (const event of events) {
    unique.set(
      event.externalEventId,
      event,
    );
  }

  return [...unique.values()].sort(
    (a, b) =>
      Date.parse(a.startsAt) -
      Date.parse(b.startsAt),
  );
}
