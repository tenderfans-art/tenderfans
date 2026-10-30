import { fetchHtml } from "./source-detector";
import { fetchBrowserEvidence } from "./browser-transport";
import { getTransportRecoveryProxy } from "@/lib/event-harvester/transport-recovery-context";

export type HtmlNormalizedEvent = {
  externalEventId: string;
  sourceUrl: string | null;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  flyerUrl: string | null;
  location: string | null;
  venueName: string | null;
  venueAddress: string | null;
  rawPayload: Record<string, unknown>;
};

function decode(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&rsquo;|&#8217;/gi, "’")
    .replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/\s+/g, " ")
    .trim();
}

function text(value: string): string {
  const withBreaks = value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return withBreaks
    .split("\n")
    .map(line => decode(line))
    .filter(Boolean)
    .join("\n");
}


function eventYear(
  html: string,
  month: number,
  day: number,
  weekday: string
): number | null {
  const years = [
    ...html.matchAll(/\b20\d{2}\b/g),
  ].map(match => Number(match[0]));

  const candidates = [...new Set(years)]
    .filter(year => year >= 2020 && year <= 2040)
    .filter(year => {
      const date = new Date(Date.UTC(year, month - 1, day));
      return date.getUTCDay() ===
        ["Sunday", "Monday", "Tuesday", "Wednesday",
         "Thursday", "Friday", "Saturday"]
          .findIndex(name => name.toLowerCase() === weekday.toLowerCase());
    });

  return candidates.length === 1 ? candidates[0] : null;
}

function easternTimestamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): string {
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  }).formatToParts(date)
    .find(part => part.type === "timeZoneName")
    ?.value ?? "GMT-4";

  const hours = Number(offset.match(/GMT([+-]\d+)/)?.[1] ?? -4);

  return new Date(
    Date.UTC(year, month - 1, day, hour - hours, minute)
  ).toISOString();
}

function parseTime(
  value: string,
  meridiem: string
): { hour: number; minute: number } | null {
  const match = value.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);

  if (hour < 1 || hour > 12 || minute > 59) return null;

  return {
    hour: (hour % 12) + (meridiem.toUpperCase() === "PM" ? 12 : 0),
    minute,
  };
}

function resolveStartTime(
  start: string,
  end: string,
  endMeridiem: string
): { hour: number; minute: number } | null {
  const endTime = parseTime(end, endMeridiem);
  if (!endTime) return null;

  const options = ["AM", "PM"]
    .map(period => parseTime(start, period))
    .filter((value): value is {hour:number;minute:number} => value !== null);

  const endMinutes = endTime.hour * 60 + endTime.minute;

  const valid = options
    .filter(value => {
      const startMinutes = value.hour * 60 + value.minute;
      const duration = endMinutes - startMinutes;
      return duration > 0 && duration <= 8 * 60;
    })
    .sort((a, b) =>
      (endMinutes - (a.hour * 60 + a.minute)) -
      (endMinutes - (b.hour * 60 + b.minute))
    );

  return valid[0] ?? null;
}

export type HtmlExtractionDiagnostics = {
  recognizedSchedule: boolean;
  expectedPerformances: number;
  extractedPerformances: number;
  errors: string[];
};


function extractMultidayHtmlAnnouncement(
  html: string,
  pageUrl: string,
): HtmlNormalizedEvent | null {
  const main =
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
    "";

  if (!main) return null;

  const content = text(main);
  const lines = content.split("\n").map(line => line.trim()).filter(Boolean);

  const titleHtml =
    main.match(/<span\b[^>]*class=["'][^"']*\bentry-title\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ??
    main.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ??
    "";

  const title = text(titleHtml);

  if (!title || title.length > 160) return null;

  const datePattern =
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\s*,\s*(\d{1,2})\s*(?:&|and)\s*(\d{1,2})(?:\s*,?\s*(20\d{2}))?\b/i;

  const dateLines = lines.filter(line => datePattern.test(line));

  if (!dateLines.length) return null;

  const dateMatch = dateLines[0].match(datePattern);
  if (!dateMatch) return null;

  const months = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ];

  const month = months.indexOf(dateMatch[1].toLowerCase()) + 1;
  const days = [
    Number(dateMatch[2]),
    Number(dateMatch[3]),
    Number(dateMatch[4]),
  ];

  if (
    !month ||
    days.some(day => day < 1 || day > 31) ||
    days[1] !== days[0] + 1 ||
    days[2] !== days[1] + 1
  ) {
    return null;
  }

  const explicitYear = dateMatch[5]
    ? Number(dateMatch[5])
    : null;

  const updated =
    html.match(/"dateModified"\s*:\s*"(20\d{2})-(\d{2})-/i) ??
    html.match(/\bupdated[^>]*>\s*(20\d{2})-(\d{2})-/i);

  /*
   * A future-year inference is permitted only when the page's
   * modification month is later than the announced event month.
   * It is never represented as a confirmed published year.
   */
  const inferredYear =
    !explicitYear && updated && Number(updated[2]) > month
      ? Number(updated[1]) + 1
      : null;

  const year = explicitYear ?? inferredYear;
  if (!year) return null;

  const start = new Date(Date.UTC(year, month - 1, days[0]));
  const last = new Date(Date.UTC(year, month - 1, days[2]));

  if (
    start.getUTCMonth() !== month - 1 ||
    last.getUTCMonth() !== month - 1
  ) {
    return null;
  }

  const end = new Date(Date.UTC(year, month - 1, days[2] + 1));

  const dateLine = dateLines[0];

  const locationMatch =
    dateLine.match(/(?:@|\bat\b)\s+(.+)$/i) ??
    lines.find(line => /^at\s+\S/i.test(line))
      ?.match(/^at\s+(.+)$/i);

  const location =
    locationMatch?.[1]?.trim().replace(/[!,;]+$/, "").trim() ?? null;

  const description =
    lines.find(line =>
      line !== title &&
      /(?:annual|charity|tournament|festival|benefit)/i.test(line) &&
      line.length < 350
    ) ?? null;

  const publishedDates = dateMatch[0];

  const sourcePath = new URL(pageUrl).pathname;
  const sourceSlug = sourcePath
    .split("/")
    .filter(Boolean)
    .pop() ?? "announcement";

  /*
   * Use the published source URL path for event identity,
   * avoiding title punctuation and presentation changes.
   */
  const identitySlug = sourceSlug;

  return {
    externalEventId:
      `html:${pageUrl}:${identitySlug}:${start.toISOString().slice(0, 10)}`,
    sourceUrl: pageUrl,
    title,
    description,
    startsAt: start.toISOString().slice(0, 10),
    endsAt: end.toISOString().slice(0, 10),
    allDay: true,
    flyerUrl: null,
    location,
    venueName: location,
    venueAddress: null,
    rawPayload: {
      extraction: "html_multiday_announcement",
      publishedDates,
      ...(explicitYear
        ? { publishedYear: explicitYear }
        : {
            inferredYear,
            yearInference:
              "Event month precedes the page's modification month",
            yearRequiresConfirmation: true,
          }),
      timeNotPublished: true,
      endDateExclusive: true,
    },
  };
}

function extractDiviHtmlEvents(
  html: string,
  pageUrl: string,
): HtmlNormalizedEvent[] {
  if (!/\bet_pb_text_inner\b/i.test(html)) return [];

  const main =
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
    "";

  if (!main) return [];

  const modules = [
    ...main.matchAll(
      /<div\b[^>]*class=["'][^"']*\bet_pb_text_inner\b[^"']*["'][^>]*>([\s\S]*?)(?=<\/div>\s*<\/div>|<div\b[^>]*class=["'][^"']*\bet_pb_button_module_wrapper\b)/gi,
    ),
  ];

  const months = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ];

  const publishedYear =
    html.match(/"dateModified"\s*:\s*"(\d{4})-/i)?.[1] ??
    html.match(/"datePublished"\s*:\s*"(\d{4})-/i)?.[1] ??
    null;

  const events: HtmlNormalizedEvent[] = [];

  for (const module of modules) {
    const headings = [
      ...module[1].matchAll(
        /<h([2-5])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      ),
    ];

    const title = headings
      .map(heading => text(heading[2]).trim())
      .find(Boolean);

    if (!title) continue;

    const content = text(module[1]);

    if (!/\b(?:when|upcoming dates)\s*:/i.test(content)) {
      continue;
    }

    const timeMatch = content.match(
      /\bTime:\s*(\d{1,2}(?::\d{2})?)\s*[–—-]\s*(\d{1,2}(?::\d{2})?)\s*(a\.?m\.?|p\.?m\.?)/i,
    );

    const endMeridiem = timeMatch?.[3]
      ?.replace(/\./g, "")
      .toUpperCase() ?? null;

    const startTime =
      timeMatch && endMeridiem
        ? resolveStartTime(timeMatch[1], timeMatch[2], endMeridiem)
        : null;

    const endTime =
      timeMatch && endMeridiem
        ? parseTime(timeMatch[2], endMeridiem)
        : null;

    const dateMatches = [
      ...content.matchAll(
        /\b(?:(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+)?(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/gi,
      ),
    ];

    const seen = new Set<string>();

    for (const match of dateMatches) {
      const monthIndex = months.findIndex(month =>
        month.startsWith(match[2].toLowerCase().slice(0, 3))
      );

      if (monthIndex < 0) continue;

      const month = monthIndex + 1;
      const day = Number(match[3]);

      const metadataYear =
        publishedYear ? Number(publishedYear) : null;

      const year =
        match[4] ? Number(match[4]) : metadataYear;

      if (!year) continue;

      if (match[1]) {
        const weekdayIndex = [
          "Sunday", "Monday", "Tuesday", "Wednesday",
          "Thursday", "Friday", "Saturday",
        ].findIndex(
          name => name.toLowerCase() === match[1].toLowerCase()
        );

        const actualWeekday = new Date(
          Date.UTC(year, month - 1, day)
        ).getUTCDay();

        if (weekdayIndex < 0 || actualWeekday !== weekdayIndex) {
          continue;
        }
      }

      const validDate = new Date(Date.UTC(year, month - 1, day));
      if (
        validDate.getUTCFullYear() !== year ||
        validDate.getUTCMonth() !== month - 1 ||
        validDate.getUTCDate() !== day
      ) continue;

      const localDate =
        `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

      if (seen.has(localDate)) continue;
      seen.add(localDate);

      const timed = Boolean(startTime && endTime);

      const startsAt = timed
        ? easternTimestamp(
            year, month, day,
            startTime!.hour, startTime!.minute,
          )
        : localDate;

      const endsAt = timed
        ? easternTimestamp(
            year, month, day,
            endTime!.hour, endTime!.minute,
          )
        : null;

      events.push({
        externalEventId: `html:${pageUrl}:${title}:${localDate}`,
        sourceUrl: pageUrl,
        title,
        description: content.slice(0, 1500),
        startsAt,
        endsAt,
        allDay: !timed,
        flyerUrl: null,
        location: null,
        venueName: null,
        venueAddress: null,
        rawPayload: {
          extraction: "html_divi_text_module",
          publishedDate: match[0],
          yearSource: match[4]
            ? "explicit"
            : match[1]
              ? "page_metadata_weekday_verified"
              : "page_metadata",
          timeNotPublished: !timed,
        },
      });
    }
  }

  return events;
}


/*
 * Generic Duda photo-gallery event cards.
 *
 * The published card contains a caption-title and caption-text
 * with a weekday, month/day, and local start time.
 *
 * No Spot identity, domain, event title, or date is hardcoded.
 * Missing/ambiguous years are never silently treated as confirmed.
 */
function extractDudaGalleryEvents(
  html: string,
  pageUrl: string,
): HtmlNormalizedEvent[] {
  if (
    !/\bdmAPI\b/.test(html) ||
    !/\bphotoGalleryThumbs\b/.test(html) ||
    !/\bcaption-title\b/.test(html) ||
    !/\bcaption-text\b/.test(html)
  ) return [];

  const weekdays = [
    "sun", "mon", "tue", "wed", "thu", "fri", "sat",
  ];
  const months = [
    "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec",
  ];

  const datePattern =
    /\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat)(?:day)?,?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;

  const now = new Date();
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const events: HtmlNormalizedEvent[] = [];
  const seen = new Set<string>();

  const cards = html.split(
    /<div\b[^>]*class=["'][^"']*\bphotogallery-column\b[^"']*["'][^>]*>/i,
  ).slice(1);

  for (const card of cards) {
    if (!/\bphotoGalleryThumbs\b/.test(card)) continue;

    const titleMatch = card.match(
      /<h[2-5]\b[^>]*class=["'][^"']*\bcaption-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h[2-5]>/i,
    );
    const dateMatch = card.match(
      /<div\b[^>]*class=["'][^"']*\bcaption-text\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    );

    if (!titleMatch || !dateMatch) continue;

    const title = text(titleMatch[1]).trim();
    const publishedDate = text(dateMatch[1]).trim();
    const match = publishedDate.match(datePattern);

    if (!title || title.length > 160 || !match) continue;

    const weekday = weekdays.indexOf(match[1].slice(0, 3).toLowerCase());
    const month = months.indexOf(match[2].slice(0, 3).toLowerCase()) + 1;
    const day = Number(match[3]);
    const clock = parseTime(
      `${match[5]}:${match[6] ?? "00"}`,
      match[7].toUpperCase(),
    );

    if (weekday < 0 || month < 1 || !clock) continue;

    /*
     * For yearless gallery captions, require the published weekday
     * to agree with exactly one plausible upcoming calendar date.
     * Do not guess when multiple dates qualify.
     */
    const years = match[4]
      ? [Number(match[4])]
      : [now.getUTCFullYear(), now.getUTCFullYear() + 1];

    const candidates = years.filter(year => {
      const date = new Date(Date.UTC(year, month - 1, day));
      if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day ||
        date.getUTCDay() !== weekday
      ) return false;

      if (match[4]) return true;

      const delta = date.getTime() - today;
      return delta >= -86400000 && delta <= 370 * 86400000;
    });

    if (candidates.length !== 1) continue;

    const year = candidates[0];
    const startsAt = easternTimestamp(
      year, month, day, clock.hour, clock.minute,
    );
    const key = `${title.toLowerCase()}:${startsAt}`;

    if (seen.has(key)) continue;
    seen.add(key);

    events.push({
      externalEventId: `html:${pageUrl}:${key}`,
      sourceUrl: pageUrl,
      title,
      description: null,
      startsAt,
      endsAt: null,
      allDay: false,
      flyerUrl: null,
      location: null,
      venueName: null,
      venueAddress: null,
      rawPayload: {
        extraction: "html_duda_gallery",
        publishedDate,
        publishedYear: match[4] ? year : null,
        yearInferred: !match[4],
        yearInference: match[4]
          ? null
          : "Unique upcoming date matching published weekday",
        endTimeNotPublished: true,
      },
    });
  }

  return events;
}


/*
 * Events Calendar for Google (WordPress plugin).
 *
 * Parse only events published in first-party HTML.
 * Google event links are metadata, not validated calendar feeds.
 */
function extractGoogleCalendarPluginEvents(
  html: string,
  pageUrl: string,
): HtmlNormalizedEvent[] {
  if (
    !html.includes("tgs_event") ||
    !html.includes("tgse_title") ||
    !html.includes("tgse_date_time")
  ) return [];

  const events: HtmlNormalizedEvent[] = [];
  const seen = new Set<string>();

  /*
   * Identify card boundaries once.
   * Never run an open-ended search across multiple event cards.
   */
  const cardStartPattern =
    /<div\b[^>]*class=["'][^"']*\btgs_event\b[^"']*["'][^>]*>/gi;

  const starts = [...html.matchAll(cardStartPattern)];

  if (!starts.length) return [];

  function classContent(
    card: string,
    className: string,
    tag: "div" | "span",
  ): string | null {
    const openingTag = new RegExp(
      `<${tag}\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>`,
      "i",
    );

    const match = openingTag.exec(card);
    if (!match) return null;

    const contentStart = match.index + match[0].length;
    const closing = card.indexOf(`</${tag}>`, contentStart);

    if (closing < 0) return null;

    return card.slice(contentStart, closing);
  }

  for (let i = 0; i < starts.length; i++) {
    const cardStart = starts[i].index! + starts[i][0].length;
    const cardEnd = i + 1 < starts.length
      ? starts[i + 1].index!
      : html.length;

    const card = html.slice(cardStart, cardEnd);

    const titleHtml = classContent(card, "tgse_title", "div");
    const dateHtml = classContent(card, "tgse_date_time", "div");
    const timeHtml = classContent(card, "tgse_time", "div");
    const zoneHtml = classContent(card, "tgse_timezone", "span");

    if (
      titleHtml === null ||
      dateHtml === null ||
      timeHtml === null ||
      zoneHtml === null
    ) continue;

    const title = text(titleHtml).trim();
    const publishedDate = text(
      classContent(dateHtml, "tgse_timerange", "span") ?? "",
    ).trim();
    const publishedTime = text(
      classContent(timeHtml, "tgse_timerange", "span") ?? "",
    ).trim();
    const timezone = text(zoneHtml).trim();

    if (!title || title.length > 160) continue;
    if (timezone !== "America/New_York") continue;

    const date = publishedDate.match(
      /^(20\d{2})-(\d{2})-(\d{2})$/,
    );

    const times = publishedTime.match(
      /^(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})$/,
    );

    if (!date || !times) continue;

    const year = Number(date[1]);
    const month = Number(date[2]);
    const day = Number(date[3]);

    const startHour = Number(times[1]);
    const startMinute = Number(times[2]);
    const endHour = Number(times[3]);
    const endMinute = Number(times[4]);

    const validDate = new Date(
      Date.UTC(year, month - 1, day),
    );

    if (
      year < 2020 || year > 2040 ||
      validDate.getUTCFullYear() !== year ||
      validDate.getUTCMonth() !== month - 1 ||
      validDate.getUTCDate() !== day ||
      startHour > 23 || endHour > 23 ||
      startMinute > 59 || endMinute > 59
    ) continue;

    const startsAt = easternTimestamp(
      year, month, day, startHour, startMinute,
    );

    const overnight =
      endHour * 60 + endMinute <
      startHour * 60 + startMinute;

    const endDate = new Date(
      Date.UTC(year, month - 1, day + (overnight ? 1 : 0)),
    );

    const endsAt = easternTimestamp(
      endDate.getUTCFullYear(),
      endDate.getUTCMonth() + 1,
      endDate.getUTCDate(),
      endHour,
      endMinute,
    );

    if (Date.parse(endsAt) <= Date.parse(startsAt)) continue;

    const eventLinkMatch = card.match(
      /<a\b[^>]*class=["'][^"']*\btgse_readmore_link\b[^"']*["'][^>]*href=["']([^"']+)["']/i,
    );

    let googleEventId: string | null = null;
    let googleCalendarId: string | null = null;
    let publishedEventUrl: string | null = null;

    if (eventLinkMatch) {
      try {
        const link = new URL(
          decode(eventLinkMatch[1]),
          pageUrl,
        );

        if (
          link.protocol === "https:" &&
          link.hostname === "www.google.com" &&
          link.pathname === "/calendar/event"
        ) {
          publishedEventUrl = link.toString();

          const eid = link.searchParams.get("eid");

          if (eid) {
            const decoded = Buffer.from(
              eid.replace(/-/g, "+").replace(/_/g, "/"),
              "base64",
            ).toString("utf8");

            const parts = decoded.split(" ", 2);

            if (parts.length === 2 && parts[0] && parts[1]) {
              googleEventId = parts[0];
              googleCalendarId = parts[1];
            }
          }
        }
      } catch {
        // Optional Google identity cannot invalidate event data.
      }
    }

    const key = googleEventId
      ? `${googleCalendarId}:${googleEventId}`
      : `${title.toLowerCase()}:${startsAt}`;

    if (seen.has(key)) continue;
    seen.add(key);

    const descriptionHtml =
      classContent(card, "tgse_description", "div");

    const description = descriptionHtml
      ? text(descriptionHtml).trim()
      : "";

    events.push({
      externalEventId: `html:${pageUrl}:${key}`,
      sourceUrl: pageUrl,
      title,
      description: description || null,
      startsAt,
      endsAt,
      allDay: false,
      flyerUrl: null,
      location: null,
      venueName: null,
      venueAddress: null,
      rawPayload: {
        extraction: "html_google_calendar_plugin",
        publishedDate,
        publishedTime,
        timezone,
        googleEventId,
        googleCalendarId,
        publishedEventUrl,
      },
    });
  }

  return events;
}



/*
 * Popmenu calendar cards, after client-side rendering.
 * Only the displayed occurrence is harvested. Recurrence rules
 * remain descriptive metadata, never synthesized occurrences.
 */

type PopmenuExtraction = {
  events: HtmlNormalizedEvent[];
  cardCount: number;
  untimedCount: number;
  placeholderCount: number;
  invalidCount: number;
};

function extractPopmenuCalendar(
  html: string,
  pageUrl: string,
): PopmenuExtraction {
  const result: PopmenuExtraction = {
    events: [],
    cardCount: 0,
    untimedCount: 0,
    placeholderCount: 0,
    invalidCount: 0,
  };

  if (
    !html.includes("pm-calendar-event-card") ||
    !html.includes("calendar-event-name")
  ) return result;

  const months = [
    "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec",
  ];

  const weekdays = [
    "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat",
  ];

  const cards = html.split(
    /<div\b[^>]*class=["'][^"']*\bpm-calendar-event-card-wrapper\b[^"']*["'][^>]*>/i,
  ).slice(1);

  result.cardCount = cards.length;

  const seen = new Set<string>();
  const now = new Date();

  function parseClock(
    hourText: string,
    minuteText: string | undefined,
    period: string,
  ): { hour: number; minute: number } | null {
    const hour12 = Number(hourText);
    const minute = Number(minuteText ?? 0);

    if (
      hour12 < 1 || hour12 > 12 ||
      minute < 0 || minute > 59
    ) return null;

    return {
      hour: hour12 % 12 +
        (period.toLowerCase() === "pm" ? 12 : 0),
      minute,
    };
  }

  function dateFor(
    year: number,
    month: number,
    day: number,
  ): Date | null {
    const date = new Date(Date.UTC(year, month - 1, day));

    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ) ? date : null;
  }

  for (const card of cards) {
    const titleMatch = card.match(
      /<h2\b[^>]*class=["'][^"']*\bcalendar-event-name\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i,
    );

    const monthMatch = card.match(
      /<span\b[^>]*data-testid=["']upcoming-month["'][^>]*>([\s\S]*?)<\/span>/i,
    );

    const dayMatch = card.match(
      /<span\b[^>]*data-testid=["']upcoming-day["'][^>]*>([\s\S]*?)<\/span>/i,
    );

    const linkMatch = card.match(
      /<a\b[^>]*href=["']([^"']*\/events\/[^"']+)["']/i,
    );

    if (!titleMatch || !monthMatch || !dayMatch || !linkMatch) {
      result.invalidCount++;
      continue;
    }

    const title = text(titleMatch[1]);
    const month = months.indexOf(
      text(monthMatch[1]).slice(0, 3).toLowerCase(),
    ) + 1;
    const day = Number(text(dayMatch[1]));

    if (
      !title || title.length > 160 ||
      !month || day < 1 || day > 31
    ) {
      result.invalidCount++;
      continue;
    }

    if (
      /^(?:hold|tba|tbd|to be announced|coming soon)(?:\b|$)/i.test(title) ||
      /\b(?:musician|performer|artist|entertainment)\s+tba\b/i.test(title)
    ) {
      result.placeholderCount++;
      continue;
    }

    let eventUrl: URL;

    try {
      eventUrl = new URL(decode(linkMatch[1]), pageUrl);

      if (
        !["http:", "https:"].includes(eventUrl.protocol) ||
        eventUrl.origin !== new URL(pageUrl).origin
      ) {
        result.invalidCount++;
        continue;
      }
    } catch {
      result.invalidCount++;
      continue;
    }

    const dateTime = card.match(
      /<p\b[^>]*data-testid=["']event-date-time["'][^>]*>([\s\S]*?)<\/p>/i,
    );

    const publishedSchedule = dateTime
      ? text(dateTime[1])
      : "";

    const recurringMatch = card.match(
      /<p\b[^>]*>\s*(Weekly[\s\S]*?)<\/p>/i,
    );

    const recurringSchedule = recurringMatch
      ? text(recurringMatch[1])
      : null;

    let year: number | null = null;

    const today = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );

    for (const candidate of [
      now.getUTCFullYear(),
      now.getUTCFullYear() + 1,
    ]) {
      const date = dateFor(candidate, month, day);
      if (!date) continue;

      const distance =
        (date.getTime() - today) / 86400000;

      if (distance >= -1 && distance <= 370) {
        year = candidate;
        break;
      }
    }

    if (year === null) {
      result.invalidCount++;
      continue;
    }

    const occurrence = dateFor(year, month, day)!;

    // Weekly day names must agree with the displayed occurrence.
    if (recurringSchedule) {
      const dayExpression = recurringSchedule.match(
        /^Weekly\s+((?:(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)(?:\/)?)+)\b/i,
      );

      if (dayExpression) {
        const allowed = dayExpression[1]
          .split("/")
          .map(value => value.slice(0, 3).toLowerCase());

        if (
          !allowed.includes(
            weekdays[occurrence.getUTCDay()].toLowerCase(),
          )
        ) {
          result.invalidCount++;
          continue;
        }
      }
    }

    const publishedStart = publishedSchedule.match(
      /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,\s+[A-Za-z]+\s+\d{1,2},\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i,
    );

    const recurringTimes = recurringSchedule?.match(
      /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm))?/i,
    );

    const startMatch = publishedStart ?? recurringTimes;

    if (!startMatch) {
      result.untimedCount++;
      continue;
    }

    const startClock = parseClock(
      startMatch[1],
      startMatch[2],
      startMatch[3],
    );

    if (!startClock) {
      result.invalidCount++;
      continue;
    }

    const startsAt = easternTimestamp(
      year, month, day,
      startClock.hour, startClock.minute,
    );

    let endsAt: string | null = null;

    /*
     * For recurring events, the published date range describes
     * the series, not a single performance's end date.
     */
    if (recurringTimes?.[4]) {
      const endClock = parseClock(
        recurringTimes[4],
        recurringTimes[5],
        recurringTimes[6],
      );

      if (endClock) {
        const startMinutes =
          startClock.hour * 60 + startClock.minute;

        const endMinutes =
          endClock.hour * 60 + endClock.minute;

        const endDate = new Date(Date.UTC(
          year, month - 1,
          day + (endMinutes <= startMinutes ? 1 : 0),
        ));

        endsAt = easternTimestamp(
          endDate.getUTCFullYear(),
          endDate.getUTCMonth() + 1,
          endDate.getUTCDate(),
          endClock.hour,
          endClock.minute,
        );
      }
    } else if (!recurringSchedule) {
      /*
       * A one-time event may publish a full start/end date.
       * Its structured time takes priority over the title.
       */
      const endMatch = publishedSchedule.match(
        /[-–—]\s*(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,\s+)?([A-Za-z]+)\s+(\d{1,2}),\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i,
      );

      if (endMatch) {
        const endMonth = months.indexOf(
          endMatch[1].slice(0, 3).toLowerCase(),
        ) + 1;

        const endDay = Number(endMatch[2]);
        const endClock = parseClock(
          endMatch[3], endMatch[4], endMatch[5],
        );

        const endYear =
          endMonth < month ? year + 1 : year;

        if (
          endClock &&
          dateFor(endYear, endMonth, endDay)
        ) {
          endsAt = easternTimestamp(
            endYear, endMonth, endDay,
            endClock.hour, endClock.minute,
          );
        }
      }
    }

    if (endsAt) {
      const duration =
        Date.parse(endsAt) - Date.parse(startsAt);

      if (duration <= 0 || duration > 86400000) {
        endsAt = null;
      }
    }

    const key = `${eventUrl.toString()}:${startsAt}`;

    if (seen.has(key)) continue;
    seen.add(key);

    const tags = [
      ...card.matchAll(
        /<div\b[^>]*class=["'][^"']*\bpm-calendar-event-tag\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
      ),
    ].map(match => text(match[1])).filter(Boolean);

    result.events.push({
      externalEventId: `html:popmenu:${key}`,
      sourceUrl: eventUrl.toString(),
      title,
      description: [
        publishedSchedule,
        recurringSchedule,
      ].filter(Boolean).join("\n") || null,
      startsAt,
      endsAt,
      allDay: false,
      flyerUrl: null,
      location: null,
      venueName: null,
      venueAddress: null,
      rawPayload: {
        extraction: "html_popmenu_calendar",
        calendarUrl: pageUrl,
        publishedSchedule,
        recurringSchedule,
        tags,
      },
    });
  }

  return result;
}

function extractPopmenuCalendarEvents(
  html: string,
  pageUrl: string,
): HtmlNormalizedEvent[] {
  return extractPopmenuCalendar(html, pageUrl).events;
}

export function extractHtmlEventsWithDiagnostics(
  html: string,
  pageUrl: string,
): {
  events: HtmlNormalizedEvent[];
  diagnostics: HtmlExtractionDiagnostics;
} {
  const events: HtmlNormalizedEvent[] = [
    ...extractDiviHtmlEvents(html, pageUrl),
    ...extractDudaGalleryEvents(html, pageUrl),
    ...extractGoogleCalendarPluginEvents(html, pageUrl),
    ...extractPopmenuCalendarEvents(html, pageUrl),
  ];

  const announcement = extractMultidayHtmlAnnouncement(
    html,
    pageUrl,
  );

  if (announcement) {
    events.push(announcement);
  }

  const errors: string[] = [];
  let expectedPerformances = 0;

  const popmenu = extractPopmenuCalendar(html, pageUrl);

  if (popmenu.cardCount > 0) {
    expectedPerformances =
      popmenu.cardCount -
      popmenu.untimedCount -
      popmenu.placeholderCount;

    if (popmenu.untimedCount > 0) {
      errors.push(
        `Popmenu: ${popmenu.untimedCount} untimed calendar entries`,
      );
    }

    if (popmenu.placeholderCount > 0) {
      errors.push(
        `Popmenu: ${popmenu.placeholderCount} unpublished placeholders`,
      );
    }

    if (popmenu.invalidCount > 0) {
      errors.push(
        `Popmenu: ${popmenu.invalidCount} invalid calendar cards`,
      );
    }
  }

  const article =
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
    "";

  const diagnostics = (): HtmlExtractionDiagnostics => ({
    recognizedSchedule: expectedPerformances > 0,
    expectedPerformances,
    extractedPerformances: events.length,
    errors,
  });

  if (!article) {
    return { events, diagnostics: diagnostics() };
  }

  /*
   * Generic Avada accordion schedules.
   *
   * A dated accordion heading identifies the schedule date.
   * Its panel contains time-range/title rows. A preceding section
   * heading and its nearby published address provide location context.
   *
   * No website, event name, or venue is hardcoded here.
   */
  const sections = [
    ...article.matchAll(
      /<h3\b[^>]*>([\s\S]*?)<\/h3>|<span\b[^>]*class=["'][^"']*fusion-toggle-heading[^"']*["'][^>]*>([\s\S]*?)<\/span>[\s\S]*?<div\b[^>]*class=["'][^"']*panel-body[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
    ),
  ];

  const months = [
    "january", "february", "march", "april",
    "may", "june", "july", "august",
    "september", "october", "november", "december",
  ];

  const datePattern =
    /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday):?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?/i;

  const performancePattern =
    /^(\d{1,2}(?::\d{2})?)\s*[–—-]\s*(\d{1,2}(?::\d{2})?)\s*(AM|PM)?\s*[–—-]\s*(.+)$/i;

  /*
   * Extract an address from its published link text, and a business
   * identity from the linked Google Maps place URL when available.
   * No Places API call is made here.
   */
  function sectionPlaceEvidence(fragment: string): {
    name: string | null;
    address: string | null;
  } {
    const links = [...fragment.matchAll(
      /<a\b[^>]*href=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/gi,
    )];

    for (const link of links) {
      const visible = text(link[3]);
      if (!/^\d{1,6}\s+\S+/.test(visible)) continue;

      const address = visible
        .replace(/,?\s*\d{5}(?:-\d{4})?\s*$/, "")
        .replace(/\s*,\s*/g, ", ")
        .replace(/\s+([A-Z]{2})(?=,|$)/, ", $1")
        .replace(/,\s*,/g, ",")
        .trim();

      let name: string | null = null;

      try {
        const url = new URL(decode(link[1] ?? link[2]), pageUrl);
        const match = url.pathname.match(/\/maps\/place\/([^/]+)/i);

        if (match) {
          name = decodeURIComponent(match[1])
            .replace(/\+/g, " ")
            .trim() || null;
        }
      } catch {
        // Malformed links cannot establish a business identity.
      }

      return { name, address };
    }

    return { name: null, address: null };
  }

  let location: string | null = null;
  let venueName: string | null = null;
  let venueAddress: string | null = null;

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];

    if (section[1] !== undefined) {
      const headingHtml = section[1];

      /*
       * Prefer the first displayed line for a section name.
       * This handles headings such as:
       *   City<br />"Event Name"
       */
      const firstLine = text(
        headingHtml.split(/<br\s*\/?>/i)[0],
      ).trim();

      /*
       * Only treat a heading as location context when the section
       * itself publishes an address before its next accordion.
       */
      const nextIndex = sections[i + 1]?.index ?? article.length;
      const fragment = article.slice(section.index, nextIndex);
      const place = sectionPlaceEvidence(fragment);

      if (place.address && firstLine && firstLine.length < 100) {
        location = firstLine;
        venueAddress = place.address;

        /*
         * Retain the section's event-area label separately from
         * the physical business identity.
         */
        if (place.name) {
          venueName = place.name;
        } else {
          venueName = firstLine;
        }
      }

      continue;
    }

    const heading = text(section[2] ?? "");
    const schedule = text(section[3] ?? "");
    const dateMatch = heading.match(datePattern);

    if (!dateMatch) continue;

    const month = months.indexOf(dateMatch[2].toLowerCase()) + 1;
    const day = Number(dateMatch[3]);

    const year = dateMatch[4]
      ? Number(dateMatch[4])
      : eventYear(article, month, day, dateMatch[1]);

    let previousMeridiem: string | null = null;

    for (const line of schedule.split("\n")) {
      const match = line.trim().match(performancePattern);
      if (!match) continue;

      expectedPerformances++;

      const title = match[4].trim();

      /*
       * A missing meridiem may inherit the immediately preceding
       * performance's meridiem within the same dated schedule.
       * Never assume PM for an isolated ambiguous time.
       */
      const meridiem: string | null =
        match[3]?.toUpperCase() ??
        previousMeridiem;

      if (!year || !location || !venueAddress || !meridiem) {
        errors.push(
          `${heading}: insufficient date, time, or location evidence for ${title}`,
        );
        continue;
      }

      const start = resolveStartTime(
        match[1],
        match[2],
        meridiem,
      );
      const finish = parseTime(match[2], meridiem);

      if (!start || !finish) {
        errors.push(`${heading}: invalid time for ${title}`);
        continue;
      }

      const startsAt = easternTimestamp(
        year, month, day, start.hour, start.minute,
      );
      const endsAt = easternTimestamp(
        year, month, day, finish.hour, finish.minute,
      );

      events.push({
        externalEventId:
          `html:${pageUrl}:${location}:${startsAt}:${title}`,
        sourceUrl: pageUrl,
        title,
        description: `${heading} — ${location}`,
        startsAt,
        endsAt,
        allDay: false,
        flyerUrl: null,
        location,
        venueName,
        venueAddress,
        rawPayload: {
          extraction: "html_performance_schedule",
          heading,
          location,
          venueAddress,
        },
      });

      previousMeridiem = meridiem;
    }
  }

  return {
    events,
    diagnostics: diagnostics(),
  };
}

export function extractHtmlEvents(
  html: string,
  pageUrl: string,
): HtmlNormalizedEvent[] {
  return extractHtmlEventsWithDiagnostics(html, pageUrl).events;
}

export async function fetchHtmlEvents(
  sourceUrl: string
): Promise<HtmlNormalizedEvent[]> {
  const response = await fetchHtml(sourceUrl);

  if (!response.ok) {
    throw new Error(
      `HTML event source returned HTTP ${response.status}. ` +
      (response.recoveryDetail ?? "")
    );
  }

  const isPopmenu =
    /pm-calendar-event-section-wrapper/i
      .test(response.html);

  if (isPopmenu) {
    const browser = await fetchBrowserEvidence(sourceUrl, getTransportRecoveryProxy());

    if (
      browser.status === null ||
      browser.status < 200 ||
      browser.status >= 400
    ) {
      throw new Error("Popmenu browser calendar unavailable");
    }

    const renderedCalendar =
      /pm-calendar-event-section-wrapper/i.test(browser.html);

    const confirmedEmpty =
      renderedCalendar &&
      /NO\s+UPCOMING\s+EVENTS/i.test(
        browser.html
          .replace(/<[^>]*>/g, " ")
          .replace(/&nbsp;/gi, " ")
      );

    const hasCards =
      /pm-calendar-event-card-wrapper/i.test(browser.html);

    if (!renderedCalendar || (!hasCards && !confirmedEmpty)) {
      throw new Error(
        "Popmenu calendar did not render a confirmed inventory"
      );
    }

    return extractHtmlEvents(
      browser.html,
      browser.finalUrl,
    );
  }

  return extractHtmlEvents(
    response.html,
    response.url || sourceUrl
  );
}
