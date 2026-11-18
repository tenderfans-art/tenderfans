export type EventSearchCategory = "music" | "entertainment" | "games" | "sports" | "food" | "drinks" | "comedy" | "dance";
export type EventSearchMetadata = {
  categories: EventSearchCategory[];
  terms: string[];
  performers: string[];
};
export type SearchableEvent = {
  title: string;
  description?: string | null;
  venue_name?: string;
  venue_city?: string;
  venue_state_region?: string;
  venue_postal_code?: string;
  search_metadata?: EventSearchMetadata;
};

export function normalizeEventSearch(value: string): string {
  return value.replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:amp|nbsp|quot|apos|#39|#x27);/gi, " ")
    .normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\bsaint\b/g, "st")
    .replace(/\s+/g, " ").trim();
}

const QUERY_CATEGORIES: Record<string, EventSearchCategory> = {
  music: "music", "live music": "music", entertainment: "entertainment",
  game: "games", games: "games", sport: "sports", sports: "sports",
  food: "food", drink: "drinks", drinks: "drinks", comedy: "comedy", dance: "dance", dancing: "dance",
};

const NON_MUSIC = ["games", "sports", "food", "drinks", "comedy"] as const;

export function matchesEventCategory(categories: readonly EventSearchCategory[], category: EventSearchCategory): boolean {
  if (categories.includes(category)) return true;
  // Requested broad music discovery includes otherwise unclassified entertainment.
  // An explicitly identified meal/game/sport/comedy event needs its own music evidence.
  return category === "music" && categories.includes("entertainment") &&
    !NON_MUSIC.some(value => categories.includes(value));
}

export type PerformerCatalog = ReadonlyMap<string, readonly EventSearchCategory[]>;

/** Corroborate exact performer names across the loaded calendar, never guess a name. */
export function buildPerformerCatalog(events: readonly SearchableEvent[]): PerformerCatalog {
  const catalog = new Map<string, Set<EventSearchCategory>>();
  for (const event of events) {
    const metadata = event.search_metadata;
    if (!metadata || !matchesEventCategory(metadata.categories, "music")) continue;
    const title = event.title.replace(/^(?:live\s+music|live\s+entertainment|music|concert|performance)\s*[:|–—-]\s*/i, "");
    const names = [...metadata.performers];
    if (!NON_MUSIC.some(category => metadata.categories.includes(category))) names.push(title);
    for (const name of names) {
      const key = normalizeEventSearch(name);
      if (key.length < 3 || /^(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)(?: night)?$/.test(key) ||
          /^(?:live music|music|entertainment|live entertainment|tba|tbd|closed|open mic|jam night)$/.test(key)) continue;
      const categories = catalog.get(key) ?? new Set<EventSearchCategory>();
      categories.add(metadata.categories.includes("music") ? "music" : "entertainment");
      catalog.set(key, categories);
    }
  }
  return new Map([...catalog].map(([name, categories]) => [name, [...categories]]));
}

export function matchesEventSearch(event: SearchableEvent, query: string, performers: PerformerCatalog = new Map()): boolean {
  const search = normalizeEventSearch(query);
  if (!search) return true;
  const metadata = event.search_metadata;
  const categories = [...(metadata?.categories ?? [])];
  if (!NON_MUSIC.some(category => categories.includes(category))) {
    for (const category of performers.get(normalizeEventSearch(event.title)) ?? []) {
      if (!categories.includes(category)) categories.push(category);
    }
  }
  const text = normalizeEventSearch([
    event.title, event.description ?? "", event.venue_name ?? "", event.venue_city ?? "",
    event.venue_state_region ?? "", event.venue_postal_code ?? "", ...(metadata?.terms ?? []),
  ].join(" "));
  // Preserve direct title/Spot/location/ZIP searches, then support combinations
  // such as "music St Pete", "jazz 33701" or "trivia brewery".
  if (text.includes(search)) return true;
  const category = QUERY_CATEGORIES[search];
  if (category) return matchesEventCategory(categories, category);
  const tokens = search.replace(/\blive music\b/g, "music").split(" ");
  return tokens.every(token => {
    const concept = QUERY_CATEGORIES[token];
    return text.includes(token) || (concept !== undefined && matchesEventCategory(categories, concept));
  });
}
