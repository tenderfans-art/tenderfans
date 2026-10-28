import { recoveryFetch } from "@/lib/event-harvester/recovery-fetch";
import type { FirstPartyHarvestEvent } from "./types";

type SquareRecord = Record<string, unknown>;

type SquareIdentity = {
  userId: string;
  siteId: string;
};

function record(value: unknown): SquareRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as SquareRecord
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractBootstrap(html: string): SquareRecord | null {
  const marker = /window\.__BOOTSTRAP_STATE__\s*=\s*/.exec(html);
  if (!marker) return null;

  const remainder = html.slice(marker.index + marker[0].length);
  const start = remainder.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = start; index < remainder.length; index++) {
    const char = remainder[index];

    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        try {
          return record(JSON.parse(remainder.slice(start, index + 1)));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

export function discoverSquareIdentity(
  html: string,
): SquareIdentity | null {
  if (!/editmysite\.com|Square Online/i.test(html)) return null;

  const state = extractBootstrap(html);
  if (!state) return null;

  const site = record(record(record(state.siteData).site).properties);
  const siteId = string(site.catalogSiteId) ||
    string(site.classicSiteID);

  /*
   * Square Online exposes both identifiers in its bootstrap
   * state. Discover them per storefront; never hardcode IDs.
   */
  const user = record(record(state.siteData).user);
  const rawUserId = user.id;

  const userId =
    typeof rawUserId === "number" ||
    typeof rawUserId === "string"
      ? String(rawUserId)
      : "";

  if (
    !/^\d+$/.test(userId) ||
    !/^\d+$/.test(siteId)
  ) {
    return null;
  }

  return { userId, siteId };
}

function apiUrl(identity: SquareIdentity, page: number): string {
  const url = new URL(
    `https://cdn5.editmysite.com/app/store/api/v28/editor/users/${identity.userId}/sites/${identity.siteId}/products`
  );
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", "50");
  url.searchParams.set("include", "images,media_files");
  return url.toString();
}

async function catalog(
  identity: SquareIdentity,
  fetcher: typeof recoveryFetch,
): Promise<SquareRecord[]> {
  const products: SquareRecord[] = [];
  const seen = new Set<string>();
  let totalPages = 1;

  for (let page = 1; page <= Math.min(totalPages, 40); page++) {
    const response = await fetcher(apiUrl(identity, page), {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Square catalog HTTP ${response.status}`);
    }

    const payload = record(await response.json());
    if (!Array.isArray(payload.data)) {
      throw new Error("Square catalog returned invalid data");
    }

    const pagination = record(record(payload.meta).pagination);
    const reportedPages = Number(pagination.total_pages);

    if (!Number.isInteger(reportedPages) ||
        reportedPages < 1 || reportedPages > 40) {
      throw new Error("Square catalog pagination is invalid or too large");
    }

    totalPages = reportedPages;

    for (const value of payload.data) {
      const product = record(value);
      const id = String(product.id ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      products.push(product);
    }
  }

  return products;
}

function dateTime(
  date: string,
  time: string,
  timeZone: string,
): string | null {
  const dateMatch = /^(20\d{2})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(time);

  if (!dateMatch || !timeMatch) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour12 = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);

  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;

  const hour = hour12 % 12 +
    (timeMatch[3].toUpperCase() === "PM" ? 12 : 0);

  const desired = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(Date.UTC(year, month - 1, day));

  if (check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day) return null;

  let candidate = desired;

  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });

    for (let attempt = 0; attempt < 4; attempt++) {
      const parts = Object.fromEntries(
        formatter.formatToParts(new Date(candidate))
          .filter(part => part.type !== "literal")
          .map(part => [part.type, Number(part.value)])
      );

      const represented = Date.UTC(
        parts.year, parts.month - 1, parts.day,
        parts.hour, parts.minute
      );

      const difference = desired - represented;
      candidate += difference;
      if (difference === 0) break;
    }

    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(candidate))
        .filter(part => part.type !== "literal")
        .map(part => [part.type, Number(part.value)])
    );

    if (parts.year !== year || parts.month !== month ||
        parts.day !== day || parts.hour !== hour ||
        parts.minute !== minute) return null;

    return new Date(candidate).toISOString();
  } catch {
    return null;
  }
}

export async function inspectSquareOnline(
  html: string,
  fetcher: typeof recoveryFetch = recoveryFetch,
): Promise<boolean> {
  const identity = discoverSquareIdentity(html);
  if (!identity) return false;

  const products = await catalog(identity, fetcher);
  return products.some(product => product.product_type === "event");
}

export async function fetchSquareOnlineEvents(
  sourceUrl: string,
  options: { fetcher?: typeof recoveryFetch } = {},
): Promise<FirstPartyHarvestEvent[]> {
  const fetcher = options.fetcher ?? recoveryFetch;
  const page = await fetcher(sourceUrl, {
    headers: { "User-Agent": "Mozilla/5.0" },
    cache: "no-store",
  });

  if (!page.ok) throw new Error(`Square website HTTP ${page.status}`);

  const html = await page.text();
  const identity = discoverSquareIdentity(html);

  if (!identity) {
    throw new Error("Square Online catalog identity not discovered");
  }

  const products = await catalog(identity, fetcher);
  const now = Date.now();
  const events: FirstPartyHarvestEvent[] = [];

  for (const product of products) {
    if (product.product_type !== "event") continue;

    const details = record(product.product_type_details);
    const title = string(product.name);
    const id = String(product.id ?? "");
    const timezone = string(details.timezone);

    if (!title || !id || !timezone) continue;

    const startsAt = dateTime(
      string(details.start_date),
      string(details.start_time),
      timezone,
    );

    if (!startsAt || Date.parse(startsAt) < now) continue;

    const endsAt = dateTime(
      string(details.end_date),
      string(details.end_time),
      timezone,
    );

    const image = record(record(product.thumbnail).data);
    const description = string(product.description);

    events.push({
      externalEventId: `square-online:product:${id}`,
      title,
      description: description || null,
      startsAt,
      endsAt: endsAt && endsAt >= startsAt ? endsAt : null,
      allDay: false,
      sourceUrl: string(product.absolute_site_link) || sourceUrl,
      flyerUrl: string(image.absolute_url) || null,
      location: null,
      venueName: null,
      venueAddress: null,
      rawPayload: {
        platform: "square_online",
        productId: id,
        timezone,
        dateEvidence: "square_structured_event",
        allowSourceDefaultAttribution: true,
      },
    });
  }

  return events.sort(
    (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)
  );
}
