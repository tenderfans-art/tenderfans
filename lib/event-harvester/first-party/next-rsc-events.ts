import { recoveryFetch } from "@/lib/event-harvester/recovery-fetch";
import type {
  FirstPartyHarvestEvent,
} from "./types";

import {
  cleanText, validIso, extractNextRscEventRecords,
  type RscEvent,
} from "./next-rsc-inventory";

function mapRscEvent(
  event: RscEvent,
  pageUrl: string
): FirstPartyHarvestEvent | null {
  const id = cleanText(event.id);
  const title = cleanText(event.title);
  const startsAt = validIso(event.startsAtIso);

  if (!id || !title || !startsAt) {
    return null;
  }

  const endsAt = validIso(event.endsAtIso);

  const location =
    [
      cleanText(event.venueName),
      cleanText(event.city),
      cleanText(event.state),
    ]
      .filter(
        (value): value is string => Boolean(value)
      )
      .join(", ") || null;

  return {
    externalEventId: id,
    title,
    description: cleanText(event.description),
    startsAt,
    endsAt,
    allDay: false,
    sourceUrl: pageUrl,
    flyerUrl: cleanText(event.flyerImage),
    location,
    rawPayload: event as Record<string, unknown>,
  };
}

export async function fetchNextRscEvents(
  sourceUrl: string
): Promise<FirstPartyHarvestEvent[]> {
  const response = await recoveryFetch(sourceUrl, {
    headers: {
      Accept: "text/html",
      "User-Agent": "TenderFans-Event-Harvester/1.0",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `Next RSC event source returned HTTP ${response.status}.`
    );
  }

  const html = await response.text();
  return extractNextRscEventRecords(html)
    /*
     * This RSC event schema exposes its own lifecycle state.
     * Harvest only the source's current upcoming inventory rather
     * than bootstrapping historical/past events embedded in Flight
     * data. Draft records remain excluded independently.
     */
    .filter(
      (event) =>
        event.isDraft !== true &&
        cleanText(event.status)?.toLowerCase() === "upcoming"
    )
    .map((event) => mapRscEvent(event, sourceUrl))
    .filter(
      (event): event is FirstPartyHarvestEvent =>
        event !== null
    )
    .sort(
      (a, b) =>
        new Date(a.startsAt).getTime() -
        new Date(b.startsAt).getTime()
    );
}
