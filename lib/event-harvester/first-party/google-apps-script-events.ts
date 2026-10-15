import { createHash } from "node:crypto";
import { recoveryFetch } from "@/lib/event-harvester/recovery-fetch";
import type { FirstPartyHarvestEvent } from "./types";

type CalendarEvent = {
  month: string;
  weekday: string;
  day: number;
  title: string;
  time: string;
  description: string | null;
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const WEEKDAYS: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3,
  THU: 4, FRI: 5, SAT: 6,
};

function decodeJsString(value: string): string {
  return value.replace(
    /\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[\s\S])/g,
    (_, token: string) => {
      if (token.startsWith("x") || token.startsWith("u")) {
        return String.fromCharCode(parseInt(token.slice(1), 16));
      }
      const escapes: Record<string, string> = {
        n: "\n", r: "\r", t: "\t",
        '"': '"', "'": "'", "\\": "\\", "/": "/",
      };
      return escapes[token] ?? token;
    },
  );
}

function extractUserHtml(response: string): string {
  const match = response.match(
    /goog\.script\.init\s*\(\s*"((?:\\[\s\S]|[^"\\])*)"/,
  );

  if (!match) {
    throw new Error("Google Apps Script initialization not found");
  }

  const config: unknown = JSON.parse(decodeJsString(match[1]));

  if (
    !config ||
    typeof config !== "object" ||
    !("userHtml" in config) ||
    typeof config.userHtml !== "string"
  ) {
    throw new Error("Google Apps Script userHtml not found");
  }

  return config.userHtml;
}

function decodeHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function field(html: string, className: string): string {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(
    new RegExp(
      `<div\\b[^>]*class=["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/div>`,
      "i",
    ),
  );
  return match ? decodeHtml(match[1]) : "";
}

function extractCalendarEvents(html: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];

  const months = [
    ...html.matchAll(
      /<div\b[^>]*class=["']month-card["'][^>]*>/gi,
    ),
  ];

  for (let i = 0; i < months.length; i++) {
    const start = months[i].index!;
    const end = i + 1 < months.length
      ? months[i + 1].index!
      : html.length;
    const section = html.slice(start, end);
    const month = field(section, "month-title");

    if (!MONTHS.includes(month)) continue;

    const tiles = [
      ...section.matchAll(
        /<div\b[^>]*class=["']event-tile["'][^>]*>/gi,
      ),
    ];

    for (let j = 0; j < tiles.length; j++) {
      const tileStart = tiles[j].index!;
      const tileEnd = j + 1 < tiles.length
        ? tiles[j + 1].index!
        : section.length;
      const tile = section.slice(tileStart, tileEnd);

      const day = Number(field(tile, "event-day-number"));
      const weekday = field(tile, "event-day-name").toUpperCase();
      const title = field(tile, "event-title");
      const time = field(tile, "event-time");
      const description = field(tile, "event-description");

      if (
        Number.isInteger(day) &&
        day >= 1 && day <= 31 &&
        weekday in WEEKDAYS &&
        title && time
      ) {
        events.push({
          month, day, weekday, title, time,
          description: description || null,
        });
      }
    }
  }

  return events;
}

function localToday(timeZone: string): {
  year: number; month: number; day: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(new Date());

  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
  };
}

function resolveYear(
  month: number,
  day: number,
  weekday: number,
  today: ReturnType<typeof localToday>,
): number | null {
  const candidates = [
    today.year - 1,
    today.year,
    today.year + 1,
  ].filter((year) => {
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day &&
      date.getUTCDay() === weekday
    );
  });

  const viable = candidates.filter((year) => {
    const date = Date.UTC(year, month - 1, day);
    const current = Date.UTC(
      today.year, today.month - 1, today.day,
    );
    const daysAway = (date - current) / 86400000;
    return daysAway >= -31 && daysAway <= 366;
  });

  return viable.length === 1 ? viable[0] : null;
}

function parseTimeRange(value: string): {
  startHour: number; startMinute: number;
  endHour: number; endMinute: number;
} | null {
  const match = value.match(
    /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i,
  );

  if (!match) return null;

  const convert = (hour: string, minute: string | undefined, period: string) => {
    const h = Number(hour);
    const m = Number(minute ?? 0);
    if (h < 1 || h > 12 || m > 59) return null;
    return {
      hour: h % 12 + (period.toUpperCase() === "PM" ? 12 : 0),
      minute: m,
    };
  };

  const start = convert(match[1], match[2], match[3]);
  const end = convert(match[4], match[5], match[6]);

  if (!start || !end) return null;

  return {
    startHour: start.hour,
    startMinute: start.minute,
    endHour: end.hour,
    endMinute: end.minute,
  };
}

function zonedToUtc(
  year: number, month: number, day: number,
  hour: number, minute: number, timeZone: string,
): string {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit",
    hourCycle: "h23",
  });

  for (let i = 0; i < 4; i++) {
    const parts = formatter.formatToParts(new Date(guess));
    const get = (type: string) =>
      Number(parts.find((part) => part.type === type)?.value);

    const actual = Date.UTC(
      get("year"), get("month") - 1, get("day"),
      get("hour"), get("minute"),
    );

    const difference = target - actual;
    if (difference === 0) break;
    guess += difference;
  }

  return new Date(guess).toISOString();
}

export function parseGoogleAppsScriptEvents(
  response: string,
  sourceUrl: string,
  options: { timeZone?: string } = {},
): FirstPartyHarvestEvent[] {
  const timeZone = options.timeZone ?? "America/New_York";
  const today = localToday(timeZone);
  const html = extractUserHtml(response);
  const records = extractCalendarEvents(html);
  const events: FirstPartyHarvestEvent[] = [];
  const seen = new Set<string>();

  if (records.length === 0) {
    throw new Error("Apps Script calendar has no recognizable event tiles");
  }

  for (const record of records) {
    const month = MONTHS.indexOf(record.month) + 1;
    const year = resolveYear(
      month, record.day, WEEKDAYS[record.weekday], today,
    );
    const range = parseTimeRange(record.time);

    if (!year || !range) continue;

    const startsAt = zonedToUtc(
      year, month, record.day,
      range.startHour, range.startMinute, timeZone,
    );

    const endDayOffset =
      range.endHour * 60 + range.endMinute <=
      range.startHour * 60 + range.startMinute
        ? 1 : 0;

    const endDate = new Date(
      Date.UTC(year, month - 1, record.day + endDayOffset),
    );

    const endsAt = zonedToUtc(
      endDate.getUTCFullYear(),
      endDate.getUTCMonth() + 1,
      endDate.getUTCDate(),
      range.endHour, range.endMinute, timeZone,
    );

    const identity = [
      year, month, record.day,
      record.title.toLowerCase().replace(/\s+/g, " ").trim(),
      range.startHour, range.startMinute,
    ].join("|");

    const externalEventId = createHash("sha256")
      .update(identity)
      .digest("hex")
      .slice(0, 32);

    if (seen.has(externalEventId)) continue;
    seen.add(externalEventId);

    events.push({
      externalEventId,
      sourceUrl,
      title: record.title,
      description: record.description,
      startsAt,
      endsAt,
      allDay: false,
      flyerUrl: null,
      location: null,
      venueName: null,
      venueAddress: null,
      rawPayload: {
        provider: "google_apps_script",
        timeZone,
        month: record.month,
        weekday: record.weekday,
        originalTime: record.time,
      },
    });
  }

  if (events.length === 0) {
    throw new Error("Apps Script calendar yielded no valid dated events");
  }

  return events;
}

export async function fetchGoogleAppsScriptEvents(
  sourceUrl: string,
  options: { timeZone?: string } = {},
): Promise<FirstPartyHarvestEvent[]> {
  const url = new URL(sourceUrl);

  if (
    url.hostname !== "script.google.com" ||
    !/^\/macros\/s\/[^/]+\/exec\/?$/.test(url.pathname)
  ) {
    throw new Error("Invalid Google Apps Script calendar endpoint");
  }

  const response = await recoveryFetch(sourceUrl, {
    headers: {
      "User-Agent": "TenderFans Event Harvester/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Google Apps Script returned HTTP ${response.status}`,
    );
  }

  return parseGoogleAppsScriptEvents(
    await response.text(),
    sourceUrl,
    options,
  );
}
