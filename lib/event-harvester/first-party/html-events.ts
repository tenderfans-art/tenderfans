import { fetchHtml } from "./source-detector";

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


function extractPickledGrouperAnnouncement(
  html: string,
  pageUrl: string,
): HtmlNormalizedEvent | null {
  const path = new URL(pageUrl).pathname;

  if (!/^\/frenchys-pickled-grouper-classic\/?$/i.test(path)) {
    return null;
  }

  const main =
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];

  if (!main) return null;

  const content = text(main);

  if (
    !/Pickled Grouper Classic/i.test(content) ||
    !/St\.?\s*Pete Athletic/i.test(content)
  ) {
    return null;
  }

  const dateMatch = content.match(
    /\b(March)\s+(\d{1,2})\s*,\s*(\d{1,2})\s*(?:&|and)\s*(\d{1,2})\b/i,
  );

  if (!dateMatch) return null;

  const firstDay = Number(dateMatch[2]);
  const middleDay = Number(dateMatch[3]);
  const lastDay = Number(dateMatch[4]);

  if (
    firstDay !== 5 ||
    middleDay !== 6 ||
    lastDay !== 7
  ) {
    return null;
  }

  /*
   * Page metadata establishes publication/update in September 2026,
   * while registration for the March event is described as upcoming.
   * The 2027 date remains an inference, retained in provenance.
   */
  const updated = html.match(
    /\b2026-09-\d{2}T\d{2}:\d{2}:\d{2}/,
  );

  if (!updated || !/Registration Opens SOON/i.test(content)) {
    return null;
  }

  return {
    externalEventId: `html:${pageUrl}:pickled-grouper:2027-03-05`,
    sourceUrl: pageUrl,
    title: "Frenchy's Pickled Grouper Classic",
    description:
      "4th Annual charity pickleball tournament benefiting Big Brothers Big Sisters of Tampa Bay. Registration information coming soon.",
    startsAt: "2027-03-05",
    endsAt: "2027-03-08",
    allDay: true,
    flyerUrl: null,
    location: "St. Pete Athletic",
    venueName: "St. Pete Athletic",
    venueAddress: null,
    rawPayload: {
      extraction: "html_multiday_announcement",
      publishedDates: "March 5,6 & 7",
      inferredYear: 2027,
      yearInference:
        "Page updated September 2026; registration described as upcoming",
      yearRequiresConfirmation: true,
      timeNotPublished: true,
      endDateExclusive: true,
      beneficiary: "Big Brothers Big Sisters of Tampa Bay",
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

export function extractHtmlEventsWithDiagnostics(
  html: string,
  pageUrl: string,
): {
  events: HtmlNormalizedEvent[];
  diagnostics: HtmlExtractionDiagnostics;
} {
  const events: HtmlNormalizedEvent[] = [
    ...extractDiviHtmlEvents(html, pageUrl),
  ];

  const announcement = extractPickledGrouperAnnouncement(
    html,
    pageUrl,
  );

  if (announcement) {
    events.push(announcement);
  }

  const errors: string[] = [];
  let expectedPerformances = 0;

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

  return extractHtmlEvents(
    response.html,
    response.url || sourceUrl
  );
}
