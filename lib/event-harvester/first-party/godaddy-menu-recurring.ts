import { recoveryFetch } from "@/lib/event-harvester/recovery-fetch";
import type {
  FirstPartyHarvestEvent,
} from "./types";

const DAY_INDEX: Record<string, number> = {
  SUNDAYS: 0,
  MONDAYS: 1,
  TUESDAYS: 2,
  WEDNESDAYS: 3,
  THURSDAYS: 4,
  FRIDAYS: 5,
  SATURDAYS: 6,
};

function decodeHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&#38;", "&")
    .replaceAll("&#x26;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseClock(
  value: string,
  inheritedMeridiem?: "am" | "pm"
): { hour: number; minute: number; meridiem: "am" | "pm" } | null {
  const match = value
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);

  if (!match) {
    return null;
  }

  const rawHour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem =
    (match[3] as "am" | "pm" | undefined) ??
    inheritedMeridiem;

  if (
    !meridiem ||
    rawHour < 1 ||
    rawHour > 12 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  let hour = rawHour % 12;
  if (meridiem === "pm") {
    hour += 12;
  }

  return { hour, minute, meridiem };
}

function parseTimeRange(value: string): {
  startHour: number;
  startMinute: number;
  endHour: number | null;
  endMinute: number | null;
} | null {
  const parts = value
    .replace(/[–—]/g, "-")
    .split("-")
    .map((part) => part.trim());

  if (parts.length !== 2) {
    return null;
  }

  const startText = parts[0].toLowerCase();
  const endText = parts[1].toLowerCase();

  const startMeridiem =
    startText.match(/(am|pm)\s*$/)?.[1] as
      | "am"
      | "pm"
      | undefined;

  const endMeridiem =
    endText.match(/(am|pm)\s*$/)?.[1] as
      | "am"
      | "pm"
      | undefined;

  const start = parseClock(
    parts[0],
    endMeridiem
  );

  if (!start) {
    return null;
  }

  if (/^close$/i.test(parts[1])) {
    return {
      startHour: start.hour,
      startMinute: start.minute,
      endHour: null,
      endMinute: null,
    };
  }

  const end = parseClock(
    parts[1],
    startMeridiem
  );

  if (!end) {
    return null;
  }

  return {
    startHour: start.hour,
    startMinute: start.minute,
    endHour: end.hour,
    endMinute: end.minute,
  };
}

function partsInTimeZone(
  date: Date,
  timeZone: string
): Record<string, number> {
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
  timeZone: string
): Date {
  const targetAsUtc = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    0
  );

  let guess = new Date(targetAsUtc);

  for (let i = 0; i < 3; i += 1) {
    const actual = partsInTimeZone(guess, timeZone);

    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );

    const difference = targetAsUtc - actualAsUtc;

    if (difference === 0) {
      break;
    }

    guess = new Date(guess.getTime() + difference);
  }

  return guess;
}

function localDateKey(
  date: Date,
  timeZone: string
): string {
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
  days: number
): { year: number; month: number; day: number } {
  const date = new Date(
    Date.UTC(year, month - 1, day + days, 12)
  );

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

type RecurringItem = {
  weekday: number;
  weekdayName: string;
  title: string;
  description: string | null;
  timeText: string;
};

function extractRecurringItems(
  html: string
): RecurringItem[] {
  const categoryPattern =
    /data-aid="MENU_CATEGORY_([A-Z]+)"/g;

  const categories = [
    ...html.matchAll(categoryPattern),
  ];

  const items: RecurringItem[] = [];

  for (
    let categoryIndex = 0;
    categoryIndex < categories.length;
    categoryIndex += 1
  ) {
    const category = categories[categoryIndex];
    const weekdayName = category[1];
    const weekday = DAY_INDEX[weekdayName];

    if (weekday === undefined) {
      continue;
    }

    const categoryStart = category.index ?? 0;
    const categoryEnd =
      categoryIndex + 1 < categories.length
        ? categories[categoryIndex + 1].index ?? html.length
        : html.length;

    const body = html.slice(
      categoryStart,
      categoryEnd
    );

    const titlePattern =
      /data-aid="MENU_SECTION(\d+)_ITEM(\d+)_TITLE"[^>]*>([\s\S]*?)<\/h4>/g;

    for (const titleMatch of body.matchAll(titlePattern)) {
      const section = titleMatch[1];
      const item = titleMatch[2];
      const title = decodeHtml(titleMatch[3]);

      const pricePattern = new RegExp(
        `data-aid="MENU_SECTION${section}_ITEM${item}_PRICE"[^>]*>([\\s\\S]*?)<\\/div>`
      );

      const descriptionPattern = new RegExp(
        `data-aid="MENU_SECTION${section}_ITEM${item}_DESC"[^>]*>([\\s\\S]*?)<\\/div>`
      );

      const priceMatch = body.match(pricePattern);
      const descriptionMatch =
        body.match(descriptionPattern);

      const timeText = priceMatch
        ? decodeHtml(priceMatch[1])
        : "";

      if (
        !title ||
        !timeText ||
        !parseTimeRange(timeText)
      ) {
        continue;
      }

      items.push({
        weekday,
        weekdayName,
        title,
        description: descriptionMatch
          ? decodeHtml(descriptionMatch[1])
          : null,
        timeText,
      });
    }
  }

  return items;
}

export async function fetchGoDaddyMenuRecurringEvents(
  sourceUrl: string,
  options: {
    timeZone?: string;
    weeksForward?: number;
  } = {}
): Promise<FirstPartyHarvestEvent[]> {
  const timeZone =
    options.timeZone ?? "America/New_York";
  const weeksForward =
    Math.max(1, Math.min(options.weeksForward ?? 8, 16));

  const response = await recoveryFetch(sourceUrl, {
    headers: {
      Accept: "text/html",
      "User-Agent":
        "TenderFans Event Harvester/1.0",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `GoDaddy recurring-events page returned ${response.status}`
    );
  }

  const html = await response.text();

  if (
    !/Go Daddy Website Builder/i.test(html) ||
    !/data-aid="MENU_CATEGORY_/i.test(html)
  ) {
    throw new Error(
      "Source does not expose expected GoDaddy menu recurrence markup"
    );
  }

  const recurringItems = extractRecurringItems(html);

  if (recurringItems.length === 0) {
    throw new Error(
      "GoDaddy recurring-events page exposed no parseable recurring items"
    );
  }

  const now = new Date();
  const localNow = partsInTimeZone(now, timeZone);
  const localNoon = zonedDateTimeToUtc(
    localNow.year,
    localNow.month,
    localNow.day,
    12,
    0,
    timeZone
  );

  const weekdayFormatter = new Intl.DateTimeFormat(
    "en-US",
    {
      timeZone,
      weekday: "short",
    }
  );

  const weekdayLookup: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  const todayWeekday =
    weekdayLookup[weekdayFormatter.format(localNoon)];

  const events: FirstPartyHarvestEvent[] = [];

  for (const item of recurringItems) {
    const range = parseTimeRange(item.timeText);
    if (!range) {
      continue;
    }

    const daysUntil =
      (item.weekday - todayWeekday + 7) % 7;

    for (
      let weekOffset = 0;
      weekOffset < weeksForward;
      weekOffset += 1
    ) {
      const occurrenceDate = addLocalDays(
        localNow.year,
        localNow.month,
        localNow.day,
        daysUntil + weekOffset * 7
      );

      const startsAt = zonedDateTimeToUtc(
        occurrenceDate.year,
        occurrenceDate.month,
        occurrenceDate.day,
        range.startHour,
        range.startMinute,
        timeZone
      );

      let endsAt: Date | null = null;

      if (
        range.endHour !== null &&
        range.endMinute !== null
      ) {
        endsAt = zonedDateTimeToUtc(
          occurrenceDate.year,
          occurrenceDate.month,
          occurrenceDate.day,
          range.endHour,
          range.endMinute,
          timeZone
        );

        if (endsAt <= startsAt) {
          const nextDay = addLocalDays(
            occurrenceDate.year,
            occurrenceDate.month,
            occurrenceDate.day,
            1
          );

          endsAt = zonedDateTimeToUtc(
            nextDay.year,
            nextDay.month,
            nextDay.day,
            range.endHour,
            range.endMinute,
            timeZone
          );
        }
      }

      const lifecycleBoundary = endsAt ?? startsAt;

      if (lifecycleBoundary.getTime() < now.getTime()) {
        continue;
      }

      const dateKey = localDateKey(
        startsAt,
        timeZone
      );

      const recurringKey =
        `${item.weekdayName.toLowerCase()}:${slugify(item.title)}`;

      events.push({
        externalEventId:
          `${recurringKey}:${dateKey}`,
        title: item.title,
        description: item.description,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt?.toISOString() ?? null,
        allDay: false,
        sourceUrl,
        flyerUrl: null,
        location: null,
        rawPayload: {
          platform: "godaddy_website_builder",
          recurrence: "weekly",
          weekday: item.weekdayName,
          recurringKey,
          occurrenceDate: dateKey,
          displayedTime: item.timeText,
          timeZone,
        },
      });
    }
  }

  return events.sort(
    (a, b) =>
      Date.parse(a.startsAt) -
      Date.parse(b.startsAt)
  );
}
