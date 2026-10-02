import type {
  FirstPartyHarvestEvent,
} from "./types";

const USER_AGENT =
  "TenderFans Event Harvester/1.0";

const DAY_INDEX: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

type FeedEvent = [
  string,
  string,
  string,
  string,
  string,
  unknown,
  string,
  ...unknown[]
];

type FeedResponse = {
  events?: FeedEvent[];
  start?: string;
  end?: string;
  error?: unknown;
};

type ParsedRule = {
  frequency: "WEEKLY";
  weekdays: number[];
  count: number | null;
  until: Date | null;
  raw: string;
};

function decodeHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseLocalDateTime(
  value: string
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} | null {
  const match = value.match(
    /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/
  );

  if (!match) {
    return null;
  }

  return {
    month: Number(match[1]),
    day: Number(match[2]),
    year: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
}

function partsInTimeZone(
  date: Date,
  timeZone: string
): Record<string, number> {
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
    }
  );

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
    const actual = partsInTimeZone(
      guess,
      timeZone
    );

    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );

    const difference =
      targetAsUtc - actualAsUtc;

    if (difference === 0) {
      break;
    }

    guess = new Date(
      guess.getTime() + difference
    );
  }

  return guess;
}

function addLocalDays(
  year: number,
  month: number,
  day: number,
  days: number
): {
  year: number;
  month: number;
  day: number;
} {
  const date = new Date(
    Date.UTC(
      year,
      month - 1,
      day + days,
      12
    )
  );

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function localDateKey(
  year: number,
  month: number,
  day: number
): string {
  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
}

function parseUntil(value: string): Date | null {
  const match = value.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/
  );

  if (!match) {
    return null;
  }

  return new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6])
    )
  );
}

function parseWeeklyRule(
  value: string
): ParsedRule | null {
  if (!value) {
    return null;
  }

  const fields = new Map<string, string>();

  for (const part of value.split(";")) {
    const separator = part.indexOf("=");

    if (separator < 1) {
      continue;
    }

    fields.set(
      part.slice(0, separator).toUpperCase(),
      part.slice(separator + 1)
    );
  }

  if (
    fields.get("FREQ")?.toUpperCase() !==
    "WEEKLY"
  ) {
    return null;
  }

  const weekdays = (
    fields.get("BYDAY") ?? ""
  )
    .split(",")
    .map((day) => DAY_INDEX[day.toUpperCase()])
    .filter(
      (day): day is number =>
        day !== undefined
    );

  if (weekdays.length === 0) {
    return null;
  }

  const rawCount = fields.get("COUNT");
  const parsedCount = rawCount
    ? Number(rawCount)
    : NaN;

  const count =
    Number.isInteger(parsedCount) &&
    parsedCount > 0
      ? parsedCount
      : null;

  const untilValue = fields.get("UNTIL");
  const until = untilValue
    ? parseUntil(untilValue)
    : null;

  return {
    frequency: "WEEKLY",
    weekdays,
    count,
    until,
    raw: value,
  };
}

function weekdayOfLocalDate(
  year: number,
  month: number,
  day: number
): number {
  return new Date(
    Date.UTC(year, month - 1, day, 12)
  ).getUTCDay();
}

function occurrenceEnd(
  start: {
    year: number;
    month: number;
    day: number;
  },
  baseStart: {
    hour: number;
    minute: number;
  },
  baseEnd: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
  } | null,
  timeZone: string
): Date | null {
  if (!baseEnd) {
    return null;
  }

  const baseStartMinutes =
    baseStart.hour * 60 + baseStart.minute;
  const baseEndMinutes =
    baseEnd.hour * 60 + baseEnd.minute;

  const crossesMidnight =
    baseEndMinutes < baseStartMinutes;

  const endDate = crossesMidnight
    ? addLocalDays(
        start.year,
        start.month,
        start.day,
        1
      )
    : start;

  return zonedDateTimeToUtc(
    endDate.year,
    endDate.month,
    endDate.day,
    baseEnd.hour,
    baseEnd.minute,
    timeZone
  );
}

function expandMaster(
  master: FeedEvent,
  options: {
    sourceUrl: string;
    timeZone: string;
    weeksForward: number;
    now: Date;
  }
): FirstPartyHarvestEvent[] {
  const [
    eventId,
    rawTitle,
    rawStart,
    rawEnd,
    rawAllDay,
    ,
    rawRule,
  ] = master;

  const baseStart =
    parseLocalDateTime(rawStart);

  if (!baseStart) {
    return [];
  }

  const baseEnd =
    parseLocalDateTime(rawEnd);

  const title = decodeHtml(rawTitle);
  const description =
    typeof master[11] === "string"
      ? decodeHtml(master[11])
      : null;

  const location =
    typeof master[9] === "string" &&
    master[9].trim()
      ? decodeHtml(master[9])
      : null;

  const hasUnspecifiedTime =
    baseStart.hour === 0 &&
    baseStart.minute === 0 &&
    baseEnd?.hour === 0 &&
    baseEnd.minute === 0;

  const allDay =
    String(rawAllDay) === "1" ||
    hasUnspecifiedTime;

  const rule = parseWeeklyRule(
    String(rawRule ?? "")
  );

  const horizon = new Date(
    options.now.getTime() +
      options.weeksForward *
        7 *
        24 *
        60 *
        60 *
        1000
  );

  const makeEvent = (
    occurrenceDate: {
      year: number;
      month: number;
      day: number;
    }
  ): FirstPartyHarvestEvent | null => {
    const startsAt = zonedDateTimeToUtc(
      occurrenceDate.year,
      occurrenceDate.month,
      occurrenceDate.day,
      baseStart.hour,
      baseStart.minute,
      options.timeZone
    );

    const calculatedEndsAt = occurrenceEnd(
      occurrenceDate,
      baseStart,
      baseEnd,
      options.timeZone
    );

    /*
     * CP Multi View uses matching 00:00 start/end values for
     * events whose actual time is unspecified. Preserve those
     * events without inventing a duration or emitting an invalid
     * zero-length interval.
     */
    const endsAt = hasUnspecifiedTime
      ? null
      : calculatedEndsAt;

    const lifecycleBoundary =
      endsAt ?? startsAt;

    if (
      lifecycleBoundary.getTime() <
        options.now.getTime() ||
      startsAt.getTime() > horizon.getTime()
    ) {
      return null;
    }

    const dateKey = localDateKey(
      occurrenceDate.year,
      occurrenceDate.month,
      occurrenceDate.day
    );

    return {
      externalEventId:
        `cp-mvc:${eventId}:${dateKey}`,
      title,
      description,
      startsAt: startsAt.toISOString(),
      endsAt:
        endsAt?.toISOString() ?? null,
      allDay,
      sourceUrl: options.sourceUrl,
      flyerUrl: null,
      location,
      rawPayload: {
        platform: "cp_multi_view_calendar",
        masterEventId: eventId,
        masterStart: rawStart,
        masterEnd: rawEnd,
        recurrenceRule:
          rawRule || null,
        occurrenceDate: dateKey,
        timeZone: options.timeZone,
        rawEvent: master,
      },
    };
  };

  if (!rule) {
    const event = makeEvent({
      year: baseStart.year,
      month: baseStart.month,
      day: baseStart.day,
    });

    return event ? [event] : [];
  }

  const events: FirstPartyHarvestEvent[] = [];
  let generated = 0;

  /*
   * Iterate from the master's local start date so
   * COUNT semantics apply to the full recurrence,
   * not merely to our current harvest window.
   */
  for (
    let offset = 0;
    offset <= 3660;
    offset += 1
  ) {
    const occurrenceDate = addLocalDays(
      baseStart.year,
      baseStart.month,
      baseStart.day,
      offset
    );

    const weekday = weekdayOfLocalDate(
      occurrenceDate.year,
      occurrenceDate.month,
      occurrenceDate.day
    );

    if (!rule.weekdays.includes(weekday)) {
      continue;
    }

    const startsAt = zonedDateTimeToUtc(
      occurrenceDate.year,
      occurrenceDate.month,
      occurrenceDate.day,
      baseStart.hour,
      baseStart.minute,
      options.timeZone
    );

    if (
      startsAt.getTime() <
      zonedDateTimeToUtc(
        baseStart.year,
        baseStart.month,
        baseStart.day,
        baseStart.hour,
        baseStart.minute,
        options.timeZone
      ).getTime()
    ) {
      continue;
    }

    if (
      rule.until &&
      startsAt.getTime() >
        rule.until.getTime()
    ) {
      break;
    }

    generated += 1;

    if (
      rule.count &&
      generated > rule.count
    ) {
      break;
    }

    if (
      startsAt.getTime() >
      horizon.getTime()
    ) {
      break;
    }

    const event = makeEvent(occurrenceDate);

    if (event) {
      events.push(event);
    }
  }

  return events;
}

export async function fetchCpMultiViewCalendarEvents(
  sourceUrl: string,
  options: {
    timeZone?: string;
    weeksForward?: number;
  } = {}
): Promise<FirstPartyHarvestEvent[]> {
  const timeZone =
    options.timeZone ?? "America/New_York";

  const weeksForward = Math.max(
    1,
    Math.min(options.weeksForward ?? 8, 16)
  );

  const pageResponse = await fetch(
    sourceUrl,
    {
      headers: {
        Accept:
          "text/html,application/xhtml+xml",
        "User-Agent": USER_AGENT,
      },
      cache: "no-store",
    }
  );

  if (!pageResponse.ok) {
    throw new Error(
      `CP Multi View Calendar page returned ${pageResponse.status}`
    );
  }

  const html = await pageResponse.text();

  if (
    !/cp-multi-view-calendar/i.test(html) &&
    !/cpmvc_ajax_object/i.test(html)
  ) {
    throw new Error(
      "Source does not expose CP Multi View Calendar markup"
    );
  }

  const nonce =
    html.match(
      /cpmvc_ajax_object\s*=\s*\{[\s\S]*?"nonce"\s*:\s*"([^"]+)"/i
    )?.[1] ?? null;

  const calendarId =
    html.match(
      /cpmvc_configmultiview\d+\s*=\s*\{[\s\S]*?\\"calendar\\"\s*:\s*\\"([^"]+)\\"/i
    )?.[1] ??
    html.match(
      /cpmvc_configmultiview\d+[\s\S]*?"calendar"\s*:\s*"([^"]+)"/i
    )?.[1] ??
    null;

  if (!nonce) {
    throw new Error(
      "CP Multi View Calendar nonce was not found"
    );
  }

  if (!calendarId) {
    throw new Error(
      "CP Multi View Calendar ID was not found"
    );
  }

  const pageUrl = new URL(sourceUrl);

  const endpoint = new URL(
    pageUrl.origin
  );

  endpoint.searchParams.set(
    "cpmvc_do_action",
    "mvparse"
  );
  endpoint.searchParams.set(
    "security",
    nonce
  );
  endpoint.searchParams.set(
    "f",
    "datafeed"
  );
  endpoint.searchParams.set(
    "method",
    "list"
  );
  endpoint.searchParams.set(
    "calid",
    calendarId
  );

  const now = new Date();
  const localNow =
    partsInTimeZone(now, timeZone);

  const horizonDate = new Date(
    now.getTime() +
      weeksForward *
        7 *
        24 *
        60 *
        60 *
        1000
  );

  const localHorizon =
    partsInTimeZone(
      horizonDate,
      timeZone
    );

  const formatRequestDate = (
    parts: Record<string, number>,
    endOfDay = false
  ) =>
    `${String(parts.month).padStart(2, "0")}/` +
    `${String(parts.day).padStart(2, "0")}/` +
    `${parts.year} ` +
    (endOfDay ? "23:59" : "00:00");

  const body = new URLSearchParams({
    showdate: formatRequestDate(localNow),
    startdate: formatRequestDate(localNow),
    enddate: formatRequestDate(
      localHorizon,
      true
    ),
    viewtype: "month",
    list_start: "",
    list_end: "",
    list_eventsPerPage: "100",
    lastdate: "",
    list_order: "asc",
    timezone: String(
      -new Date().getTimezoneOffset() / 60
    ),
  });

  const feedResponse = await fetch(
    endpoint,
    {
      method: "POST",
      headers: {
        Accept:
          "application/json,text/javascript,*/*;q=0.1",
        "Content-Type":
          "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": USER_AGENT,
        "X-Requested-With":
          "XMLHttpRequest",
        Referer: sourceUrl,
      },
      body,
      cache: "no-store",
    }
  );

  if (!feedResponse.ok) {
    throw new Error(
      `CP Multi View Calendar feed returned ${feedResponse.status}`
    );
  }

  const text =
    await feedResponse.text();

  let feed: FeedResponse;

  try {
    feed = JSON.parse(text) as FeedResponse;
  } catch {
    throw new Error(
      "CP Multi View Calendar feed did not return JSON"
    );
  }

  if (!Array.isArray(feed.events)) {
    throw new Error(
      "CP Multi View Calendar feed exposed no event array"
    );
  }

  const events = feed.events.flatMap(
    (master) =>
      expandMaster(master, {
        sourceUrl,
        timeZone,
        weeksForward,
        now,
      })
  );

  return events.sort(
    (a, b) =>
      Date.parse(a.startsAt) -
      Date.parse(b.startsAt)
  );
}
