/**
 * Generic public Supabase PostgREST event reader.
 *
 * Explicit events and bounded weekly recurrence expansion.
 * Recurrence exceptions are not publicly verified.
 * Public API credentials are supplied by the caller, never embedded.
 */

export type PostgrestEvent = {
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

export type PostgrestReadResult = {
  events: PostgrestEvent[];
  totalRows: number;
  skippedRecurring: number;
  skippedInvalid: number;
  complete: boolean;
};

export type PostgrestOptions = {
  apiUrl: string;
  anonKey: string;
  table?: string;
  limit?: number;
};

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

function validDate(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;

  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : null;
}

function validTable(table: string): boolean {
  return /^[a-z][a-z0-9_]*$/i.test(table);
}

function publicEventUrl(
  row: Record<string, unknown>,
): string | null {
  const value = str(row.public_url);
  if (!value) return null;

  try {
    const url = new URL(value);
    return url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}


const RECURRENCE_HORIZON_DAYS = 35;

function localParts(
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
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type: string) =>
    Number(parts.find(part => part.type === type)?.value);

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function dayNumber(
  year: number,
  month: number,
  day: number,
): number {
  return Math.floor(
    Date.UTC(year, month - 1, day) / 86400000,
  );
}

function calendarWeekday(day: number): number {
  return new Date(day * 86400000).getUTCDay();
}

function occurrenceUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): string | null {
  const desired = Date.UTC(
    year, month - 1, day, hour, minute, second,
  );

  let timestamp = desired;

  for (let attempt = 0; attempt < 5; attempt++) {
    const actual = localParts(new Date(timestamp), timeZone);

    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );

    const difference = desired - represented;

    if (difference === 0) break;

    timestamp += difference;
  }

  const check = localParts(new Date(timestamp), timeZone);

  if (
    check.year !== year ||
    check.month !== month ||
    check.day !== day ||
    check.hour !== hour ||
    check.minute !== minute ||
    check.second !== second
  ) {
    // Nonexistent local time during a DST transition.
    return null;
  }

  return new Date(timestamp).toISOString();
}

function expandWeeklyRecurrence(
  row: Record<string, unknown>,
  now: number,
): Record<string, unknown>[] | null {
  if (
    str(row.recurrence_frequency)?.toLowerCase() !== "weekly"
  ) {
    return null;
  }

  const id = str(row.id);
  const start = validDate(row.start_at);
  const timeZone = str(row.event_timezone);
  const interval = row.recurrence_interval;
  const weekdays = row.recurrence_byweekday;
  const duration = row.duration_minutes;

  if (
    !id ||
    !start ||
    !timeZone ||
    !Number.isInteger(interval) ||
    typeof interval !== "number" ||
    interval < 1 ||
    interval > 52 ||
    !Array.isArray(weekdays) ||
    weekdays.length === 0 ||
    !weekdays.every(
      day => Number.isInteger(day) && day >= 0 && day <= 6
    ) ||
    typeof duration !== "number" ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 1440 ||
    row.recurrence_bysetpos != null
  ) {
    return null;
  }

  let anchor;
  let today;

  try {
    anchor = localParts(new Date(start), timeZone);
    today = localParts(new Date(now), timeZone);
  } catch {
    return null;
  }

  const anchorDay = dayNumber(
    anchor.year, anchor.month, anchor.day,
  );

  const todayDay = dayNumber(
    today.year, today.month, today.day,
  );

  const until = row.recurrence_until == null
    ? null
    : validDate(row.recurrence_until);

  if (row.recurrence_until != null && !until) {
    return null;
  }

  const occurrences: Record<string, unknown>[] = [];

  for (
    let offset = 0;
    offset <= RECURRENCE_HORIZON_DAYS;
    offset++
  ) {
    const currentDay = todayDay + offset;
    const elapsedDays = currentDay - anchorDay;

    if (elapsedDays < 0) continue;

    // Anchor recurrence intervals to calendar weeks, not
    // rolling seven-day periods from the first occurrence.
    // Week starts on Sunday, matching JS weekday numbering.
    const anchorWeekStart =
      anchorDay - new Date(anchorDay * 86400000).getUTCDay();

    const currentWeekStart =
      currentDay - calendarWeekday(currentDay);

    const week = Math.floor(
      (currentWeekStart - anchorWeekStart) / 7,
    );

    if (week % interval !== 0) continue;

    const calendar = new Date(currentDay * 86400000);
    const weekday = calendar.getUTCDay();

    if (!weekdays.includes(weekday)) continue;

    const year = calendar.getUTCFullYear();
    const month = calendar.getUTCMonth() + 1;
    const day = calendar.getUTCDate();

    const startsAt = occurrenceUtc(
      year,
      month,
      day,
      anchor.hour,
      anchor.minute,
      anchor.second,
      timeZone,
    );

    if (!startsAt) continue;

    const startTime = Date.parse(startsAt);
    const endTime = startTime + duration * 60000;

    if (endTime < now) continue;
    if (until && startTime > Date.parse(until)) continue;

    const occurrenceDate = [
      String(year).padStart(4, "0"),
      String(month).padStart(2, "0"),
      String(day).padStart(2, "0"),
    ].join("-");

    occurrences.push({
      ...row,
      id: id + ":occurrence:" + occurrenceDate,
      start_at: startsAt,
      end_at: new Date(endTime).toISOString(),
      recurrence_frequency: "none",
      postgrestSeriesId: id,
      postgrestOccurrenceDate: occurrenceDate,
      postgrestRecurrenceGenerated: true,
      postgrestExceptionsVerified: false,
    });
  }

  return occurrences;
}

export function normalizePostgrestEvents(
  rows: unknown,
): PostgrestReadResult {
  if (!Array.isArray(rows)) {
    throw new Error("PostgREST response is not an array");
  }

  const events: PostgrestEvent[] = [];
  let skippedRecurring = 0;
  let skippedInvalid = 0;

  const expandedRows: unknown[] = [];

  for (const item of rows) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item)
    ) {
      expandedRows.push(item);
      continue;
    }

    const row = item as Record<string, unknown>;
    const frequency = str(row.recurrence_frequency);

    if (frequency && frequency.toLowerCase() !== "none") {
      const expanded = expandWeeklyRecurrence(
        row,
        Date.now(),
      );

      if (!expanded) {
        skippedRecurring++;
        continue;
      }

      expandedRows.push(...expanded);
      continue;
    }

    expandedRows.push(row);
  }

  for (const item of expandedRows) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item)
    ) {
      skippedInvalid++;
      continue;
    }

    const row = item as Record<string, unknown>;

    const id = str(row.id);
    const title = str(row.title);
    const startsAt = validDate(row.start_at);

    if (!id || !title || !startsAt) {
      skippedInvalid++;
      continue;
    }

    const endsAt = validDate(row.end_at);
    const duration = row.duration_minutes;

    let calculatedEnd = endsAt;

    if (
      !calculatedEnd &&
      typeof duration === "number" &&
      Number.isFinite(duration) &&
      duration > 0
    ) {
      calculatedEnd = new Date(
        Date.parse(startsAt) + duration * 60000,
      ).toISOString();
    }

    if (
      calculatedEnd &&
      Date.parse(calculatedEnd) <= Date.parse(startsAt)
    ) {
      skippedInvalid++;
      continue;
    }

    events.push({
      externalEventId: id,
      sourceUrl: publicEventUrl(row),
      title,
      description: str(row.description),
      startsAt,
      endsAt: calculatedEnd,
      allDay: false,
      flyerUrl: str(row.image_url),
      location: str(row.location) ?? str(row.default_location),
      venueName: null,
      venueAddress: null,
      rawPayload: {
        ...row,
        postgrestAdapterVersion: 1,
        recurrenceExpansionApplied: row.postgrestRecurrenceGenerated === true,
      },
    });
  }

  return {
    events,
    totalRows: rows.length,
    skippedRecurring,
    skippedInvalid,
    complete: skippedRecurring === 0 && skippedInvalid === 0,
  };
}

export async function fetchSupabasePostgrestEvents(
  options: PostgrestOptions,
): Promise<PostgrestReadResult> {
  const table = options.table ?? "events";
  const limit = options.limit ?? 1000;

  if (!validTable(table)) {
    throw new Error("Invalid PostgREST table name");
  }

  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000
  ) {
    throw new Error("Invalid PostgREST limit");
  }

  const api = new URL(options.apiUrl);

  if (
    api.protocol !== "https:" ||
    !/^[a-z0-9-]+\.supabase\.co$/i.test(api.hostname) ||
    api.username ||
    api.password ||
    api.port ||
    api.pathname !== "/"
  ) {
    throw new Error("Invalid public Supabase API URL");
  }

  if (!options.anonKey.trim()) {
    throw new Error("Missing public API key");
  }

  const endpoint = new URL(
    `/rest/v1/${table}`,
    api,
  );

  endpoint.searchParams.set("select", "*");
  endpoint.searchParams.set("limit", String(limit));

  const response = await fetch(endpoint, {
    headers: {
      apikey: options.anonKey,
      Authorization: `Bearer ${options.anonKey}`,
      Accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(
      `PostgREST event read failed: HTTP ${response.status}`,
    );
  }

  const rows: unknown = await response.json();

  const result = normalizePostgrestEvents(rows);

  // A full page may conceal additional records.
  return {
    ...result,
    complete:
      result.complete &&
      result.totalRows < limit,
  };
}
