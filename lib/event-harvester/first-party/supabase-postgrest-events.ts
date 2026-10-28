/**
 * Generic public Supabase PostgREST event reader.
 *
 * Phase 1: explicit, nonrecurring events only.
 * No source registration, recurrence expansion, or publication.
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

export function normalizePostgrestEvents(
  rows: unknown,
): PostgrestReadResult {
  if (!Array.isArray(rows)) {
    throw new Error("PostgREST response is not an array");
  }

  const events: PostgrestEvent[] = [];
  let skippedRecurring = 0;
  let skippedInvalid = 0;

  for (const item of rows) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item)
    ) {
      skippedInvalid++;
      continue;
    }

    const row = item as Record<string, unknown>;

    const frequency = str(row.recurrence_frequency);

    if (frequency && frequency.toLowerCase() !== "none") {
      skippedRecurring++;
      continue;
    }

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
        recurrenceExpansionApplied: false,
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
