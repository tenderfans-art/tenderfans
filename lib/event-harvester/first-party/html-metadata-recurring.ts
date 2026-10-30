import { recoveryFetch } from "@/lib/event-harvester/recovery-fetch";
import type { FirstPartyHarvestEvent } from "./types";

const DAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday",
  "Thursday", "Friday", "Saturday",
];

type ScheduleItem = {
  day: number;
  title: string;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
};

function decode(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function metadata(html: string): string[] {
  const values: string[] = [];

  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];

    const key =
      /\b(?:name|property)=["']([^"']+)["']/i.exec(tag)?.[1];

    if (!key || ![
      "description",
      "og:description",
      "twitter:description",
    ].includes(key.toLowerCase())) {
      continue;
    }

    const content =
      /\bcontent=["']([^"']*)["']/i.exec(tag)?.[1];

    if (content) values.push(decode(content));
  }

  return [...new Set(values)];
}

function clock(value: string, period: string): {
  hour: number;
  minute: number;
} | null {
  const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;

  const h = Number(match[1]);
  const m = Number(match[2] ?? 0);

  if (h < 1 || h > 12 || m > 59) return null;

  return {
    hour: (h % 12) + (period.toLowerCase() === "pm" ? 12 : 0),
    minute: m,
  };
}

export function parseMetadataRecurringSchedule(
  html: string,
): ScheduleItem[] {
  const found = new Map<string, ScheduleItem>();

  for (const description of metadata(html)) {
    /*
     * Explicit weekday, activity and start/end times required.
     * Do not treat generic marketing descriptions as events.
     */
    const pattern =
      /\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+(.{3,100}?)\s+(\d{1,2}(?::\d{2})?)\s*(am|pm)\s*[-–—]\s*(\d{1,2}(?::\d{2})?)\s*(am|pm)\b/gi;

    for (const match of description.matchAll(pattern)) {
      const day = DAYS.findIndex(
        d => d.toLowerCase() === match[1].toLowerCase()
      );

      const title = match[2]
        .replace(/\s+/g, " ")
        .replace(/^[,;:\s]+|[,;:\s]+$/g, "")
        // "Friday nights DJ" and "Saturday night Karaoke"
        // describe the recurrence, not the event title.
        .replace(/^nights?\s+(?=\S)/i, "")
        .trim();

      const start = clock(match[3], match[4]);
      const end = clock(match[5], match[6]);

      if (day < 0 || !start || !end || title.length < 3) {
        continue;
      }

      // Ignore ordinary opening-hours entries.
      if (/^(?:open|hours|business hours|kitchen hours)$/i.test(title)) {
        continue;
      }

      const duration =
        ((end.hour * 60 + end.minute) -
         (start.hour * 60 + start.minute) + 1440) % 1440;

      if (duration === 0 || duration > 8 * 60) {
        continue;
      }

      const item = {
        day,
        title,
        startHour: start.hour,
        startMinute: start.minute,
        endHour: end.hour,
        endMinute: end.minute,
      };

      found.set(
        [day, title.toLowerCase(), start.hour, start.minute].join(":"),
        item,
      );
    }
  }

  return [...found.values()];
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const values: Record<string, number> = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = Number(part.value);
    }
  }

  return values;
}

function toUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let result = new Date(target);

  for (let i = 0; i < 4; i++) {
    const actual = zonedParts(result, timeZone);

    const observed = Date.UTC(
      actual.year, actual.month - 1, actual.day,
      actual.hour, actual.minute,
    );

    const delta = target - observed;
    if (!delta) break;

    result = new Date(result.getTime() + delta);
  }

  return result;
}

export function expandMetadataRecurringSchedule(
  html: string,
  sourceUrl: string,
  options: {
    timeZone?: string;
    weeksForward?: number;
    now?: Date;
  } = {},
): FirstPartyHarvestEvent[] {
  const items = parseMetadataRecurringSchedule(html);
  const timeZone = options.timeZone ?? "America/New_York";
  const weeks = Math.min(
    12,
    Math.max(1, Math.floor(options.weeksForward ?? 8)),
  );
  const now = options.now ?? new Date();
  const today = zonedParts(now, timeZone);

  const anchor = new Date(Date.UTC(
    today.year, today.month - 1, today.day, 12,
  ));

  const events: FirstPartyHarvestEvent[] = [];

  for (let offset = 0; offset < weeks * 7; offset++) {
    const date = new Date(anchor.getTime() + offset * 86400000);

    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const weekday = date.getUTCDay();

    for (const item of items) {
      if (item.day !== weekday) continue;

      const starts = toUtc(
        year, month, day,
        item.startHour, item.startMinute, timeZone,
      );

      const startMinutes =
        item.startHour * 60 + item.startMinute;
      const endMinutes =
        item.endHour * 60 + item.endMinute;

      const overnight = endMinutes <= startMinutes;
      const endDate = new Date(
        Date.UTC(year, month - 1, day + (overnight ? 1 : 0)),
      );

      const ends = toUtc(
        endDate.getUTCFullYear(),
        endDate.getUTCMonth() + 1,
        endDate.getUTCDate(),
        item.endHour,
        item.endMinute,
        timeZone,
      );

      if (ends.getTime() <= now.getTime()) continue;

      const dateKey = date.toISOString().slice(0, 10);
      const identity = [
        item.day,
        item.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        `${item.startHour}:${item.startMinute}`,
        dateKey,
      ].join(":");

      events.push({
        externalEventId: `html_metadata_recurring:${sourceUrl}:${identity}`,
        sourceUrl,
        title: item.title,
        description: `Weekly ${DAYS[item.day]} recurring event`,
        startsAt: starts.toISOString(),
        endsAt: ends.toISOString(),
        allDay: false,
        flyerUrl: null,
        location: null,
        venueName: null,
        venueAddress: null,
        rawPayload: {
          extraction: "html_metadata_recurring",
          recurrence: "weekly",
          weekday: DAYS[item.day],
          timeZone,
          overnight,
          publishedMetadata: true,
        },
      });
    }
  }

  return events;
}

export async function fetchHtmlMetadataRecurringEvents(
  sourceUrl: string,
  options: {
    timeZone?: string;
    weeksForward?: number;
  } = {},
): Promise<FirstPartyHarvestEvent[]> {
  const response = await recoveryFetch(sourceUrl, {
    headers: {
      Accept: "text/html",
      "User-Agent": "TenderFans Event Harvester/1.0",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Metadata source HTTP ${response.status}`);
  }

  const html = await response.text();

  return expandMetadataRecurringSchedule(html, sourceUrl, options);
}
