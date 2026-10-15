import { createHash } from "node:crypto";
import { recoveryFetch } from "@/lib/event-harvester/recovery-fetch";
import type { FirstPartyHarvestEvent } from "./types";

function attribute(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(
    new RegExp(`\\b${escaped}\\s*=\\s*(["'])(.*?)\\1`, "i"),
  );
  return match?.[2] ?? null;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (_, hex, dec) =>
      String.fromCodePoint(parseInt(hex ?? dec, hex ? 16 : 10)))
    .replace(/&(?:amp|quot|apos|lt|gt|nbsp);/gi, (entity) => ({
      "&amp;": "&", "&quot;": '"', "&apos;": "'",
      "&lt;": "<", "&gt;": " ", "&nbsp;": " ",
    }[entity.toLowerCase()] ?? entity))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classMatches(tag: string, className: string): boolean {
  return (attribute(tag, "class") ?? "")
    .split(/\s+/)
    .includes(className);
}

function eventTitle(html: string): string {
  const match = html.match(
    /<span\b[^>]*class=["'][^"']*\bsimcal-event-title\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
  );
  return match ? decodeHtml(match[1]) : "";
}

function eventLink(html: string, pageUrl: string): string | null {
  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = attribute(match[0], "href");
    if (!href) continue;

    try {
      const url = new URL(decodeHtml(href), pageUrl);
      if (
        url.hostname === "www.google.com" &&
        url.pathname === "/calendar/event" &&
        url.searchParams.has("eid")
      ) {
        return url.toString();
      }
    } catch {
      // Ignore malformed links.
    }
  }
  return null;
}

export function parseSimcalEvents(
  html: string,
  pageUrl: string,
): FirstPartyHarvestEvent[] {
  const calendarTag = html.match(
    /<div\b[^>]*class=["'][^"']*\bsimcal-calendar\b[^"']*["'][^>]*>/i,
  )?.[0];

  if (!calendarTag) {
    throw new Error("Simple Calendar markup was not found.");
  }

  const calendarId = attribute(calendarTag, "data-calendar-id");
  const timeZone = attribute(calendarTag, "data-timezone");

  if (!calendarId || !timeZone) {
    throw new Error("Simple Calendar identity or timezone is missing.");
  }

  const events = new Map<string, FirstPartyHarvestEvent>();

  const blocks = html.matchAll(
    /<li\b[^>]*class=["'][^"']*\bsimcal-event\b[^"']*["'][^>]*>[\s\S]*?<\/li>/gi,
  );

  for (const block of blocks) {
    const markup = block[0];
    const title = eventTitle(markup);
    if (!title) continue;

    const startTag = markup.match(
      /<span\b[^>]*class=["'][^"']*\bsimcal-event-start\b[^"']*["'][^>]*>/i,
    )?.[0];

    const start = startTag
      ? attribute(startTag, "content")
      : null;

    if (!start || !Number.isFinite(Date.parse(start))) continue;

    const endTag = markup.match(
      /<meta\b[^>]*itemprop=["']endDate["'][^>]*>/i,
    )?.[0];

    const end = endTag ? attribute(endTag, "content") : null;
    const validEnd = end && Number.isFinite(Date.parse(end))
      ? end
      : null;

    const allDay =
      /(?:T00:00:00|T00:00:59)/.test(start) &&
      (!validEnd || /T23:59:(?:00|01|59)/.test(validEnd));

    const googleUrl = eventLink(markup, pageUrl);

    const dateKey = start.slice(0, 10);
    const identity = [
      calendarId,
      googleUrl
        ? new URL(googleUrl).searchParams.get("eid")
        : title,
      dateKey,
      allDay ? "all-day" : start,
    ].join("|");

    const externalEventId =
      "simcal:" +
      createHash("sha256").update(identity).digest("hex").slice(0, 32);

    const startsAt = allDay
      ? `${dateKey}T00:00:00.000Z`
      : new Date(start).toISOString();

    const endsAt = allDay
      ? `${dateKey}T23:59:59.999Z`
      : validEnd
        ? new Date(validEnd).toISOString()
        : null;

    const event: FirstPartyHarvestEvent = {
      externalEventId,
      title,
      description: null,
      startsAt,
      endsAt,
      allDay,
      sourceUrl: googleUrl ?? pageUrl,
      flyerUrl: null,
      location: null,
      rawPayload: {
        platform: "simcal_events",
        calendarId,
        timeZone,
        originalStart: start,
        originalEnd: validEnd,
        googleEventUrl: googleUrl,
        sourcePageUrl: pageUrl,
      },
    };

    events.set(externalEventId, event);
  }

  return [...events.values()]
    .filter((event) => {
      if (event.allDay) {
        const timeZone = event.rawPayload.timeZone;
        if (typeof timeZone !== "string") return false;

        const today = new Intl.DateTimeFormat("en-CA", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).formatToParts(new Date());

        const part = (type: string) =>
          today.find((item) => item.type === type)?.value ?? "";

        const localDate = [
          part("year"),
          part("month"),
          part("day"),
        ].join("-");

        return event.startsAt.slice(0, 10) >= localDate;
      }

      const boundary = Date.parse(event.endsAt ?? event.startsAt);
      return Number.isFinite(boundary) && boundary >= Date.now();
    })
    .sort(
      (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt),
    );
}

export async function fetchSimcalEvents(
  sourceUrl: string,
): Promise<FirstPartyHarvestEvent[]> {
  const response = await recoveryFetch(sourceUrl, {
    headers: {
      Accept: "text/html",
      "User-Agent": "TenderFans-Event-Harvester/1.0",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Simple Calendar returned HTTP ${response.status}.`);
  }

  const events = parseSimcalEvents(
    await response.text(),
    response.url || sourceUrl,
  );

  if (!events.length) {
    throw new Error("No upcoming Simple Calendar events were extracted.");
  }

  return events;
}
