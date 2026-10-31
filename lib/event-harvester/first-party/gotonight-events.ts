import { recoveryFetch } from "@/lib/event-harvester/recovery-fetch";
import type { FirstPartyHarvestEvent } from "./types";

const UA = "Mozilla/5.0 (compatible; TenderFans Event Harvester/1.0)";
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function decodeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCodePoint(parseInt(n, 10)))
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function cleanHtml(value: string): string {
  return decodeHtml(
    value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")
  ).trim();
}

export function isGoTonightProfileUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.hostname === "gotonight.com" ||
        url.hostname === "www.gotonight.com") &&
      /^\/profile\/?$/i.test(url.pathname) &&
      /^\d+$/.test(url.searchParams.get("id") ?? "")
    );
  } catch {
    return false;
  }
}

function profileId(sourceUrl: string): string {
  if (!isGoTonightProfileUrl(sourceUrl)) {
    throw new Error("Invalid GoTonight venue profile URL");
  }
  return new URL(sourceUrl).searchParams.get("id")!;
}

function timeParts(value: string): { hour: number; minute: number } {
  const match = value.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!match) throw new Error(`Unrecognized GoTonight time: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  if (hour < 1 || hour > 12 || minute > 59) {
    throw new Error(`Invalid GoTonight time: ${value}`);
  }
  return {
    hour: hour % 12 + (match[3].toUpperCase() === "PM" ? 12 : 0),
    minute,
  };
}

function zonedIso(
  year: number, month: number, day: number,
  hour: number, minute: number, timeZone: string,
): string {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wall;

  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(instant));

    const get = (type: string) =>
      Number(parts.find(p => p.type === type)?.value ?? "0");

    const observed = Date.UTC(
      get("year"), get("month") - 1, get("day"),
      get("hour"), get("minute"),
    );
    const correction = wall - observed;
    instant += correction;
    if (!correction) break;
  }

  return new Date(instant).toISOString();
}

function parseCard(
  html: string,
  id: string,
  sourceUrl: string,
  timeZone: string,
): FirstPartyHarvestEvent {
  const nameSection = html.match(
    /<div\b[^>]*class="[^"]*\bfw-bold\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  );
  const title = nameSection ? cleanHtml(nameSection[1]) : "";

  const dateSection = html.match(
    /<div\b[^>]*class="[^"]*\bgt-fs-sm\b[^"]*"[^>]*>\s*<div>([\s\S]*?)<\/div>/i
  );
  const dateText = dateSection ? cleanHtml(dateSection[1]) : "";

  const match = dateText.match(
    /(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\.?,?\s*([A-Za-z]{3})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\d{4})\s*@\s*(\d{1,2}(?::\d{2})?\s*[AP]M)\s*-\s*(\d{1,2}(?::\d{2})?\s*[AP]M)/i
  );

  if (!title || !match) {
    throw new Error("Unrecognized GoTonight event-card structure");
  }

  const month = MONTHS[match[1].toLowerCase()];
  const day = Number(match[2]);
  const year = Number(match[3]);

  if (!month || day < 1 || day > 31) {
    throw new Error("Invalid GoTonight event date");
  }

  const start = timeParts(match[4]);
  const end = timeParts(match[5]);

  const startsAt = zonedIso(
    year, month, day, start.hour, start.minute, timeZone
  );

  let endsAt = zonedIso(
    year, month, day, end.hour, end.minute, timeZone
  );

  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    endsAt = new Date(
      Date.parse(endsAt) + 86400000
    ).toISOString();
  }

  const identity = [
    id, year, month, day, start.hour, start.minute,
    title.toLowerCase().replace(/\s+/g, " ").trim(),
  ].join(":");

  return {
    externalEventId: `gotonight:${identity}`,
    title,
    description: null,
    startsAt,
    endsAt,
    allDay: false,
    sourceUrl,
    flyerUrl: null,
    location: null,
    rawPayload: {
      provider: "gotonight",
      profileId: id,
      originalDateText: dateText,
    },
  };
}

export async function fetchGoTonightEvents(
  sourceUrl: string,
  options: { timeZone?: string } = {},
): Promise<FirstPartyHarvestEvent[]> {
  const id = profileId(sourceUrl);
  const timeZone = options.timeZone ?? "America/New_York";

  // Validate the timezone before requesting provider data.
  new Intl.DateTimeFormat("en-US", { timeZone });

  const profile = await recoveryFetch(sourceUrl, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: AbortSignal.timeout(20000),
  });

  if (!profile.ok) {
    throw new Error(`GoTonight profile HTTP ${profile.status}`);
  }

  const profileHtml = await profile.text();

  if (
    !/id=["']profileId["']/i.test(profileHtml) ||
    !/id=["']eventViews["']/i.test(profileHtml) ||
    !/Venue Profile/i.test(profileHtml)
  ) {
    throw new Error("GoTonight venue identity/event surface not verified");
  }

  const results: FirstPartyHarvestEvent[] = [];
  const seen = new Set<string>();

  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());

  for (let page = 0; page < 20; page++) {
    const url = new URL("/Profile/ReadEventViews", sourceUrl);
    url.searchParams.set("date", today);
    url.searchParams.set("profileId", id);
    url.searchParams.set("page", String(page));

    const response = await recoveryFetch(url.toString(), {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/javascript, */*",
        "X-Requested-With": "XMLHttpRequest",
        Referer: sourceUrl,
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      throw new Error(`GoTonight event inventory HTTP ${response.status}`);
    }

    const payload: unknown = await response.json();

    if (
      !Array.isArray(payload) ||
      !payload.every(item => typeof item === "string")
    ) {
      throw new Error("Unexpected GoTonight event inventory response");
    }

    for (const html of payload) {
      const event = parseCard(html, id, sourceUrl, timeZone);
      if (!seen.has(event.externalEventId)) {
        seen.add(event.externalEventId);
        results.push(event);
      }
    }

    if (payload.length < 10) return results;
  }

  throw new Error("GoTonight pagination safety limit reached");
}
