import type {
  FirstPartyHarvestEvent,
} from "./types";

const USER_AGENT =
  "TenderFans Event Harvester/1.0";

type EventsCalendarRecord = {
  id?: unknown;
  title?: unknown;
  description?: unknown;

  start?: unknown;
  end?: unknown;

  startDate?: unknown;
  endDate?: unknown;

  startHour?: unknown;
  startMinutes?: unknown;
  endHour?: unknown;
  endMinutes?: unknown;

  timezone?: unknown;

  allday?: unknown;
  dateonly?: unknown;

  location?: unknown;
  location_to_gmaps?: unknown;
  links?: unknown;
  color?: unknown;
  repeat?: unknown;
};

type EventsCalendarResponse = {
  result?: unknown;
  value?: unknown;
};

type DateParts = {
  year: number;
  month: number;
  day: number;
};

function clean(
  value: unknown,
): string | null {
  return (
    typeof value === "string" &&
    value.trim()
  )
    ? value.trim()
    : null;
}

function integer(
  value: unknown,
): number | null {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value)
  ) {
    return null;
  }

  return value;
}

function booleanValue(
  value: unknown,
): boolean | null {
  return typeof value === "boolean"
    ? value
    : null;
}

function validTimeZone(
  value: unknown,
): string | null {
  const timeZone = clean(value);

  if (!timeZone) {
    return null;
  }

  try {
    new Intl.DateTimeFormat(
      "en-US",
      { timeZone },
    ).format(new Date());

    return timeZone;
  } catch {
    return null;
  }
}

function parseDateOnly(
  value: unknown,
): DateParts | null {
  const text = clean(value);

  if (!text) {
    return null;
  }

  const match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})$/,
  );

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const check = new Date(
    Date.UTC(
      year,
      month - 1,
      day,
    ),
  );

  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    return null;
  }

  return {
    year,
    month,
    day,
  };
}

function dateFromEpochAnchor(
  value: unknown,
): DateParts | null {
  const numeric =
    typeof value === "number"
      ? value
      : (
          typeof value === "string" &&
          value.trim()
        )
        ? Number(value)
        : NaN;

  if (!Number.isFinite(numeric)) {
    return null;
  }

  const date = new Date(numeric);

  if (
    !Number.isFinite(date.getTime())
  ) {
    return null;
  }

  /*
   * EventsCalendar uses `start` / `end` as UTC
   * date anchors rather than event clock times.
   * Recover only the calendar date here.
   */
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
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
  const formatter =
    new Intl.DateTimeFormat(
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

  const values: Record<
    string,
    number
  > = {};

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
      values[part.type] =
        Number(part.value);
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

    const adjustment =
      wanted - rendered;

    if (adjustment === 0) {
      break;
    }

    guess = new Date(
      guess.getTime() + adjustment,
    );
  }

  return guess;
}

function nextDate(
  date: DateParts,
): DateParts {
  const next = new Date(
    Date.UTC(
      date.year,
      date.month - 1,
      date.day + 1,
    ),
  );

  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function datePartsFor(
  explicitDate: unknown,
  epochAnchor: unknown,
): DateParts | null {
  return (
    parseDateOnly(explicitDate) ??
    dateFromEpochAnchor(epochAnchor)
  );
}

function eventTime(
  date: DateParts,
  hourValue: unknown,
  minuteValue: unknown,
  timeZone: string,
): Date | null {
  const hour = integer(hourValue);
  const minute = integer(minuteValue);

  if (
    hour === null ||
    minute === null ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return zonedDateTimeToUtc(
    date.year,
    date.month,
    date.day,
    hour,
    minute,
    timeZone,
  );
}

function sourceUrlIsEventsCalendarApi(
  sourceUrl: string,
): boolean {
  try {
    const url = new URL(sourceUrl);

    return (
      url.hostname.toLowerCase() ===
        "inffuse.eventscalendar.co" &&
      /^\/api\/v0\.1\/projects\/[^/]+\/data\/public\/events$/i
        .test(url.pathname) &&
      url.searchParams.get("app") ===
        "calendar"
    );
  } catch {
    return false;
  }
}

export async function fetchEventsCalendarEvents(
  sourceUrl: string,
  options: {
    timeZone?: string;
  } = {},
): Promise<FirstPartyHarvestEvent[]> {
  if (
    !sourceUrlIsEventsCalendarApi(
      sourceUrl,
    )
  ) {
    throw new Error(
      "EventsCalendar source URL is not a recognized public events API.",
    );
  }

  const response = await fetch(
    sourceUrl,
    {
      headers: {
        Accept:
          "application/json,*/*;q=0.8",
        "User-Agent": USER_AGENT,
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(
      `EventsCalendar API returned HTTP ${response.status}.`,
    );
  }

  const payload =
    (await response.json()) as
      EventsCalendarResponse;

  if (
    payload.result !== true ||
    !Array.isArray(payload.value)
  ) {
    throw new Error(
      "EventsCalendar API returned an unexpected payload.",
    );
  }

  const events:
    FirstPartyHarvestEvent[] = [];

  const now = Date.now();

  for (
    const raw of payload.value
  ) {
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw)
    ) {
      continue;
    }

    const record =
      raw as EventsCalendarRecord;

    const externalEventId =
      clean(record.id);

    const title =
      clean(record.title);

    if (
      !externalEventId ||
      !title
    ) {
      continue;
    }

    const startDate =
      datePartsFor(
        record.startDate,
        record.start,
      );

    const endDate =
      datePartsFor(
        record.endDate,
        record.end,
      ) ?? startDate;

    if (
      !startDate ||
      !endDate
    ) {
      continue;
    }

    const allDay =
      booleanValue(record.allday) ===
        true ||
      booleanValue(record.dateonly) ===
        true;

    /*
     * Prefer the timezone explicitly supplied by
     * EventsCalendar. Legacy records may omit it,
     * so only use a caller-provided verified Spot
     * timezone as fallback.
     */
    const timeZone =
      validTimeZone(record.timezone) ??
      validTimeZone(
        options.timeZone,
      );

    let startsAt: Date;
    let endsAt: Date | null;

    if (allDay) {
      /*
       * Preserve date-only semantics without
       * inventing a local clock time.
       */
      startsAt = new Date(
        Date.UTC(
          startDate.year,
          startDate.month - 1,
          startDate.day,
        ),
      );

      endsAt = new Date(
        Date.UTC(
          endDate.year,
          endDate.month - 1,
          endDate.day,
        ),
      );
    } else {
      if (!timeZone) {
        continue;
      }

      const start =
        eventTime(
          startDate,
          record.startHour,
          record.startMinutes,
          timeZone,
        );

      if (!start) {
        continue;
      }

      startsAt = start;

      let effectiveEndDate =
        endDate;

      const startHour =
        integer(record.startHour);
      const startMinutes =
        integer(record.startMinutes);
      const endHour =
        integer(record.endHour);
      const endMinutes =
        integer(record.endMinutes);

      /*
       * When a same-date event ends at or before
       * its start clock time, treat the end as
       * crossing midnight, matching the existing
       * first-party calendar convention.
       */
      if (
        startHour !== null &&
        startMinutes !== null &&
        endHour !== null &&
        endMinutes !== null &&
        startDate.year ===
          endDate.year &&
        startDate.month ===
          endDate.month &&
        startDate.day ===
          endDate.day &&
        (
          endHour * 60 +
          endMinutes
        ) <=
          (
            startHour * 60 +
            startMinutes
          )
      ) {
        effectiveEndDate =
          nextDate(endDate);
      }

      endsAt =
        eventTime(
          effectiveEndDate,
          record.endHour,
          record.endMinutes,
          timeZone,
        );
    }

    const lifecycleBoundary =
      endsAt?.getTime() ??
      startsAt.getTime();

    if (
      !Number.isFinite(
        lifecycleBoundary,
      ) ||
      lifecycleBoundary < now
    ) {
      continue;
    }

    events.push({
      externalEventId,
      title,
      description:
        clean(record.description),
      startsAt:
        startsAt.toISOString(),
      endsAt:
        endsAt?.toISOString() ??
        null,
      allDay,
      sourceUrl,
      flyerUrl: null,
      location:
        clean(record.location),
      rawPayload: {
        provider:
          "eventscalendar",
        eventId:
          externalEventId,
        timeZone,
        explicitStartDate:
          clean(record.startDate),
        explicitEndDate:
          clean(record.endDate),
        startAnchor:
          record.start ?? null,
        endAnchor:
          record.end ?? null,
        dateOnly:
          booleanValue(
            record.dateonly,
          ),
        allDay:
          booleanValue(
            record.allday,
          ),
        links:
          record.links ?? null,
        repeat:
          record.repeat ?? null,
        color:
          record.color ?? null,
        locationToGoogleMaps:
          booleanValue(
            record.location_to_gmaps,
          ),
      },
    });
  }

  /*
   * Provider IDs are stable occurrence identities.
   * Keep one canonical representation per ID.
   */
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
