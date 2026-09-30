import type {
  FirstPartyHarvestEvent,
} from "./types";

type TribeCategory = {
  name?: unknown;
  slug?: unknown;
};

type TribeImage = {
  url?: unknown;
};

type TribeEvent = {
  id?: unknown;
  global_id?: unknown;
  title?: unknown;
  description?: unknown;
  url?: unknown;
  image?: TribeImage | null;
  start_date?: unknown;
  end_date?: unknown;
  categories?: TribeCategory[] | null;
};

type TribeResponse = {
  events?: TribeEvent[];
  next_rest_url?: unknown;
  total?: unknown;
  total_pages?: unknown;
};

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    hellip: "…",
    rsquo: "’",
    lsquo: "‘",
    rdquo: "”",
    ldquo: "“",
  };

  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (match, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const code = Number.parseInt(entity.slice(2), 16);
        return Number.isFinite(code)
          ? String.fromCodePoint(code)
          : match;
      }

      if (entity.startsWith("#")) {
        const code = Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code)
          ? String.fromCodePoint(code)
          : match;
      }

      return named[entity.toLowerCase()] ?? match;
    }
  );
}

function htmlToText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p\s*>/gi, "\n")
      .replace(/<\/div\s*>/gi, "\n")
      .replace(/<[^>]*>/g, "")
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value.trim();

  return cleaned || null;
}

function tribeLocalToIso(
  value: unknown,
  timeZone: string
): string | null {
  const cleaned = cleanText(value);

  if (!cleaned) {
    return null;
  }

  const match = cleaned.match(
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
  );

  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match;

  /*
   * Convert Tribe's local wall-clock timestamp using the
   * source's IANA timezone. This deliberately does not trust
   * Tribe's utc_* fields because some sites publish incorrect
   * UTC conversions.
   */
  const target = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  };

  let guess = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second
  );

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  for (let i = 0; i < 3; i += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(guess))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)])
    );

    const rendered = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );

    const wanted = Date.UTC(
      target.year,
      target.month - 1,
      target.day,
      target.hour,
      target.minute,
      target.second
    );

    const adjustment = wanted - rendered;

    if (adjustment === 0) {
      return new Date(guess).toISOString();
    }

    guess += adjustment;
  }

  return null;
}

function hasCategory(
  event: TribeEvent,
  categorySlug: string | null
): boolean {
  if (!categorySlug) {
    return true;
  }

  const categories =
    Array.isArray(event.categories)
      ? event.categories
      : [];

  return categories.some(
    (category) =>
      cleanText(category.slug)?.toLowerCase() ===
      categorySlug.toLowerCase()
  );
}

function mapTribeEvent(
  event: TribeEvent,
  timeZone: string
): FirstPartyHarvestEvent | null {
  const id =
    cleanText(event.global_id) ??
    (
      typeof event.id === "number" ||
      typeof event.id === "string"
        ? String(event.id)
        : null
    );

  const rawTitle = cleanText(event.title);
  const title = rawTitle
    ? decodeHtmlEntities(rawTitle).trim()
    : null;
  const startsAt =
    tribeLocalToIso(event.start_date, timeZone);

  if (!id || !title || !startsAt) {
    return null;
  }

  const endsAt =
    tribeLocalToIso(event.end_date, timeZone);

  const sourceUrl = cleanText(event.url);

  const flyerUrl =
    event.image &&
    typeof event.image === "object"
      ? cleanText(event.image.url)
      : null;

  return {
    externalEventId: id,
    title,
    description: (() => {
      const rawDescription = cleanText(event.description);
      return rawDescription
        ? htmlToText(rawDescription)
        : null;
    })(),
    startsAt,
    endsAt,
    sourceUrl,
    flyerUrl,
    location: null,
    rawPayload: event as Record<string, unknown>,
  };
}

export async function fetchTribeRestEvents(
  sourceUrl: string,
  options: {
    categorySlug?: string | null;
    timeZone?: string;
  } = {}
): Promise<FirstPartyHarvestEvent[]> {
  const categorySlug =
    cleanText(options.categorySlug)?.toLowerCase() ??
    null;

  const timeZone =
    cleanText(options.timeZone) ??
    "America/New_York";

  const events: FirstPartyHarvestEvent[] = [];

  /*
   * Start from the configured endpoint, but request a useful
   * page size. Tribe will tell us whether more pages remain.
   */
  const baseUrl = new URL(sourceUrl);
  baseUrl.searchParams.set("per_page", "50");

  let page = 1;
  let totalPages = 1;

  do {
    const pageUrl = new URL(baseUrl.toString());
    pageUrl.searchParams.set("page", String(page));

    const response = await fetch(pageUrl.toString(), {
      headers: {
        Accept: "application/json",
        "User-Agent": "TenderFans-Event-Harvester/1.0",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(
        `Tribe REST source returned HTTP ${response.status}.`
      );
    }

    const payload =
      await response.json() as TribeResponse;

    const pageEvents =
      Array.isArray(payload.events)
        ? payload.events
        : [];

    for (const event of pageEvents) {
      if (!hasCategory(event, categorySlug)) {
        continue;
      }

      const mapped = mapTribeEvent(
        event,
        timeZone
      );

      if (mapped) {
        events.push(mapped);
      }
    }

    const reportedPages =
      typeof payload.total_pages === "number"
        ? payload.total_pages
        : Number(payload.total_pages);

    totalPages =
      Number.isFinite(reportedPages) &&
      reportedPages >= 1
        ? reportedPages
        : 1;

    page += 1;
  } while (page <= totalPages);

  /*
   * Guard against the same lifecycle identity appearing more
   * than once across pages.
   */
  const unique = new Map<
    string,
    FirstPartyHarvestEvent
  >();

  for (const event of events) {
    unique.set(event.externalEventId, event);
  }

  return [...unique.values()].sort(
    (a, b) =>
      Date.parse(a.startsAt) -
      Date.parse(b.startsAt)
  );
}
