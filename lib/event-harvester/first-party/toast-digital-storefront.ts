import { recoveryFetch } from "@/lib/event-harvester/recovery-fetch";
import type { FirstPartyHarvestEvent } from "./types";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Obj : {};
const str = (v: unknown): string => typeof v === "string" ? v.trim() : "";
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Parse the JSON assignment without executing the site's JavaScript. */
function apolloState(html: string): Obj | null {
  const marker = /window\.__APOLLO_STATE__\s*=\s*/.exec(html);
  if (!marker) return null;
  const start = html.indexOf("{", marker.index + marker[0].length);
  if (start < 0) return null;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try { return obj(JSON.parse(html.slice(start, i + 1))); }
      catch { return null; }
    }
  }
  return null;
}

function richText(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const nodes = JSON.parse(value) as unknown;
    const parts: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) { v.forEach(walk); return; }
      const r = obj(v);
      if (typeof r.text === "string") parts.push(r.text);
      if (r.children) walk(r.children);
    };
    walk(nodes);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  } catch { return ""; }
}

type ToastCard = { title: string; body: string; button: string; id: string };
function eventCards(html: string): ToastCard[] | null {
  if (!/toast-sites|Toast Admin|toasttab/i.test(html)) return null;
  const state = apolloState(html);
  if (!state) return null;
  const cards: ToastCard[] = [];
  let eventPageFound = false;
  const visited = new Set<object>();
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object" || visited.has(v)) return;
    visited.add(v);
    if (Array.isArray(v)) { v.forEach(walk); return; }
    const r = obj(v);
    if (Array.isArray(r.additionalPages)) {
      for (const pageValue of r.additionalPages) {
        const page = obj(pageValue);
        const route = str(page.route);
        if (!/^\/events?(?:\/|$)/i.test(route)) continue;
        eventPageFound = true;
        const content = obj(page.content);
        const collect = (value: unknown) => {
          if (!value || typeof value !== "object") return;
          if (Array.isArray(value)) { value.forEach(collect); return; }
          const node = obj(value);
          if (node.__typename === "CardType") {
            const title = richText(node.header) || str(node.title);
            const body = richText(node.body);
            const button = str(obj(node.button).text);
            if (title && body) cards.push({
              title, body, button,
              id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
            });
          } else {
            for (const child of Object.values(node)) collect(child);
          }
        };
        collect(content.sections);
      }
    }
    for (const child of Object.values(r)) {
      if (child && typeof child === "object") walk(child);
    }
  };
  walk(state);
  return eventPageFound ? cards : null;
}

function localParts(date: Date, zone: string): Record<string, number> {
  const result: Record<string, number> = {};
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  for (const p of fmt.formatToParts(date)) {
    if (["year", "month", "day", "hour", "minute", "second"].includes(p.type))
      result[p.type] = Number(p.value);
  }
  return result;
}
function toUtc(y: number, m: number, d: number, h: number, min: number, zone: string): Date {
  const target = Date.UTC(y, m - 1, d, h, min);
  let guess = new Date(target);
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess, zone);
    const actual = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess = new Date(guess.getTime() + target - actual);
  }
  return guess;
}
function weeklySchedule(body: string): { day: number; hour: number; minute: number } | null {
  const match = /\b(?:every|each)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+(?:night|evening|morning|afternoon))?\s+(?:at|@)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(body);
  if (!match) return null;
  const day = DAYS.indexOf(match[1].toLowerCase());
  const raw = Number(match[2]), minute = Number(match[3] ?? 0);
  if (day < 0 || raw < 1 || raw > 12 || minute > 59) return null;
  const context = match[0].toLowerCase();
  const meridiem = match[4]?.toLowerCase() ??
    (/\b(?:night|evening)\b/.test(context) ? "pm" :
     /\bmorning\b/.test(context) ? "am" : null);
  if (!meridiem) return null;
  return { day, hour: raw % 12 + (meridiem === "pm" ? 12 : 0), minute };
}

export function inspectToastDigitalStorefront(html: string): boolean {
  const cards = eventCards(html);
  return cards !== null && cards.some(c =>
    !/sold\s*out|cancelled|canceled/i.test(c.button + " " + c.body) &&
    weeklySchedule(c.body) !== null
  );
}

export async function fetchToastDigitalStorefrontEvents(
  sourceUrl: string,
  options: { timeZone?: string; weeksForward?: number; fetcher?: typeof recoveryFetch } = {},
): Promise<FirstPartyHarvestEvent[]> {
  const response = await (options.fetcher ?? recoveryFetch)(sourceUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`Toast storefront HTTP ${response.status}`);
  const cards = eventCards(await response.text());
  if (!cards) throw new Error("Toast event page application state unavailable");
  const zone = options.timeZone || "America/New_York";
  const weeks = Math.min(12, Math.max(1, options.weeksForward ?? 8));
  const now = new Date();
  const today = localParts(now, zone);
  const todayUtc = new Date(Date.UTC(today.year, today.month - 1, today.day, 12));
  const results: FirstPartyHarvestEvent[] = [];
  for (const card of cards) {
    if (/sold\s*out|cancelled|canceled/i.test(card.button + " " + card.body)) continue;
    const schedule = weeklySchedule(card.body);
    if (!schedule) continue;
    for (let offset = 0; offset < weeks * 7; offset++) {
      const day = new Date(todayUtc.getTime() + offset * 86400000);
      if (day.getUTCDay() !== schedule.day) continue;
      const starts = toUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), schedule.hour, schedule.minute, zone);
      if (starts <= now) continue;
      const dateKey = day.toISOString().slice(0, 10);
      results.push({
        externalEventId: `toast-digital-storefront:${card.id}:${dateKey}`,
        title: card.title, description: card.body, startsAt: starts.toISOString(),
        endsAt: null, allDay: false, sourceUrl, flyerUrl: null, location: null,
        venueName: null, venueAddress: null,
        rawPayload: { platform: "toast_digital_storefront", recurrence: "weekly",
          timezone: zone, dateEvidence: "toast_card_explicit_weekly_schedule",
          allowSourceDefaultAttribution: true },
      });
    }
  }
  return results.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}
