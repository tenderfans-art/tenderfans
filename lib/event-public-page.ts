type Relation<T> = T | T[] | null;
type Page = { public_page_url?: string | null; source_page_url?: string | null; page_url?: string | null };

export type EventPageProvenance = {
  source_url?: string | null;
  publisher?: Relation<Page & { source_url?: string | null }>;
  candidate?: Relation<Page>;
  events?: Relation<{ venues?: Relation<{ website_url?: string | null }> }>;
};

function one<T>(value: Relation<T> | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value ?? undefined;
}

function webpage(value: unknown): URL | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    const path = decodeURIComponent(url.pathname);
    // Document/feed/API/widget addresses are collection inputs, not landing pages.
    if (/\.(?:ics|ical|json|xml|rss|atom|csv|pdf|jpe?g|png|webp|gif|avif|svg)\/?$/i.test(path) ||
        /\/(?:api|_api|wp-json|feeds?|ical|embed|widgets?)(?:\/|$)/i.test(path) ||
        /\/macros\/s\/[^/]+\/exec\/?$/i.test(path)) return null;
    // Calendar service views can open a signed-in user's own calendar instead
    // of the venue's embedded schedule. Use the containing webpage instead.
    if (/^(?:(?:calendar|www)\.)?google\.com$/i.test(url.hostname) && /^\/calendar(?:\/|$)/i.test(path)) return null;
    for (const [key, setting] of url.searchParams) {
      if ((/^(?:ical|ical_download)$/i.test(key) && !/^(?:0|false|no)$/i.test(setting)) ||
          (/^(?:format|output|feed)$/i.test(key) && /^(?:json|xml|ical|ics|rss|atom)$/i.test(setting))) return null;
    }
    return url;
  } catch { return null; }
}

/** Prefer event detail pages, then the recorded containing page, then the website. */
export function eventPublicPage(rows: readonly EventPageProvenance[]): string | null {
  const choices: { href: string; priority: number }[] = [];
  for (const row of rows) {
    const publisher = one(row.publisher);
    const candidate = one(row.candidate);
    const website = webpage(one(one(row.events)?.venues)?.website_url);
    const source = webpage(publisher?.source_url);
    const event = webpage(row.source_url);
    // A distinct, non-root event permalink is stronger than a calendar landing page.
    if (event && event.pathname !== "/" && event.href !== source?.href && event.href !== website?.href) {
      choices.push({ href: event.href, priority: 0 });
    }
    for (const value of [candidate?.public_page_url, candidate?.source_page_url, candidate?.page_url, publisher?.public_page_url]) {
      const page = webpage(value);
      if (page) choices.push({ href: page.href, priority: 1 });
    }
    if (event) choices.push({ href: event.href, priority: 2 });
    if (source) choices.push({ href: source.href, priority: 2 });
    if (website) choices.push({ href: website.href, priority: 3 });
  }
  choices.sort((a, b) => a.priority - b.priority);
  return choices[0]?.href ?? null;
}
