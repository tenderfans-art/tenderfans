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
  flyerUrl?: string | null;
  recurrence?: "weekly" | "monthly" | "dated";
  ordinal?: number;
  explicitMonth?: number;
  explicitDay?: number;
  explicitYear?: number | null;
  displayedDate?: string | null;
  dateConfidence?: number;
};

const WEEKDAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday",
  "Thursday", "Friday", "Saturday",
];

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function cardTime(text: string) {
  const range = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*[-–—]\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)|close)\b/i.exec(text);
  if (range) {
    const timeText = `${range[1]} - ${range[2]}`;
    if (parseTimeRange(timeText)) {
      return { timeText, index: range.index, length: range[0].length };
    }
  }

  const single = /\b(?:starting\s+at|starts?\s+at)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i.exec(text);
  if (single && parseClock(single[1])) {
    return {
      timeText: single[1],
      index: single.index,
      length: single[0].length,
    };
  }
  return null;
}

function cardFlyer(card: string, sourceUrl: string): string | null {
  for (const image of card.matchAll(/<img\b[^>]*>/gi)) {
    const tag = image[0];
    const candidates = [
      tag.match(/\bdata-src=["']([^"']+)["']/i)?.[1],
      tag.match(/\bsrc=["']([^"']+)["']/i)?.[1],
      tag.match(/\bsrcset=["']([^"',\s]+)/i)?.[1],
    ];

    for (const candidate of candidates) {
      if (
        !candidate ||
        /^data:/i.test(candidate) ||
        /transparent_placeholder|placeholder\.(?:png|gif|jpg|webp)/i.test(candidate)
      ) continue;
      try {
        const url = new URL(candidate.replace(/&amp;/g, "&"), sourceUrl);
        if (url.protocol === "https:" || url.protocol === "http:") {
          return url.href;
        }
      } catch {
        // Preserve extraction when an image URL is malformed.
      }
    }
  }
  return null;
}

function extractContentCardRecurringItems(
  html: string,
  sourceUrl: string
): RecurringItem[] {
  const items: RecurringItem[] = [];
  const seen = new Set<string>();

  // GoDaddy repeats responsive headings and restarts headline
  // numbering in separate sections. Process individual cards.
  const starts = [
    ...html.matchAll(/data-ux=["']ContentCard["']/gi),
  ].map(match => match.index ?? 0);

  for (let i = 0; i < starts.length; i++) {
    const card = html.slice(starts[i], starts[i + 1] ?? html.length);

    const headingMatch =
      /<h[1-6]\b[^>]*data-aid=["']CONTENT_HEADLINE\d+_RENDERED["'][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(card);

    if (!headingMatch) continue;

    const heading = decodeHtml(headingMatch[1]);

    const descriptionMatch =
      /data-aid=["']CONTENT_DESCRIPTION\d+_RENDERED["'][^>]*>([\s\S]*?)<\/div>/i.exec(card);

    const description = descriptionMatch
      ? decodeHtml(descriptionMatch[1])
      : "";

    const flyerUrl = cardFlyer(card, sourceUrl);

    const primaryDay = WEEKDAYS.findIndex(
      day => day.toLowerCase() === heading.toLowerCase()
    );

    const ordinalMatch =
      /\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/i.exec(
        `${heading} ${description}`
      );

    const ordinals: Record<string, number> = {
      first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
      "1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5,
    };

    const dateMatch =
      /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/i.exec(heading);

    const headingTime = cardTime(heading);
    const bodyTime = cardTime(description);
    const time = primaryDay >= 0
      ? bodyTime
      : headingTime ?? bodyTime;

    if (!time) continue;

    let title = "";
    let remainder = "";
    let weekday = primaryDay;
    let recurrence: RecurringItem["recurrence"] = "weekly";
    let ordinal: number | undefined;
    let explicitMonth: number | undefined;
    let explicitDay: number | undefined;
    let explicitYear: number | null | undefined;
    let displayedDate: string | null = null;
    let dateConfidence = 1;

    if (primaryDay >= 0) {
      title = description.slice(0, time.index)
        .replace(/[-–—:,\s]+$/, "").trim();
      remainder = description.slice(time.index + time.length).trim();

    } else if (ordinalMatch) {
      recurrence = "monthly";
      ordinal = ordinals[ordinalMatch[1].toLowerCase()];
      weekday = WEEKDAYS.findIndex(
        day => day.toLowerCase() === ordinalMatch[2].toLowerCase()
      );
      displayedDate = ordinalMatch[0];
      title = heading.slice(0, headingTime?.index ?? heading.length)
        .replace(/\s*[-–—]\s*(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?\b.*$/i, "")
        .replace(/[-–—:,\s]+$/, "").trim();
      remainder = description ||
        heading.slice(
          (headingTime?.index ?? heading.length) +
          (headingTime?.length ?? 0)
        ).trim();

    } else if (dateMatch) {
      recurrence = "dated";
      explicitMonth = MONTHS.findIndex(
        month => month.startsWith(dateMatch[1].toLowerCase().slice(0, 3))
      ) + 1;
      explicitDay = Number(dateMatch[2]);
      explicitYear = dateMatch[3] ? Number(dateMatch[3]) : null;
      displayedDate = dateMatch[0];
      dateConfidence = explicitYear ? 1 : 0.5;

      weekday = new Date(
        Date.UTC(explicitYear ?? 2024, explicitMonth - 1, explicitDay)
      ).getUTCDay();

      title = heading.slice(0, dateMatch.index)
        .replace(/[-–—:,\s]+$/, "").trim();
      remainder = description;
    } else {
      continue;
    }

    if (!title) {
      title = heading.slice(0, headingTime?.index ?? heading.length).trim();
    }
    if (!title || weekday < 0) continue;

    const weekdayName = WEEKDAYS[weekday].toUpperCase() + "S";
    const key = [
      recurrence, weekday, ordinal, explicitMonth,
      explicitDay, explicitYear, slugify(title), time.timeText,
    ].join(":");

    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      weekday, weekdayName, title,
      description: remainder || null,
      timeText: time.timeText,
      flyerUrl, recurrence, ordinal,
      explicitMonth, explicitDay, explicitYear,
      displayedDate, dateConfidence,
    });
  }

  return items;
}

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

  if (!/Go Daddy Website Builder/i.test(html)) {
    throw new Error(
      "Source is not a recognized GoDaddy Website Builder page"
    );
  }

  const recurringItems = [
    ...extractRecurringItems(html),
    ...extractContentCardRecurringItems(html, sourceUrl),
  ];

  if (!recurringItems.length) {
    throw new Error(
      "GoDaddy recurring-events page exposed no parseable items"
    );
  }

  const now = new Date();
  const localNow = partsInTimeZone(now, timeZone);
  const today = new Date(
    Date.UTC(localNow.year, localNow.month - 1, localNow.day)
  );
  const horizon = addLocalDays(
    localNow.year, localNow.month, localNow.day,
    weeksForward * 7
  );
  const horizonKey = [
    horizon.year,
    String(horizon.month).padStart(2, "0"),
    String(horizon.day).padStart(2, "0"),
  ].join("-");

  const events: FirstPartyHarvestEvent[] = [];
  const emitted = new Set<string>();

  for (const item of recurringItems) {
    const range = parseTimeRange(item.timeText) ?? (() => {
      const start = parseClock(item.timeText);
      return start ? {
        startHour: start.hour,
        startMinute: start.minute,
        endHour: null,
        endMinute: null,
      } : null;
    })();

    if (!range) continue;

    const recurrence = item.recurrence ?? "weekly";

    const dates: {
      year: number;
      month: number;
      day: number;
      inferredYear?: boolean;
    }[] = [];

    if (recurrence === "weekly") {
      const daysUntil =
        (item.weekday - today.getUTCDay() + 7) % 7;

      for (let week = 0; week < weeksForward; week++) {
        dates.push(addLocalDays(
          localNow.year, localNow.month, localNow.day,
          daysUntil + week * 7
        ));
      }

    } else if (recurrence === "monthly" && item.ordinal) {
      const monthsForward = Math.ceil(weeksForward * 7 / 28) + 1;

      for (let offset = 0; offset <= monthsForward; offset++) {
        const first = new Date(
          Date.UTC(localNow.year, localNow.month - 1 + offset, 1)
        );

        const year = first.getUTCFullYear();
        const month = first.getUTCMonth() + 1;
        const day = 1 +
          ((item.weekday - first.getUTCDay() + 7) % 7) +
          (item.ordinal - 1) * 7;

        if (
          new Date(Date.UTC(year, month - 1, day))
            .getUTCMonth() + 1 !== month
        ) continue;

        dates.push({ year, month, day });
      }

    } else if (
      recurrence === "dated" &&
      item.explicitMonth &&
      item.explicitDay
    ) {
      const years = item.explicitYear
        ? [item.explicitYear]
        : [localNow.year, localNow.year + 1];

      for (const year of years) {
        const check: Date = new Date(
          Date.UTC(year, item.explicitMonth - 1, item.explicitDay)
        );

        if (
          check.getUTCFullYear() !== year ||
          check.getUTCMonth() + 1 !== item.explicitMonth ||
          check.getUTCDate() !== item.explicitDay
        ) continue;

        dates.push({
          year,
          month: item.explicitMonth,
          day: item.explicitDay,
          inferredYear: !item.explicitYear,
        });
      }
    }

    for (const date of dates) {
      const dateKey = [
        date.year,
        String(date.month).padStart(2, "0"),
        String(date.day).padStart(2, "0"),
      ].join("-");

      if (dateKey > horizonKey) continue;

      const startsAt = zonedDateTimeToUtc(
        date.year, date.month, date.day,
        range.startHour, range.startMinute, timeZone
      );

      let endsAt: Date | null = null;

      if (
        range.endHour !== null &&
        range.endMinute !== null
      ) {
        endsAt = zonedDateTimeToUtc(
          date.year, date.month, date.day,
          range.endHour, range.endMinute, timeZone
        );

        if (endsAt <= startsAt) {
          const next = addLocalDays(
            date.year, date.month, date.day, 1
          );

          endsAt = zonedDateTimeToUtc(
            next.year, next.month, next.day,
            range.endHour, range.endMinute, timeZone
          );
        }
      }

      if ((endsAt ?? startsAt).getTime() < now.getTime()) {
        continue;
      }

      const recurringKey = recurrence === "dated"
        ? ["dated", slugify(item.title)].join(":")
        : [
            recurrence,
            item.weekdayName.toLowerCase(),
            slugify(item.title),
            item.ordinal ?? "",
          ].filter(Boolean).join(":");

      const externalEventId = `${recurringKey}:${dateKey}`;

      if (emitted.has(externalEventId)) continue;
      emitted.add(externalEventId);

      events.push({
        externalEventId,
        title: item.title,
        description: item.description,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt?.toISOString() ?? null,
        allDay: false,
        sourceUrl,
        flyerUrl: item.flyerUrl ?? null,
        location: null,
        rawPayload: {
          platform: "godaddy_website_builder",
          recurrence,
          weekday: recurrence === "dated"
            ? WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()].toUpperCase() + "S"
            : item.weekdayName,
          recurringKey,
          occurrenceDate: dateKey,
          displayedDate: item.displayedDate ?? null,
          displayedTime: item.timeText,
          dateConfidence: item.dateConfidence ?? 1,
          dateBasis: date.inferredYear
            ? "year_inferred"
            : recurrence === "dated"
              ? "event_explicit"
              : "weekday_explicit",
          yearInferred: date.inferredYear ?? false,
          requiresDateReview: date.inferredYear ?? false,
          eventEvidence: {
            requiresReview: date.inferredYear ?? false,
            reasons: date.inferredYear
              ? ["Event year inferred from month/day without explicit year"]
              : [],
            displayedDate: item.displayedDate ?? null,
            occurrenceDate: dateKey,
          },
          timeZone,
        },
      });
    }
  }

  return events.sort(
    (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)
  );
}
