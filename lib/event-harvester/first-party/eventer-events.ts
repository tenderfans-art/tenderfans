import { signedHarvesterFetch } from "@/lib/event-harvester/signed-fetch";
import type { FirstPartyHarvestEvent } from "./types";

const USER_AGENT = "TenderFans Event Harvester/1.0";
const RECOVERY_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";
const MAX_PAGES = 50;

function decode(value: string): string {
  return value.replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&(?:amp|quot|apos|lt|gt|nbsp);/gi, (entity) => ({
      "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " ",
    }[entity.toLowerCase()] ?? entity));
}

function plain(value: string): string {
  return decode(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function field(html: string, className: string): string | null {
  const match = html.match(new RegExp(`<span\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/span>`, "i"));
  return match ? plain(match[1]) : null;
}

function sameOrigin(candidate: string, base: string): boolean {
  return new URL(candidate).origin === new URL(base).origin;
}

async function fetchHtml(url: string): Promise<string> {
  const proxy = process.env.TENDERFANS_TRANSPORT_RECOVERY_ENABLED === "true"
    ? process.env.TENDERFANS_TRANSPORT_PROXY_URL : undefined;
  async function request(proxyUrl?: string): Promise<Response> {
    return signedHarvesterFetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "User-Agent": proxyUrl ? RECOVERY_USER_AGENT : USER_AGENT,
        ...(proxyUrl ? { "Accept-Language": "en-US,en;q=0.9" } : {}),
      }, cache: "no-store",
    }, proxyUrl);
  }
  let response: Response;
  try {
    response = await request();
    if (proxy && [403, 429, 503].includes(response.status)) {
      try {
        const recovered = await request(proxy);
        if (recovered.ok) response = recovered;
      } catch { /* Preserve original failure. */ }
    }
  } catch (error) {
    if (!proxy) throw error;
    response = await request(proxy);
  }
  if (!response.ok) throw new Error(`Eventer archive returned HTTP ${response.status}: ${url}`);
  return response.text();
}

type DateParts = { year: number; month: number; day: number };
type TimeParts = { hour: number; minute: number };

function localParts(date: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, Number(p.value)]));
}

function zonedUtc(date: DateParts, time: TimeParts, timeZone: string): Date {
  const target = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  let guess = new Date(target);
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess, timeZone);
    const actual = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const difference = target - actual;
    if (!difference) break;
    guess = new Date(guess.getTime() + difference);
  }
  return guess;
}

function parseTime(value: string): TimeParts | null {
  const match = value.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!match) return null;
  const hour = Number(match[1]);
  if (hour < 1 || hour > 12) return null;
  return { hour: (hour % 12) + (match[3].toLowerCase() === "pm" ? 12 : 0), minute: Number(match[2] ?? 0) };
}

function dateFromUrl(url: string): DateParts | null {
  const match = new URL(url).pathname.match(/\/edate\/(\d{4})-(\d{2})-(\d{2})(?:\/|$)/i);
  if (!match) return null;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const check = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return check.getUTCFullYear() === date.year && check.getUTCMonth() + 1 === date.month && check.getUTCDate() === date.day ? date : null;
}

function cards(html: string, pageUrl: string, timeZone: string): FirstPartyHarvestEvent[] {
  const events: FirstPartyHarvestEvent[] = [];
  const items = html.match(/<li\b[^>]*class=["'][^"']*\beventer-event-item\b[^"']*["'][^>]*>[\s\S]*?<\/li>/gi) ?? [];
  for (const item of items) {
    const href = item.match(/<a\b[^>]*href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    let eventUrl: string;
    try {
      eventUrl = new URL(decode(href), pageUrl).toString();
      if (!sameOrigin(eventUrl, pageUrl)) continue;
    } catch { continue; }
    const date = dateFromUrl(eventUrl);
    const title = field(item, "eventer-event-title");
    const timeLabel = field(item, "eventer-event-time");
    if (!date || !title || !timeLabel) continue;
    const times = timeLabel.split(/\s+to\s+/i);
    const start = parseTime(times[0]);
    if (!start) continue;
    const startsAt = zonedUtc(date, start, timeZone);
    const end = times[1] ? parseTime(times[1]) : null;
    let endsAt: Date | null = null;
    if (end) {
      const nextDay = end.hour * 60 + end.minute < start.hour * 60 + start.minute;
      const endDate = nextDay ? new Date(Date.UTC(date.year, date.month - 1, date.day + 1)) : null;
      endsAt = zonedUtc(endDate ? { year: endDate.getUTCFullYear(), month: endDate.getUTCMonth() + 1, day: endDate.getUTCDate() } : date, end, timeZone);
    }
    const location = field(item, "eventer-event-venue");
    const imageMatch = item.match(/background-image\s*:\s*url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/i)
      ?? item.match(/<img\b[^>]*src=["']([^"']+)["']/i);
    let flyerUrl: string | null = null;
    if (imageMatch) {
      try { flyerUrl = new URL(decode(imageMatch[1]), pageUrl).toString(); } catch { /* Optional. */ }
    }
    events.push({
      externalEventId: `eventer:${new URL(eventUrl).pathname.replace(/\/$/, "")}`,
      sourceUrl: eventUrl, title, description: null,
      startsAt: startsAt.toISOString(), endsAt: endsAt?.toISOString() ?? null,
      allDay: false, flyerUrl, location, venueName: null, venueAddress: null,
      rawPayload: { platform: "eventer_events", eventUrl, timeZone, locationText: location },
    });
  }
  return events;
}

function paginationLinks(html: string, pageUrl: string): string[] {
  const nav = html.match(/<ul\b[^>]*class=["'][^"']*\beventer-pagination\b[^"']*["'][^>]*>[\s\S]*?<\/ul>/i)?.[0];
  if (!nav) return [];
  const links: string[] = [];
  for (const match of nav.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
    try {
      const url = new URL(decode(match[1]), pageUrl);
      if (sameOrigin(url.toString(), pageUrl) && /\/pagin\/\d+\/?$/i.test(url.pathname)) links.push(url.toString());
    } catch { /* Ignore malformed link. */ }
  }
  return links;
}

export async function fetchEventerEvents(
  sourceUrl: string, options: { timeZone?: string } = {},
): Promise<FirstPartyHarvestEvent[]> {
  const timeZone = options.timeZone ?? "America/New_York";
  const queue = [sourceUrl];
  const visited = new Set<string>();
  const events = new Map<string, FirstPartyHarvestEvent>();
  while (queue.length) {
    if (visited.size >= MAX_PAGES) throw new Error(`Eventer pagination exceeded ${MAX_PAGES} pages`);
    const pageUrl = queue.shift()!;
    if (visited.has(pageUrl)) continue;
    if (!sameOrigin(pageUrl, sourceUrl)) throw new Error("Eventer pagination crossed origins");
    visited.add(pageUrl);
    const html = await fetchHtml(pageUrl);
    const isEventer = /\beventer-event-(?:item|grid|date|title)\b/i.test(html) || /\beventer-pagination\b/i.test(html) || /\beventer-event-single\b/i.test(html);
    if (!isEventer) throw new Error(`Eventer markup not found: ${pageUrl}`);
    for (const event of cards(html, pageUrl, timeZone)) events.set(event.externalEventId, event);
    for (const link of paginationLinks(html, pageUrl)) if (!visited.has(link) && !queue.includes(link)) queue.push(link);
  }
  return [...events.values()].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}
