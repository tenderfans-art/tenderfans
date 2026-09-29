import ical from "node-ical";

import type {
  FirstPartyHarvestEvent,
} from "./types";

function cleanText(
  value: unknown
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value.trim();

  return cleaned || null;
}

function isoDate(
  value: unknown
): string | null {
  if (!(value instanceof Date)) {
    return null;
  }

  if (Number.isNaN(value.getTime())) {
    return null;
  }

  return value.toISOString();
}

export function parseIcsEvents(
  rawIcs: string
): FirstPartyHarvestEvent[] {
  const parsed =
    ical.sync.parseICS(rawIcs);

  const events: FirstPartyHarvestEvent[] = [];

  for (const component of Object.values(parsed)) {
    if (
      !component ||
      component.type !== "VEVENT"
    ) {
      continue;
    }

    const uid = cleanText(component.uid);
    const title = cleanText(component.summary);
    const startsAt = isoDate(component.start);

    /*
     * UID is the provider lifecycle identity.
     * Title/start are required by the existing Harvester.
     */
    if (!uid || !title || !startsAt) {
      continue;
    }

    const endsAt = isoDate(component.end);

    const sourceUrl =
      cleanText(component.url);

    const description =
      cleanText(component.description);

    const location =
      cleanText(component.location);

    events.push({
      externalEventId: uid,
      title,
      description,
      startsAt,
      endsAt,
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
        recurrenceId:
          component.recurrenceid instanceof Date
            ? component.recurrenceid.toISOString()
            : null,
      },
    });
  }

  return events.sort(
    (a, b) =>
      Date.parse(a.startsAt) -
      Date.parse(b.startsAt)
  );
}
