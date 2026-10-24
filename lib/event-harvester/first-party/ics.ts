import ical from "node-ical";

import type { FirstPartyHarvestEvent } from "./types";

const RECURRENCE_HORIZON_DAYS = 90;

function cleanText(value: unknown): string | null {
  return typeof value === "string"
    ? value.trim() || null
    : null;
}

function isoDate(value: unknown): string | null {
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString()
    : null;
}

/*
 * The source UID identifies the series. The original scheduled
 * recurrence timestamp identifies an individual occurrence.
 *
 * Preserve the bare UID for the original instance to maintain
 * compatibility with previously harvested recurring masters.
 */
function occurrenceId(
  uid: string,
  seriesStart: string,
  recurrenceStart: string,
): string {
  return recurrenceStart === seriesStart
    ? uid
    : `${uid}::${recurrenceStart}`;
}

export function parseIcsEvents(
  rawIcs: string,
  options: {
    from?: Date;
    to?: Date;
  } = {},
): FirstPartyHarvestEvent[] {
  const parsed = ical.sync.parseICS(rawIcs);

  const from = options.from ?? new Date();
  const to = options.to ?? new Date(
    from.getTime() + RECURRENCE_HORIZON_DAYS * 86400000,
  );

  if (
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    to < from
  ) {
    throw new Error("Invalid ICS recurrence expansion window.");
  }

  const events: FirstPartyHarvestEvent[] = [];
  const seen = new Set<string>();

  for (const component of Object.values(parsed)) {
    if (!component || component.type !== "VEVENT") {
      continue;
    }

    const uid = cleanText(component.uid);
    const seriesStart = isoDate(component.start);

    if (!uid || !seriesStart) {
      continue;
    }

    const instances = component.rrule
      ? ical.expandRecurringEvent(component, {
          from,
          to,
          includeOverrides: true,
          excludeExdates: true,
          expandOngoing: true,
        })
      : [{
          start: component.start,
          end: component.end,
          summary: component.summary,
          isFullDay: component.start.dateOnly === true,
          isRecurring: false,
          isOverride: false,
          event: component,
        }];

    for (const instance of instances) {
      /*
       * node-ical includes STATUS:CANCELLED overrides in expanded
       * results. Never treat one as an active occurrence.
       *
       * Explicit cancellation of an already-published occurrence
       * requires separate lifecycle handling.
       */
      if (
        cleanText(instance.event.status)?.toUpperCase() ===
        "CANCELLED"
      ) {
        continue;
      }

      const startsAt = isoDate(instance.start);
      const endsAt = isoDate(instance.end);
      const title =
        cleanText(instance.summary) ??
        cleanText(component.summary);

      if (!startsAt || !title) {
        continue;
      }

      const recurrenceStart =
        instance.isOverride &&
        instance.event.recurrenceid instanceof Date
          ? instance.event.recurrenceid.toISOString()
          : startsAt;

      const externalEventId = component.rrule
        ? occurrenceId(uid, seriesStart, recurrenceStart)
        : uid;

      if (seen.has(externalEventId)) {
        continue;
      }

      seen.add(externalEventId);

      /*
       * RECURRENCE-ID overrides may omit unchanged metadata.
       * Inherit omitted fields from the series master.
       */
      const sourceUrl =
        cleanText(instance.event.url) ??
        cleanText(component.url);

      const description =
        cleanText(instance.event.description) ??
        cleanText(component.description);

      const location =
        cleanText(instance.event.location) ??
        cleanText(component.location);

      events.push({
        externalEventId,
        title,
        description,
        startsAt,
        endsAt,
        allDay: instance.isFullDay,
        sourceUrl,
        flyerUrl: null,
        location,
        rawPayload: {
          uid,
          summary: title,
          description,
          location,
          sourceUrl,
          startsAt,
          endsAt,
          isAllDay: instance.isFullDay,
          isRecurring: Boolean(component.rrule),
          isOverride: instance.isOverride,
          recurrenceId: component.rrule
            ? recurrenceStart
            : null,
          seriesStart,
        },
      });
    }
  }

  return events.sort(
    (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt),
  );
}
