import type {
  FirstPartyHarvestEvent,
} from "./types";

const USER_AGENT =
  "TenderFans Event Harvester/1.0";

const DAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const ORDINAL_INDEX: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  last: -1,
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

type ParsedCard = {
  eventId: string;
  originEventId: string | null;
  title: string;
  description: string | null;
  startDate: DateParts;
  endDate: DateParts | null;
  startTime: TimeParts;
  endTime: TimeParts | null;
  recurrenceType: string;
  recurrenceText: string | null;
  flyerUrl: string | null;
};

function decodeHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function parseIsoDate(
  value: string | null,
): DateParts | null {
  if (!value) {
    return null;
  }

  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T/,
  );

  if (!match) {
    return null;
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function parseTime(
  value: string | null,
): TimeParts | null {
  if (!value) {
    return null;
  }

  const match = value.match(
    /^(\d{1,2}):(\d{2})$/,
  );

  if (!match) {
    return null;
  }

  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
}

function parseDisplayEndTime(
  html: string,
): TimeParts | null {
  const match = html.match(
    /class=["'][^"']*\bevent-time\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
  );

  if (!match) {
    return null;
  }

  const text = decodeHtml(match[1]);

  const times = [
    ...text.matchAll(
      /(\d{1,2}):(\d{2})\s*(AM|PM)/gi,
    ),
  ];

  if (times.length < 2) {
    return null;
  }

  const end = times[times.length - 1];
  let hour = Number(end[1]);
  const minute = Number(end[2]);
  const meridiem = end[3].toUpperCase();

  if (meridiem === "PM" && hour !== 12) {
    hour += 12;
  }

  if (meridiem === "AM" && hour === 12) {
    hour = 0;
  }

  return { hour, minute };
}

function localDateKey(
  parts: DateParts,
): string {
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function addLocalDays(
  parts: DateParts,
  days: number,
): DateParts {
  const date = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day + days,
      12,
    ),
  );

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function compareLocalDates(
  a: DateParts,
  b: DateParts,
): number {
  return (
    Date.UTC(a.year, a.month - 1, a.day) -
    Date.UTC(b.year, b.month - 1, b.day)
  );
}

function weekday(
  parts: DateParts,
): number {
  return new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      12,
    ),
  ).getUTCDay();
}

function partsInTimeZone(
  date: Date,
  timeZone: string,
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
    },
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

function nthWeekdayOfMonth(
  year: number,
  month: number,
  targetWeekday: number,
  ordinal: number,
): DateParts | null {
  if (ordinal === -1) {
    const last = new Date(
      Date.UTC(year, month, 0, 12),
    );

    const difference =
      (last.getUTCDay() -
        targetWeekday +
        7) %
      7;

    return {
      year,
      month,
      day: last.getUTCDate() - difference,
    };
  }

  const first = new Date(
    Date.UTC(year, month - 1, 1, 12),
  );

  const offset =
    (targetWeekday -
      first.getUTCDay() +
      7) %
    7;

  const day =
    1 + offset + (ordinal - 1) * 7;

  const candidate = new Date(
    Date.UTC(year, month - 1, day, 12),
  );

  if (
    candidate.getUTCMonth() !==
    month - 1
  ) {
    return null;
  }

  return {
    year,
    month,
    day,
  };
}

function nextMonth(
  year: number,
  month: number,
): { year: number; month: number } {
  if (month === 12) {
    return {
      year: year + 1,
      month: 1,
    };
  }

  return {
    year,
    month: month + 1,
  };
}

function extractCards(
  html: string,
): string[] {
  const marker =
    /<div\b[^>]*class=["'][^"']*\bevent-calendar-card\b[^"']*["'][^>]*>/gi;

  const matches = [
    ...html.matchAll(marker),
  ];

  return matches.map(
    (match, index) =>
      html.slice(
        match.index!,
        matches[index + 1]?.index ??
          html.indexOf(
            '<div class="events-calendar-modal',
            match.index!,
          ) ??
          html.length,
      ),
  );
}

function parseCard(
  card: string,
): ParsedCard | null {
  const opening =
    card.match(/^<div\b[^>]*>/i)?.[0];

  if (!opening) {
    return null;
  }

  const eventId =
    attribute(opening, "id");

  const startDate = parseIsoDate(
    attribute(
      opening,
      "data-event-start-date",
    ),
  );

  const startTime = parseTime(
    attribute(
      opening,
      "data-event-start-time",
    ),
  );

  const titleMatch = card.match(
    /<h2[^>]*>([\s\S]*?)<\/h2>/i,
  );

  if (
    !eventId ||
    !startDate ||
    !startTime ||
    !titleMatch
  ) {
    return null;
  }

  const hidden = card.match(
    /<div\b[^>]*data-event-id=["'][^"']+["'][^>]*>/i,
  )?.[0];

  const originEventId = hidden
    ? attribute(
        hidden,
        "data-origin-event-id",
      )
    : null;

  const recurrenceType =
    attribute(
      opening,
      "data-event-recurrence-type",
    ) ?? "";

  const infoMatch = card.match(
    /<div\b[^>]*class=["'][^"']*\bevent-info-text\b[^"']*["'][^>]*>([\s\S]*?)<div\b[^>]*class=["'][^"']*\bevent-read-more\b/i,
  );

  const infoHtml =
    infoMatch?.[1] ?? "";

  const paragraphs = [
    ...infoHtml.matchAll(
      /<p\b[^>]*>([\s\S]*?)<\/p>/gi,
    ),
  ]
    .map((match) =>
      decodeHtml(match[1]),
    )
    .filter(Boolean);

  const recurrenceText =
    paragraphs.find((value) =>
      /^every\s+/i.test(value) ||
      /^monthly\s+/i.test(value),
    ) ?? null;

  const descriptionParts =
    recurrenceText
      ? paragraphs.filter(
          (value) =>
            value !== recurrenceText,
        )
      : paragraphs;

  const imageMatch = card.match(
    /<img\b[^>]*\bsrc=(?:"([^"]+)"|'([^']+)')/i,
  );

  let flyerUrl =
    imageMatch?.[1] ??
    imageMatch?.[2] ??
    null;

  if (flyerUrl?.startsWith("//")) {
    flyerUrl = `https:${flyerUrl}`;
  }

  return {
    eventId,
    originEventId:
      originEventId?.trim() || null,
    title: decodeHtml(titleMatch[1]),
    description:
      descriptionParts.join(" ").trim() ||
      null,
    startDate,
    endDate: parseIsoDate(
      attribute(
        opening,
        "data-event-end-date",
      ),
    ),
    startTime,
    endTime: parseDisplayEndTime(card),
    recurrenceType,
    recurrenceText,
    flyerUrl,
  };
}

function makeOccurrence(
  card: ParsedCard,
  occurrenceDate: DateParts,
  options: {
    sourceUrl: string;
    timeZone: string;
    now: Date;
    horizon: Date;
  },
): FirstPartyHarvestEvent | null {
  const startsAt = zonedDateTimeToUtc(
    occurrenceDate,
    card.startTime,
    options.timeZone,
  );

  let endsAt: Date | null = null;

  if (card.endTime) {
    const startMinutes =
      card.startTime.hour * 60 +
      card.startTime.minute;

    const endMinutes =
      card.endTime.hour * 60 +
      card.endTime.minute;

    const endDate =
      endMinutes < startMinutes
        ? addLocalDays(
            occurrenceDate,
            1,
          )
        : occurrenceDate;

    endsAt = zonedDateTimeToUtc(
      endDate,
      card.endTime,
      options.timeZone,
    );
  }

  const lifecycleBoundary =
    endsAt ?? startsAt;

  if (
    lifecycleBoundary.getTime() <
      options.now.getTime() ||
    startsAt.getTime() >
      options.horizon.getTime()
  ) {
    return null;
  }

  const dateKey =
    localDateKey(occurrenceDate);

  const masterId =
    card.originEventId ??
    card.eventId;

  return {
    externalEventId:
      `spothopper:${masterId}:${dateKey}`,
    title: card.title,
    description: card.description,
    startsAt: startsAt.toISOString(),
    endsAt:
      endsAt?.toISOString() ?? null,
    allDay: false,
    sourceUrl: options.sourceUrl,
    flyerUrl: card.flyerUrl,
    location: null,
    rawPayload: {
      platform: "spothopper",
      eventId: card.eventId,
      originEventId:
        card.originEventId,
      recurrenceType:
        card.recurrenceType || null,
      recurrenceText:
        card.recurrenceText,
      occurrenceDate: dateKey,
      timeZone: options.timeZone,
    },
  };
}

function expandCard(
  card: ParsedCard,
  options: {
    sourceUrl: string;
    timeZone: string;
    weeksForward: number;
    now: Date;
  },
): FirstPartyHarvestEvent[] {
  const horizon = new Date(
    options.now.getTime() +
      options.weeksForward *
        7 *
        24 *
        60 *
        60 *
        1000,
  );

  const occurrenceOptions = {
    sourceUrl: options.sourceUrl,
    timeZone: options.timeZone,
    now: options.now,
    horizon,
  };

  const isNonRecurring =
    /does\s+not\s+repeat/i.test(
      card.recurrenceType,
    );

  if (
    isNonRecurring ||
    !card.recurrenceText
  ) {
    const event = makeOccurrence(
      card,
      card.startDate,
      occurrenceOptions,
    );

    return event ? [event] : [];
  }

  const weekly =
    card.recurrenceText.match(
      /^every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i,
    );

  if (weekly) {
    const targetWeekday =
      DAY_INDEX[
        weekly[1].toLowerCase()
      ];

    const events:
      FirstPartyHarvestEvent[] = [];

    let cursor = card.startDate;

    const startWeekday =
      weekday(cursor);

    const offset =
      (targetWeekday -
        startWeekday +
        7) %
      7;

    cursor = addLocalDays(
      cursor,
      offset,
    );

    for (
      ;
      compareLocalDates(
        cursor,
        card.endDate ??
          addLocalDays(cursor, 3650),
      ) <= 0;
      cursor = addLocalDays(
        cursor,
        7,
      )
    ) {
      const startsAt =
        zonedDateTimeToUtc(
          cursor,
          card.startTime,
          options.timeZone,
        );

      if (
        startsAt.getTime() >
        horizon.getTime()
      ) {
        break;
      }

      const event = makeOccurrence(
        card,
        cursor,
        occurrenceOptions,
      );

      if (event) {
        events.push(event);
      }
    }

    return events;
  }

  const monthly =
    card.recurrenceText.match(
      /^monthly\s+on\s+every\s+(first|second|third|fourth|last)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i,
    );

  if (monthly) {
    const ordinal =
      ORDINAL_INDEX[
        monthly[1].toLowerCase()
      ];

    const targetWeekday =
      DAY_INDEX[
        monthly[2].toLowerCase()
      ];

    const events:
      FirstPartyHarvestEvent[] = [];

    let year =
      card.startDate.year;
    let month =
      card.startDate.month;

    for (let i = 0; i < 120; i += 1) {
      const occurrence =
        nthWeekdayOfMonth(
          year,
          month,
          targetWeekday,
          ordinal,
        );

      if (occurrence) {
        const startsAt =
          zonedDateTimeToUtc(
            occurrence,
            card.startTime,
            options.timeZone,
          );

        if (
          startsAt.getTime() >
          horizon.getTime()
        ) {
          break;
        }

        if (
          compareLocalDates(
            occurrence,
            card.startDate,
          ) >= 0 &&
          (!card.endDate ||
            compareLocalDates(
              occurrence,
              card.endDate,
            ) <= 0)
        ) {
          const event =
            makeOccurrence(
              card,
              occurrence,
              occurrenceOptions,
            );

          if (event) {
            events.push(event);
          }
        }
      }

      const next =
        nextMonth(year, month);

      year = next.year;
      month = next.month;
    }

    return events;
  }

  /*
   * Do not silently invent unsupported recurrence
   * semantics. A future specimen can extend this
   * parser deliberately.
   */
  throw new Error(
    `Unsupported SpotHopper recurrence: ${card.recurrenceText}`,
  );
}


function parseLegacyClock(
  value: string,
): TimeParts | null {
  const match = value
    .trim()
    .match(
      /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i,
    );

  if (!match) {
    return null;
  }

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3].toUpperCase();

  if (meridiem === "PM" && hour !== 12) {
    hour += 12;
  }

  if (meridiem === "AM" && hour === 12) {
    hour = 0;
  }

  return { hour, minute };
}

function parseLegacyMachineDateTime(
  value: string,
): {
  date: DateParts;
  time: TimeParts;
} | null {
  const match = value
    .trim()
    .match(
      /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):\d{2}$/,
    );

  if (!match) {
    return null;
  }

  return {
    date: {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
    },
    time: {
      hour: Number(match[4]),
      minute: Number(match[5]),
    },
  };
}

function legacySections(
  html: string,
): string[] {
  const sections = [
    ...html.matchAll(
      /<section\b[^>]*>[\s\S]*?<\/section>/gi,
    ),
  ].map((match) => match[0]);

  return sections.filter(
    (section) =>
      /\bdata-event-id=(?:"[^"]+"|'[^']+')/i.test(
        section,
      ),
  );
}

function resolveLegacyDate(
  month: number,
  day: number,
  now: Date,
  timeZone: string,
): DateParts {
  const local = partsInTimeZone(
    now,
    timeZone,
  );

  const current: DateParts = {
    year: local.year,
    month: local.month,
    day: local.day,
  };

  let candidate: DateParts = {
    year: local.year,
    month,
    day,
  };

  /*
   * SpotHopper's legacy event pages omit the
   * year. Treat dates substantially behind the
   * current local date as belonging to the next
   * calendar year.
   */
  if (
    compareLocalDates(
      candidate,
      addLocalDays(current, -30),
    ) < 0
  ) {
    candidate = {
      ...candidate,
      year: candidate.year + 1,
    };
  }

  return candidate;
}

function parseLegacyEvents(
  html: string,
  options: {
    sourceUrl: string;
    timeZone: string;
    weeksForward: number;
    now: Date;
  },
): FirstPartyHarvestEvent[] {
  const monthIndex: Record<string, number> = {
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

  const horizon = new Date(
    options.now.getTime() +
      options.weeksForward *
        7 *
        24 *
        60 *
        60 *
        1000,
  );

  const events: FirstPartyHarvestEvent[] = [];

  for (const section of legacySections(html)) {
    const hidden =
      section.match(
        /<div\b[^>]*\bdata-event-id=(?:"[^"]+"|'[^']+')[^>]*>/i,
      )?.[0] ?? null;

    if (!hidden) {
      continue;
    }

    const eventId = attribute(
      hidden,
      "data-event-id",
    );

    const originEventId =
      attribute(
        hidden,
        "data-origin-event-id",
      )?.trim() ||
      eventId;

    const titleMatch = section.match(
      /<h2\b[^>]*>([\s\S]*?)<\/h2>/i,
    );

    if (!eventId || !titleMatch) {
      throw new Error(
        "SpotHopper legacy event surface contained an unparseable event",
      );
    }

    const title = decodeHtml(
      titleMatch[1],
    );

    const infoMatch = section.match(
      /<div\b[^>]*class=["'][^"']*\bevent-info-text\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    );

    const description =
      infoMatch
        ? decodeHtml(
            infoMatch[1],
          ) || null
        : null;

    const machineStartMatch =
      section.match(
        /<var\b[^>]*class=["'][^"']*\batc_date_start\b[^"']*["'][^>]*>([\s\S]*?)<\/var>/i,
      );

    const machineEndMatch =
      section.match(
        /<var\b[^>]*class=["'][^"']*\batc_date_end\b[^"']*["'][^>]*>([\s\S]*?)<\/var>/i,
      );

    const machineZoneMatch =
      section.match(
        /<var\b[^>]*class=["'][^"']*\batc_timezone\b[^"']*["'][^>]*>([\s\S]*?)<\/var>/i,
      );

    const machineStart =
      machineStartMatch
        ? parseLegacyMachineDateTime(
            decodeHtml(
              machineStartMatch[1],
            ),
          )
        : null;

    const machineEnd =
      machineEndMatch
        ? parseLegacyMachineDateTime(
            decodeHtml(
              machineEndMatch[1],
            ),
          )
        : null;

    const eventTimeZone =
      machineZoneMatch
        ? decodeHtml(
            machineZoneMatch[1],
          ) || options.timeZone
        : options.timeZone;

    let startDate: DateParts;
    let startTime: TimeParts;
    let endDate: DateParts | null = null;
    let endTime: TimeParts | null = null;

    if (machineStart) {
      startDate = machineStart.date;
      startTime = machineStart.time;

      if (machineEnd) {
        endDate = machineEnd.date;
        endTime = machineEnd.time;
      }
    } else {
      const dayMatch = section.match(
        /class=["'][^"']*\bevent-day\b[^"']*["'][^>]*>([\s\S]*?)<\//i,
      ) ??
        section.match(
          /<h3\b[^>]*>([\s\S]*?)<\/h3>/i,
        );

      const timeMatch = section.match(
        /class=["'][^"']*\bevent-time\b[^"']*["'][^>]*>([\s\S]*?)<\//i,
      );

      if (!dayMatch || !timeMatch) {
        throw new Error(
          "SpotHopper legacy event surface contained an unparseable date/time",
        );
      }

      const dayText = decodeHtml(
        dayMatch[1],
      );

      const dateMatch = dayText.match(
        /(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?/i,
      );

      const timeText = decodeHtml(
        timeMatch[1],
      );

      const times = [
        ...timeText.matchAll(
          /(\d{1,2}:\d{2}\s*(?:AM|PM))/gi,
        ),
      ];

      if (
        !dateMatch ||
        times.length === 0
      ) {
        throw new Error(
          "SpotHopper legacy event surface contained an unparseable date/time",
        );
      }

      startDate = resolveLegacyDate(
        monthIndex[
          dateMatch[1].toLowerCase()
        ],
        Number(dateMatch[2]),
        options.now,
        eventTimeZone,
      );

      const parsedStart =
        parseLegacyClock(
          times[0][1],
        );

      if (!parsedStart) {
        throw new Error(
          "SpotHopper legacy event surface contained an unparseable start time",
        );
      }

      startTime = parsedStart;

      if (times[1]) {
        endTime =
          parseLegacyClock(
            times[1][1],
          );

        if (endTime) {
          const startMinutes =
            startTime.hour * 60 +
            startTime.minute;

          const endMinutes =
            endTime.hour * 60 +
            endTime.minute;

          endDate =
            endMinutes < startMinutes
              ? addLocalDays(
                  startDate,
                  1,
                )
              : startDate;
        }
      }
    }

    const startsAt =
      zonedDateTimeToUtc(
        startDate,
        startTime,
        eventTimeZone,
      );

    const endsAt =
      endDate && endTime
        ? zonedDateTimeToUtc(
            endDate,
            endTime,
            eventTimeZone,
          )
        : null;

    const lifecycleBoundary =
      endsAt ?? startsAt;

    if (
      lifecycleBoundary.getTime() <
        options.now.getTime() ||
      startsAt.getTime() >
        horizon.getTime()
    ) {
      continue;
    }

    const dateKey =
      localDateKey(startDate);

    events.push({
      externalEventId:
        `spothopper:${originEventId}:${dateKey}`,
      title,
      description,
      startsAt: startsAt.toISOString(),
      endsAt:
        endsAt?.toISOString() ?? null,
      allDay: false,
      sourceUrl: options.sourceUrl,
      flyerUrl: null,
      location: null,
      rawPayload: {
        platform: "spothopper",
        eventId,
        originEventId,
        legacySurface: true,
        occurrenceDate: dateKey,
        timeZone: eventTimeZone,
      },
    });
  }

  return events.sort(
    (a, b) =>
      Date.parse(a.startsAt) -
      Date.parse(b.startsAt),
  );
}

async function fetchHtml(
  url: string,
): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept:
        "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "User-Agent": USER_AGENT,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `SpotHopper page returned HTTP ${response.status}`,
    );
  }

  return response.text();
}

function isSpotHopperHtml(
  html: string,
): boolean {
  return (
    /(?:static|cdn)\.spotapps\.co/i.test(
      html,
    ) ||
    /spothopper(?:app)?\.com/i.test(
      html,
    ) ||
    /\bspothopper\b/i.test(html)
  );
}

function hasEventSurface(
  html: string,
): boolean {
  return (
    /\bevent-calendar-card\b/i.test(
      html,
    ) ||
    /\bevents-general-holder\b/i.test(
      html,
    ) ||
    /\bnoEventsMessage\b/i.test(
      html,
    ) ||
    (
      /\bevents-holder\b/i.test(html) &&
      /\bevent-content\b/i.test(html) &&
      /\bdata-event-id\b/i.test(html)
    ) ||
    /we are updating our events/i.test(
      html,
    )
  );
}

function eventCandidates(
  sourceUrl: string,
  html: string,
): string[] {
  const base = new URL(sourceUrl);

  const urls: string[] = [];

  const add = (value: string) => {
    try {
      const url = new URL(
        decodeHtml(value),
        base,
      );

      if (
        url.origin === base.origin &&
        !urls.includes(url.href)
      ) {
        urls.push(url.href);
      }
    } catch {
      // Ignore malformed links.
    }
  };

  if (hasEventSurface(html)) {
    add(sourceUrl);
  }

  for (const match of html.matchAll(
    /<a\b[^>]*href=(?:"([^"]+)"|'([^']+)')[^>]*>/gi,
  )) {
    const href =
      match[1] ?? match[2];

    if (
      href &&
      /(?:^|\/)[^/?#]*events(?:\/|$|\?|#)/i.test(
        href,
      )
    ) {
      add(href);
    }
  }

  add("/-events");
  add("/events");

  return urls;
}

export async function fetchSpotHopperEvents(
  sourceUrl: string,
  options: {
    timeZone?: string;
    weeksForward?: number;
  } = {},
): Promise<FirstPartyHarvestEvent[]> {
  const timeZone =
    options.timeZone ??
    "America/New_York";

  const weeksForward =
    options.weeksForward ?? 8;

  const sourceHtml =
    await fetchHtml(sourceUrl);

  if (!isSpotHopperHtml(sourceHtml)) {
    throw new Error(
      "Source did not expose a SpotHopper / SpotApps signature",
    );
  }

  const candidates =
    eventCandidates(
      sourceUrl,
      sourceHtml,
    );

  let eventUrl: string | null = null;
  let eventHtml: string | null = null;

  for (const candidate of candidates) {
    let html: string;

    if (candidate === sourceUrl) {
      html = sourceHtml;
    } else {
      try {
        html =
          await fetchHtml(candidate);
      } catch {
        continue;
      }
    }

    if (
      isSpotHopperHtml(html) &&
      hasEventSurface(html)
    ) {
      eventUrl = candidate;
      eventHtml = html;
      break;
    }
  }

  if (!eventUrl || !eventHtml) {
    throw new Error(
      "SpotHopper site exposed no recognizable event surface",
    );
  }

  const cards =
    extractCards(eventHtml);

  if (
    cards.length === 0 &&
    /\bevents-holder\b/i.test(eventHtml) &&
    /\bdata-event-id\b/i.test(eventHtml)
  ) {
    return parseLegacyEvents(
      eventHtml,
      {
        sourceUrl: eventUrl,
        timeZone,
        weeksForward,
        now: new Date(),
      },
    );
  }

  if (cards.length === 0) {
    /*
     * A recognized SpotHopper event page can
     * legitimately have zero current inventory.
     */
    return [];
  }

  const parsed = cards.map(
    parseCard,
  );

  if (parsed.some((card) => !card)) {
    throw new Error(
      "SpotHopper event surface contained an unparseable event card",
    );
  }

  const now = new Date();

  return (
    parsed as ParsedCard[]
  )
    .flatMap((card) =>
      expandCard(card, {
        sourceUrl: eventUrl!,
        timeZone,
        weeksForward,
        now,
      }),
    )
    .sort(
      (a, b) =>
        Date.parse(a.startsAt) -
        Date.parse(b.startsAt),
    );
}
