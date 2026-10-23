import { recoveryFetch } from "@/lib/event-harvester/recovery-fetch";
import type { FirstPartyHarvestEvent } from "./types";

type WordPressPost = {
  id: number;
  date: string;
  link: string;
  title: { rendered: string };
  content: { rendered: string };
};

type Clock = { hour: number; minute: number };

const MONTHS = [
  "january", "february", "march", "april",
  "may", "june", "july", "august",
  "september", "october", "november", "december",
];

const DATE_PATTERN =
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/gi;

const WEEKDAYS = [
  "sunday", "monday", "tuesday", "wednesday",
  "thursday", "friday", "saturday",
];

function clean(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&rsquo;|&#8217;/gi, "’")
    .replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&#(\d+);/g, (_, n: string) =>
      String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) =>
      String.fromCodePoint(parseInt(n, 16)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}

function clock(value: string): Clock | null {
  const m = value.match(
    /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i,
  );
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2] ?? "0");
  if (hour < 1 || hour > 12 || minute > 59) return null;
  return {
    hour: hour % 12 + (m[3].toLowerCase() === "pm" ? 12 : 0),
    minute,
  };
}


function parseTimeRange(
  text: string,
): { start: Clock; end: Clock } | null {
  const token = String.raw`\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midnight`;
  const pattern = new RegExp(
    String.raw`\b(${token})\s*(?:to|[-–—])\s*(${token})\b`,
    "i",
  );

  const match = text.match(pattern);
  if (!match) return null;

  const left = match[1].trim();
  const right = match[2].trim();

  const resolve = (value: string, other: string): Clock | null => {
    if (/^noon$/i.test(value)) return { hour: 12, minute: 0 };
    if (/^midnight$/i.test(value)) return { hour: 0, minute: 0 };

    if (/(?:am|pm)$/i.test(value)) return clock(value);

    const meridiem = other.match(/(am|pm)$/i)?.[1];
    return meridiem ? clock(`${value}${meridiem}`) : null;
  };

  const end = resolve(right, left);
  const start = resolve(left, right);

  if (!start || !end) return null;

  return { start, end };
}


function cleanVenueCandidate(value: string): string {
  return value
    .replace(/[\u200B-\u200D\uFE0E\uFE0F]/g, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:!?.-]+|[\s,;:!?.-]+$/g, "")
    .trim();
}

function extractVenueName(
  title: string,
  body: string,
): string | null {
  const explicit = body.match(
    /\b(?:venue|location)\s*:\s*([^\n]{3,100})/i,
  );
  if (explicit) return cleanVenueCandidate(explicit[1]) || null;

  const lines = body.split("\n").map(x => x.trim()).filter(Boolean);

  const street =
    /\b\d{1,6}\s+[A-Za-z0-9.'’ -]+\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Highway|Hwy)\b/i;

  for (let i = 1; i < lines.length; i++) {
    if (!street.test(lines[i])) continue;

    const candidate = cleanVenueCandidate(lines[i - 1]);

    if (
      candidate.length >= 3 &&
      candidate.length <= 80 &&
      !/\b(?:call|visit|register|tickets|parking)\b/i.test(candidate) &&
      !/\b(?:breakfast with|dinner with|concert series|movie night)\b/i.test(candidate)
    ) return candidate;
  }

  const contextual = body.match(
    /\b(?:join us at|taking place at|held at|happening at)\s+(.{3,100}?)\s+(?:on\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)|for\s+(?:a|an|the)|this\s+(?:Friday|Saturday|Sunday))/i,
  );
  if (contextual) return cleanVenueCandidate(contextual[1]) || null;

  // The final "at" phrase is more likely to identify a venue
  // than an earlier activity description.
  const matches = [...title.matchAll(/\bat\s+([^:!?\n]+)/gi)];
  const last = matches.at(-1);

  if (last) {
    const candidate = cleanVenueCandidate(last[1]);
    if (
      candidate.length >= 3 &&
      candidate.length <= 90 &&
      !/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(candidate)
    ) return candidate;
  }

  return null;
}

function extractVenueAddress(text: string): string | null {
  const lines = text.split("\n").map(line => line.trim()).filter(Boolean);

  const streetPattern =
    /\b\d{1,6}\s+[A-Za-z0-9.'’ -]+\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Highway|Hwy)\b/i;

  for (let i = 0; i < lines.length; i++) {
    const street = lines[i].match(streetPattern);
    if (!street) continue;

    const afterStreet = lines[i].slice(street.index ?? 0);
    if (/,\s*[^,]+,\s*[A-Z]{2}\s*\d{5}/i.test(afterStreet)) {
      return afterStreet;
    }

    const locality = lines[i + 1] ?? "";
    if (/^[A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5})?$/i.test(locality)) {
      return `${afterStreet}, ${locality}`;
    }
  }

  return null;
}

function localParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type: string) =>
    Number(parts.find(p => p.type === type)?.value);

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

function timestamp(
  year: number,
  month: number,
  day: number,
  time: Clock,
  timeZone: string,
): string | null {
  // Discovery needs to verify that an event has a parseable local
  // schedule without assuming the publisher's timezone.
  // The sentinel is never used for ingestion or publication.
  if (timeZone === "__qualification_only__") {
    return new Date(Date.UTC(
      year, month - 1, day, time.hour, time.minute,
    )).toISOString();
  }
  const target = Date.UTC(
    year, month - 1, day, time.hour, time.minute,
  );

  // Search the possible UTC offsets. This handles DST transitions
  // and rejects nonexistent or ambiguous local wall-clock times.
  const matches: number[] = [];

  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const candidate = target - offset * 60_000;
    const local = localParts(new Date(candidate), timeZone);

    if (
      local.year === year &&
      local.month === month &&
      local.day === day &&
      local.hour === time.hour &&
      local.minute === time.minute
    ) {
      matches.push(candidate);
    }
  }

  return matches.length === 1
    ? new Date(matches[0]).toISOString()
    : null;
}


function extractScheduledActivities(
  post: WordPressPost,
  title: string,
  body: string,
  year: number,
  month: number,
  day: number,
  explicitYear: boolean,
  timeZone: string,
): FirstPartyHarvestEvent[] {
  const venueName = extractVenueName(title, body);
  const venueAddress = extractVenueAddress(body);

  const lines = body
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

  type Activity = {
    name: string;
    time: Clock;
    evidence: string;
  };

  const activities: Activity[] = [];

  const add = (
    name: string,
    timeText: string,
    evidence: string,
  ) => {
    const parsed = clock(timeText);
    const normalizedName = name
      .replace(/\s+/g, " ")
      .replace(/^[\s:–—-]+|[\s:–—-]+$/g, "")
      .trim();

    if (!parsed || normalizedName.length < 3) return;

    if (
      activities.some(a =>
        a.name.toLowerCase() === normalizedName.toLowerCase() &&
        a.time.hour === parsed.hour &&
        a.time.minute === parsed.minute
      )
    ) return;

    activities.push({
      name: normalizedName,
      time: parsed,
      evidence,
    });
  };

  // Timetable entries may include descriptive prose after the
  // activity name. Prefer a short name boundary when one exists.
  const descriptionBoundary =
    /\s+(?=(?:A|An|The|Get|Come|Join|Enjoy|Keep|Watch|Experience|Don't|We)\s+[a-z])/;

  for (const line of lines) {
    // "2:00 PM – Performer Name A high-energy tribute..."
    // "7 PM - Trivia Night Join us for..."
    const scheduledEntries = [
      ...line.matchAll(
        /(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*[-–—]\s*([^–—\n]{3,200})/gi,
      ),
    ];

    if (scheduledEntries.length) {
      for (const scheduled of scheduledEntries) {
        let name = scheduled[2]
          .replace(/^(?:headliner|featuring)\s*:\s*/i, "")
          .trim();

        const boundary = name.search(descriptionBoundary);
        if (boundary > 2) {
          name = name.slice(0, boundary).trim();
        }

        name = name.split(/[.!?]/)[0].trim();

        add(name, scheduled[1], line);
      }
      continue;
    }

    // Explicitly announced food service or other activities.
    // Capture the activity, not the surrounding sentence.
    const service = line.match(
      /\b(breakfast|brunch|lunch|dinner|happy hour|trivia|karaoke|bingo)\b.{0,45}?\b(?:beginning|starting|starts|begins)\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i,
    );

    if (service) {
      add(service[1], service[2], line);
      continue;
    }

    // Other named activities with a clearly stated start.
    const announced = line.match(
      /\b([A-Za-z][A-Za-z0-9 '&-]{2,70}?)\s+(?:beginning|starting|starts|begins)\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i,
    );

    if (announced) {
      const phrase = announced[1]
        .split(/[,.;]/)
        .at(-1)
        ?.trim() ?? "";

      // Do not create an event from an incomplete sentence fragment.
      if (
        phrase.length >= 3 &&
        !/\b(?:we|we'll|we’re|we've|they|they'll|it|it's)\b/i.test(phrase)
      ) {
        add(phrase, announced[2], line);
      }
    }
  }

  return activities.flatMap((activity) => {
    const startsAt = timestamp(
      year, month, day, activity.time, timeZone,
    );

    if (!startsAt) return [];

    const timeKey =
      `${activity.time.hour}-${activity.time.minute}`;

    const nameKey = activity.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);

    return [{
      externalEventId:
        `wordpress-category:${post.id}:${year}-${month}-${day}:${timeKey}:${nameKey}`,
      title: activity.name,
      description: body,
      startsAt,
      endsAt: null,
      allDay: false,
      sourceUrl: post.link,
      flyerUrl: null,
      location: venueAddress ?? venueName,
      venueName,
      venueAddress,
      rawPayload: {
        platform: "wordpress_category_events",
        postId: post.id,
        postUrl: post.link,
        publishedAt: post.date,
        extraction: "wordpress_scheduled_activity",
        allowSourceDefaultAttribution: false,
        eventEvidence: {
          requiresReview: true,
          reasons: [
            "Activity extracted from a multi-schedule article",
            ...(!explicitYear
              ? ["Event year inferred from article publication date"]
              : []),
          ],
          explicitYear,
          timeZone,
          activityEvidence: activity.evidence,
        },
      },
    }];
  });
}

function extractSectionActivityTitle(
  section: string,
): string | null {
  const pattern =
    /^\s*([A-Za-z][A-Za-z0-9 '&–-]{2,75}?)\s+(?:starts?|begins?|starting|beginning)\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/im;

  const match = section.match(pattern);
  if (!match) return null;

  const title = match[1].replace(/\s+/g, " ").trim();
  return title.length >= 3 ? title : null;
}

function extractMultiDateSections(
  post: WordPressPost,
  timeZone: string,
): FirstPartyHarvestEvent[] {
  const body = clean(post.content.rendered);
  const lines = body.split("\n");

  const headingPattern =
    /^\s*(?:(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s*,?\s+)?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\s*[:\-–—]?\s*$/i;

  const headings: Array<{ index: number; date: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(headingPattern);
    if (!match) continue;

    headings.push({
      index: i,
      date: match[0].trim(),
    });
  }

  if (headings.length < 2) return [];

  const events: FirstPartyHarvestEvent[] = [];

  for (let i = 0; i < headings.length; i++) {
    const current = headings[i];
    const next = headings[i + 1];

    const section = lines
      .slice(current.index + 1, next?.index ?? lines.length)
      .join("\n")
      .trim();

    if (!section) continue;

    const sectionPost: WordPressPost = {
      ...post,
      title: { rendered: current.date },
      content: { rendered: section },
    };

    const sectionEvents = normalize(sectionPost, timeZone, false);
    const activityTitle = extractSectionActivityTitle(section);

    for (const event of sectionEvents) {
      events.push({
        ...event,
        title: activityTitle ?? event.title,
        rawPayload: {
          ...(event.rawPayload &&
          typeof event.rawPayload === "object" &&
          !Array.isArray(event.rawPayload)
            ? event.rawPayload
            : {}),
          extraction: "wordpress_multi_date_section",
          originalArticleTitle: clean(post.title.rendered),
          sectionHeading: current.date,
          allowSourceDefaultAttribution: false,
          eventEvidence: {
            ...(event.rawPayload &&
            typeof event.rawPayload === "object" &&
            !Array.isArray(event.rawPayload) &&
            "eventEvidence" in event.rawPayload &&
            event.rawPayload.eventEvidence &&
            typeof event.rawPayload.eventEvidence === "object" &&
            !Array.isArray(event.rawPayload.eventEvidence)
              ? event.rawPayload.eventEvidence
              : {}),
            requiresReview: true,
            reasons: [
              "Event extracted from a multi-date article section",
            ],
          },
        },
      });
    }
  }

  return events;
}

function normalize(
  post: WordPressPost,
  timeZone: string,
allowMultiDate = true,
): FirstPartyHarvestEvent[] {
  const title = clean(post.title.rendered);
  const body = clean(post.content.rendered);
  const combined = `${title}\n${body}`;

  const dates = [...combined.matchAll(DATE_PATTERN)];

  if (!dates.length) return [];

  const distinct = new Set(
    dates.map(m =>
      `${m[1].toLowerCase()}:${Number(m[2])}:${m[3] ?? "?"}`,
    ),
  );

  // Multi-date articles require independent date-section parsing.
  if (distinct.size !== 1) {
    return allowMultiDate
      ? extractMultiDateSections(post, timeZone)
      : [];
  }

  const match = dates[0];
  const month = MONTHS.indexOf(match[1].toLowerCase()) + 1;
  const day = Number(match[2]);
  const explicitYear = Boolean(match[3]);
  const publishedYear = Number(post.date.slice(0, 4));
  const year = explicitYear ? Number(match[3]) : publishedYear;

  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    return [];
  }

  const calendarDate = new Date(Date.UTC(year, month - 1, day));

  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) return [];

  const preceding = combined.slice(
    Math.max(0, (match.index ?? 0) - 20),
    match.index ?? 0,
  );

  const weekday = preceding.match(
    /\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s*,?\s*$/i,
  );

  if (
    weekday &&
    calendarDate.getUTCDay() !==
      WEEKDAYS.indexOf(weekday[1].toLowerCase())
  ) return [];

  const TIME =
    String.raw`(\d{1,2}(?::\d{2})?\s*(?:am|pm))`;

  const rangePattern = new RegExp(
    `${TIME}\\s*(?:to|[-–—])\\s*${TIME}`, "gi",
  );

  const ranges = [...combined.matchAll(rangePattern)];

  const singlePattern = new RegExp(
    `\\b(?:at|from|starts?\\s+at)\\s+${TIME}`, "gi",
  );

  const singles = [...combined.matchAll(singlePattern)];

  // A separate lineup or activity schedule can contain several
  // distinct times. A single first match must not be promoted
  // to the event's overall start.
  const allClockMentions = [
    ...combined.matchAll(
      /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi,
    ),
  ].map(m => m[0].toLowerCase().replace(/\\s+/g, ""));

  const distinctClockMentions = new Set(allClockMentions);

  // Multiple clock times without an explicit overall event range
  // may describe separate activities, performers, or schedules.
  // Do not promote the first activity to the event start.
  if (
    distinctClockMentions.size > 2 &&
    ranges.length === 0
  ) {
    return extractScheduledActivities(
      post, title, body, year, month, day,
      explicitYear, timeZone,
    );
  }

  // Different explicit time windows may represent separate activities.
  // Do not collapse them into one guessed occurrence.
  const distinctRanges = new Set(
    ranges.map(m => `${m[1]}:${m[2]}`.toLowerCase()),
  );

  if (distinctRanges.size > 1) return [];

  let start: Clock | null = null;
  let end: Clock | null = null;

  const flexibleRange = parseTimeRange(combined);

  if (ranges.length) {
    start = clock(ranges[0][1]);
    end = clock(ranges[0][2]);
  } else if (flexibleRange) {
    // Do not promote one activity's range to the entire event
    // when additional clock times indicate a larger schedule.
    if (
      distinctClockMentions.size > 2 ||
      new Set(
        singles.map(m => m[1].toLowerCase().replace(/\s+/g, ""))
      ).size > 1
    ) return [];

    start = flexibleRange.start;
    end = flexibleRange.end;
  } else {
    const uniqueSingles = new Set(
      singles.map(m => m[1].toLowerCase().replace(/\s+/g, "")),
    );

    // If several distinct clock times are mentioned but no
    // unambiguous overall range exists, require further review.
    if (
      uniqueSingles.size !== 1 ||
      distinctClockMentions.size > 1
    ) return [];

    start = clock(singles[0][1]);
  }

  if (!start) return [];

  const startsAt = timestamp(year, month, day, start, timeZone);
  const endsAt = end
    ? timestamp(year, month, day, end, timeZone)
    : null;

  if (!startsAt || (end && !endsAt)) return [];

  if (
    endsAt &&
    Date.parse(endsAt) <= Date.parse(startsAt)
  ) return [];

  // A publisher's own name must not be guessed from its domain.
  // Explicit venue and address evidence is handled separately.
  const venueName = extractVenueName(title, body);
  const venueAddress = extractVenueAddress(body);

  const requiresReview = !explicitYear;

  return [{
    externalEventId:
      `wordpress-category:${post.id}:${year}-${month}-${day}:${start.hour}-${start.minute}`,
    title,
    description: body,
    startsAt,
    endsAt,
    allDay: false,
    sourceUrl: post.link,
    flyerUrl: null,
    location: venueAddress ?? venueName,
    venueName,
    venueAddress,
    rawPayload: {
      platform: "wordpress_category_events",
      postId: post.id,
      postUrl: post.link,
      publishedAt: post.date,
      extraction: "wordpress_single_occurrence",
      allowSourceDefaultAttribution: false,
      eventEvidence: {
        requiresReview,
        reasons: requiresReview
          ? ["Event year inferred from article publication date"]
          : [],
        explicitYear,
        timeZone,
      },
    },
  }];
}

export function hasParseableWordPressCategoryEvents(
  posts: unknown,
): boolean {
  if (!Array.isArray(posts)) return false;

  return posts.some((post: WordPressPost) => {
    if (
      !post ||
      !Number.isInteger(post.id) ||
      typeof post.date !== "string" ||
      typeof post.link !== "string" ||
      typeof post.title?.rendered !== "string" ||
      typeof post.content?.rendered !== "string"
    ) return false;

    return normalize(
      post,
      "__qualification_only__",
    ).length > 0;
  });
}

export async function fetchWordPressCategoryEvents(
  sourceUrl: string,
  options: { timeZone?: string } = {},
): Promise<FirstPartyHarvestEvent[]> {
  const timeZone = options.timeZone;

  // Without a verified timezone, wall-clock announcements
  // cannot be converted safely into absolute timestamps.
  if (!timeZone) {
    throw new Error(
      "WordPress category source requires config.timezone",
    );
  }

  // Validate the IANA timezone before making the network request.
  new Intl.DateTimeFormat("en-US", { timeZone });

  const response = await recoveryFetch(sourceUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": "TenderFans Event Harvester/1.0",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(
      `WordPress category API returned HTTP ${response.status}`,
    );
  }

  const posts: unknown = await response.json();

  if (!Array.isArray(posts)) {
    throw new Error(
      "WordPress category API did not return a post array",
    );
  }

  const events: FirstPartyHarvestEvent[] = [];

  for (const post of posts as WordPressPost[]) {
    if (
      !post ||
      !Number.isInteger(post.id) ||
      typeof post.date !== "string" ||
      typeof post.link !== "string" ||
      typeof post.title?.rendered !== "string" ||
      typeof post.content?.rendered !== "string"
    ) continue;

    events.push(...normalize(post, timeZone));
  }

  return events.sort(
    (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt),
  );
}
