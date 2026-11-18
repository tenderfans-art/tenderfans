import {
  acquireCalendarImageAsset,
  discoverCalendarImageAssets,
  fetchCalendarImageResource,
  isCalendarPdfContentType,
  type CalendarImageAsset,
} from "./calendar-image-assets";

import {
  extractCalendarImage,
  calendarImageExtractionContract,
  type CalendarImageExtractedEvent,
} from "./calendar-image-vision";
import { reuseCalendarImageExtraction } from "./calendar-image-extraction-cache";

import type {
  FirstPartyHarvestEvent,
} from "./types";

const USER_AGENT =
  "TenderFans Event Harvester/1.0";

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

  let guess =
    new Date(wanted);

  for (
    let i = 0;
    i < 3;
    i += 1
  ) {
    const actual =
      partsInTimeZone(
        guess,
        timeZone,
      );

    const rendered =
      Date.UTC(
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

    guess =
      new Date(
        guess.getTime() +
          adjustment,
      );
  }

  return guess;
}

function validTimeZone(
  value: string,
): boolean {
  try {
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: value,
      },
    );

    return true;
  } catch {
    return false;
  }
}

function parseLocalDate(
  value: string,
): {
  year: number;
  month: number;
  day: number;
} | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})$/.exec(
      value.trim(),
    );

  if (!match) {
    return null;
  }

  const year =
    Number(match[1]);
  const month =
    Number(match[2]);
  const day =
    Number(match[3]);

  const check =
    new Date(
      Date.UTC(
        year,
        month - 1,
        day,
      ),
    );

  if (
    check.getUTCFullYear() !==
      year ||
    check.getUTCMonth() + 1 !==
      month ||
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

function parseLocalTime(
  value: string | null,
): {
  hour: number;
  minute: number;
} | null {
  if (!value) {
    return null;
  }

  const match =
    /^([01]\d|2[0-3]):([0-5]\d)$/.exec(
      value.trim(),
    );

  if (!match) {
    return null;
  }

  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
}

function addUtcDays(
  date: {
    year: number;
    month: number;
    day: number;
  },
  days: number,
): {
  year: number;
  month: number;
  day: number;
} {
  const value =
    new Date(
      Date.UTC(
        date.year,
        date.month - 1,
        date.day + days,
      ),
    );

  return {
    year:
      value.getUTCFullYear(),
    month:
      value.getUTCMonth() + 1,
    day:
      value.getUTCDate(),
  };
}

function normalizeIdentityText(
  value: string,
): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const WEEKDAY_INDEX: Record<
  string,
  number
> = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

function formatLocalDate(
  date: {
    year: number;
    month: number;
    day: number;
  },
): string {
  return [
    String(date.year).padStart(4, "0"),
    String(date.month).padStart(2, "0"),
    String(date.day).padStart(2, "0"),
  ].join("-");
}

function currentWeekDateForWeekday(
  currentDate: string,
  displayedWeekday: string,
  weekStart: "Monday" | "Sunday",
): string | null {
  const current =
    parseLocalDate(currentDate);

  const targetWeekday =
    WEEKDAY_INDEX[displayedWeekday];

  if (
    !current ||
    targetWeekday === undefined
  ) {
    return null;
  }

  const currentUtc =
    new Date(
      Date.UTC(
        current.year,
        current.month - 1,
        current.day,
      ),
    );

  const currentWeekday =
    currentUtc.getUTCDay();

  const weekStartIndex =
    WEEKDAY_INDEX[weekStart];

  const currentOffset =
    (
      currentWeekday -
      weekStartIndex +
      7
    ) % 7;

  const targetOffset =
    (
      targetWeekday -
      weekStartIndex +
      7
    ) % 7;

  return formatLocalDate(
    addUtcDays(
      current,
      targetOffset -
        currentOffset,
    ),
  );
}

type CalendarEventEvidence = {
  requiresReview: boolean;
  reviewReasons: string[];
  dateBasis:
    | "event_explicit"
    | "calendar_explicit"
    | "current_week_from_explicit_weekday"
    | null;
  displayedWeekday: string | null;
  calendarWeekStart:
    | "Monday"
    | "Sunday"
    | null;
  titleBasis: "image_explicit";
  timeBasis:
    | "event_explicit"
    | "calendar_global_rule"
    | null;
};

function resolveObservationDate(
  observation:
    CalendarImageExtractedEvent,
  currentDate: string,
  weekStart:
    | "Monday"
    | "Sunday"
    | null,
): {
  observation:
    CalendarImageExtractedEvent;
  evidence: CalendarEventEvidence;
} | null {
  if (
    observation.localDate &&
    parseLocalDate(
      observation.localDate,
    )
  ) {
    return {
      observation,
      evidence: {
        requiresReview: false,
        reviewReasons: [],
        dateBasis:
          observation.dateBasis ===
          "event_explicit"
            ? "event_explicit"
            : "calendar_explicit",
        displayedWeekday:
          observation.displayedWeekday,
        calendarWeekStart:
          weekStart,
        titleBasis:
          "image_explicit",
        timeBasis:
          observation.timeBasis,
      },
    };
  }

  if (
    observation.dateBasis !==
      "weekday_explicit" ||
    !observation.displayedWeekday ||
    !weekStart
  ) {
    return null;
  }

  const inferredDate =
    currentWeekDateForWeekday(
      currentDate,
      observation.displayedWeekday,
      weekStart,
    );

  if (!inferredDate) {
    return null;
  }

  return {
    observation: {
      ...observation,
      localDate: inferredDate,
    },
    evidence: {
      requiresReview: true,
      reviewReasons: [
        "calendar_date_inferred_from_explicit_weekday",
      ],
      dateBasis:
        "current_week_from_explicit_weekday",
      displayedWeekday:
        observation.displayedWeekday,
      calendarWeekStart:
        weekStart,
      titleBasis:
        "image_explicit",
      timeBasis:
        observation.timeBasis,
    },
  };
}

function externalEventId(
  event: CalendarImageExtractedEvent,
): string {
  const title =
    normalizeIdentityText(
      event.title,
    ) || "event";

  const start =
    event.startTime
      ? event.startTime.replace(
          ":",
          "",
        )
      : "time-unknown";

  return [
    "calendar_image",
    event.localDate,
    start,
    title,
  ].join(":");
}

function currentDateInTimeZone(
  timeZone: string,
): string {
  const parts =
    partsInTimeZone(
      new Date(),
      timeZone,
    );

  return [
    String(parts.year).padStart(
      4,
      "0",
    ),
    String(parts.month).padStart(
      2,
      "0",
    ),
    String(parts.day).padStart(
      2,
      "0",
    ),
  ].join("-");
}

function canonicalizeEvent(
  observation:
    CalendarImageExtractedEvent,
  options: {
    pageUrl: string;
    imageUrl: string;
    contentType: string;
    timeZone: string;
    qualificationReason: string;
    currentDate: string;
    weekStart:
      | "Monday"
      | "Sunday"
      | null;
  },
): FirstPartyHarvestEvent | null {
  const resolved =
    resolveObservationDate(
      observation,
      options.currentDate,
      options.weekStart,
    );

  if (!resolved) {
    return null;
  }

  const resolvedObservation =
    resolved.observation;

  const title =
    resolvedObservation.title.trim();

  if (!title) {
    return null;
  }

  const date =
    parseLocalDate(
      resolvedObservation.localDate!,
    );

  const startTime =
    parseLocalTime(
      resolvedObservation.startTime,
    );

  /*
   * The canonical first-party contract requires startsAt.
   * Preserve date-only observations in the extraction result,
   * but never manufacture a publishable time here.
   */
  if (
    !date ||
    !startTime
  ) {
    return null;
  }

  const startsAt =
    zonedDateTimeToUtc(
      date.year,
      date.month,
      date.day,
      startTime.hour,
      startTime.minute,
      options.timeZone,
    );

  let endsAt:
    Date | null = null;

  const endTime =
    parseLocalTime(
      resolvedObservation.endTime,
    );

  if (endTime) {
    let endDate = date;

    /*
     * A displayed range such as 9PM-1AM crosses midnight.
     * Equal end/start times are also treated as next-day rather
     * than producing a zero-duration event.
     */
    if (
      endTime.hour <
        startTime.hour ||
      (
        endTime.hour ===
          startTime.hour &&
        endTime.minute <=
          startTime.minute
      )
    ) {
      endDate =
        addUtcDays(
          date,
          1,
        );
    }

    endsAt =
      zonedDateTimeToUtc(
        endDate.year,
        endDate.month,
        endDate.day,
        endTime.hour,
        endTime.minute,
        options.timeZone,
      );

    if (
      endsAt.getTime() <=
      startsAt.getTime()
    ) {
      endsAt = null;
    }
  }

  return {
    externalEventId:
      externalEventId(
        resolvedObservation,
      ),
    title,
    description: null,
    startsAt:
      startsAt.toISOString(),
    endsAt:
      endsAt?.toISOString() ??
      null,
    allDay:
      resolvedObservation.allDay,
    sourceUrl:
      options.pageUrl,
    flyerUrl:
      isCalendarPdfContentType(options.contentType) ? null : options.imageUrl,
    location: null,
    venueName: null,
    venueAddress: null,
    rawPayload: {
      adapter:
        "calendar_image",
      imageUrl:
        options.imageUrl,
      timeZone:
        options.timeZone,
      qualificationReason:
        options.qualificationReason,
      observation,
      resolvedObservation:
        resolvedObservation === observation
          ? undefined
          : resolvedObservation,
      eventEvidence:
        resolved.evidence,
    },
  };
}

export async function fetchCalendarImageEvents(
  pageUrl: string,
  options?: {
    timeZone?: string;
  },
): Promise<
  FirstPartyHarvestEvent[]
> {
  const timeZone =
    options?.timeZone ??
    "America/New_York";

  if (
    !validTimeZone(timeZone)
  ) {
    throw new Error(
      `Invalid calendar-image timezone: ${timeZone}`,
    );
  }

  const response =
    await fetchCalendarImageResource(
      pageUrl,
      "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8",
    );

  if (!response.ok) {
    throw new Error(
      `Calendar-image page returned HTTP ${response.status}.`,
    );
  }

  const finalPageUrl =
    response.url ||
    pageUrl;

  const documentAsset: CalendarImageAsset | null = isCalendarPdfContentType(
    response.headers.get("content-type"),
  ) ? {
    detectedUrl: pageUrl,
    resolvedUrl: finalPageUrl,
    contentType: "application/pdf",
    bytes: new Uint8Array(await response.arrayBuffer()),
    usedOriginalCandidate: false,
  } : null;

  const html = documentAsset ? "" : await response.text();

  const imageUrls =
    documentAsset ? [finalPageUrl] : discoverCalendarImageAssets(
      html,
      finalPageUrl,
    );

  if (
    imageUrls.length === 0
  ) {
    throw new Error(
      "No calendar-image assets were discovered on the source page.",
    );
  }

  const events:
    FirstPartyHarvestEvent[] =
      [];

  const seen =
    new Set<string>();

  let qualifiedCalendarFound =
    false;

  const currentDate =
    currentDateInTimeZone(
      timeZone,
    );

  for (
    const imageUrl of imageUrls
  ) {
    const asset =
      documentAsset ?? await acquireCalendarImageAsset(
        imageUrl,
      );

    const extraction = await reuseCalendarImageExtraction(
      asset,
      calendarImageExtractionContract(currentDate),
      async (signal) => {
        let extracted = await extractCalendarImage(asset, { currentDate, signal });
        /*
         * Keep the existing confirming attempt for a non-calendar result.
         * Cache the final raw result, including confirmed non-calendars and
         * valid empty calendars, before deterministic freshness/date checks.
         */
        if (!extracted.isEventCalendar) {
          extracted = await extractCalendarImage(asset, { currentDate, signal });
        }
        return extracted;
      },
    );
    if (!extraction.isEventCalendar) continue;

    /*
     * Vision qualification is intentionally backed by a deterministic
     * stale-calendar guard. A historical schedule must never become
     * current harvest inventory merely because the image model
     * classified its layout as an event calendar.
     *
     * Compare ISO local dates only after parseLocalDate has validated
     * them. Earlier dates within a current calendar are preserved when
     * at least one current/future date is present.
     */
    const extractedDates =
      extraction.events
        .map(
          (observation) =>
            observation.localDate,
        )
        .filter(
          (
            localDate,
          ): localDate is string =>
            localDate !== null &&
            parseLocalDate(
              localDate,
            ) !== null,
        );

    const whollyHistorical =
      extractedDates.length > 0 &&
      extractedDates.every(
        (localDate) =>
          localDate <
          currentDate,
      );

    if (whollyHistorical) {
      continue;
    }

    qualifiedCalendarFound =
      true;

    for (
      const observation
      of extraction.events
    ) {
      const event =
        canonicalizeEvent(
          observation,
          {
            pageUrl:
              finalPageUrl,
            imageUrl:
              asset.resolvedUrl,
            contentType: asset.contentType,
            timeZone,
            qualificationReason:
              extraction.qualificationReason,
            currentDate,
            weekStart:
              extraction.weekStart,
          },
        );

      if (!event) {
        continue;
      }

      /*
       * Prevent duplicate observations from multiple calendar
       * assets on the same source page from becoming duplicate
       * adapter output. Cross-source identity remains the job of
       * the existing TenderFans candidate/fingerprint pipeline.
       */
      const key = [
        event.externalEventId,
        event.startsAt,
      ].join("|");

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      events.push(event);
    }
  }

  if (!qualifiedCalendarFound) {
    throw new Error(
      "Calendar-image assets were discovered, but none qualified as a current public event calendar.",
    );
  }

  return events;
}

