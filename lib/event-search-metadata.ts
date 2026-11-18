import { normalizeEventSearch, type EventSearchCategory, type EventSearchMetadata } from "./event-search";
import { hasSportsEvidence } from "./event-sports-evidence";

export const CALENDAR_EVENT_SELECT = `
  id, venue_id, title, description, starts_at, ends_at, is_all_day, flyer_url,
  venues(name, slug, city, state_region, postal_code, latitude, longitude),
  event_source_links(candidate:event_harvest_candidates(
    status, categories:raw_payload->categories, category:raw_payload->category,
    tags:raw_payload->tags, genre:raw_payload->genre, performer:raw_payload->performer,
    structured_type:raw_payload->@type, classifications:raw_payload->classifications,
    sport:raw_payload->sport, home_team:raw_payload->homeTeam,
    away_team:raw_payload->awayTeam, competitors:raw_payload->competitor,
    calendar_context:raw_payload->>qualificationReason,
    image_event_context:raw_payload->observation->evidence->context,
    calendar_name:raw_payload->>calendarName, calendar_description:raw_payload->>calendarDescription,
    event_categories:raw_payload->sourceRecord->categories,
    event_performer:raw_payload->sourceRecord->performer
  ))`;

const CUES: Record<Exclude<EventSearchCategory, "sports">, string[]> = {
  music: ["music", "musical", "concert", "concerts", "band", "bands", "musician", "musicians", "singer", "songwriter", "acoustic", "dj", "djs", "karaoke", "open jam", "jam session", "jazz", "reggae", "bluegrass", "hip hop", "r b", "rnb", "edm"],
  entertainment: ["entertainment", "performance", "performances", "performer", "performers", "duo", "trio", "quartet", "quintet"],
  games: ["game", "games", "trivia", "bingo", "poker", "board game", "arcade"],
  food: ["food", "breakfast", "brunch", "lunch", "dinner", "buffet", "cookout", "oyster", "oysters", "wings", "taco", "tacos", "burger", "burgers", "barbecue", "bbq"],
  drinks: ["drink", "drinks", "cocktail", "cocktails", "beer", "wine", "happy hour", "margarita", "margaritas", "martini", "martinis", "vodka", "whiskey", "tequila"],
  comedy: ["comedy", "comedian", "comedians", "stand up", "standup"],
  dance: ["dance", "dancing", "dj", "djs"],
};
const MUSIC_GENRES = new Set([
  "jazz", "blues", "rock", "classic rock", "country", "reggae", "reggaeton", "soul", "r b", "r and b", "rnb",
  "hip hop", "rap", "pop", "folk", "bluegrass", "punk", "metal", "latin", "indie", "electronic", "edm",
  "house", "techno", "alternative", "funk", "disco", "gospel", "classical", "singer songwriter", "acoustic", "dj",
]);
const TYPES: Record<string, EventSearchCategory> = {
  musicevent: "music", musicgroup: "music", musiccomposition: "music", musicrecording: "music",
  sportsevent: "sports", sportsteam: "sports", athlete: "sports", comedyevent: "comedy", foodevent: "food", danceevent: "dance",
  theaterevent: "entertainment", festival: "entertainment", performinggroup: "entertainment",
};

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value.slice(0, 100) : value == null ? [] : [value]; }
function labels(value: unknown): string[] {
  return list(value).flatMap(item => {
    if (typeof item === "string") return item.trim() ? [item.trim().slice(0, 1000)] : [];
    const row = object(item);
    return [row.name, row.label, row.slug].filter((text): text is string => typeof text === "string" && Boolean(text.trim())).map(text => text.trim().slice(0, 1000));
  });
}
function addCues(value: string, categories: Set<EventSearchCategory>) {
  if (hasSportsEvidence(value, "", false)) categories.add("sports");
  const text = ` ${normalizeEventSearch(value)} `;
  for (const [category, terms] of Object.entries(CUES)) {
    if (terms.some(term => text.includes(` ${term} `)) &&
        !(category === "music" && /\b(?:no|not|without) (?:live )?music\b/.test(text))) {
      categories.add(category as EventSearchCategory);
    }
  }
}

/** Derive public search hints from retained event evidence, not venue or adapter identity. */
export function eventSearchMetadata(event: { title: string; description?: string | null; event_source_links?: unknown }): EventSearchMetadata {
  const categories = new Set<EventSearchCategory>();
  const terms = new Set<string>();
  const performers = new Set<string>();
  const contexts: string[] = [];
  addCues(`${event.title} ${event.description ?? ""}`, categories);
  const genre = (value: unknown) => {
    for (const name of labels(value)) {
      const normalized = normalizeEventSearch(name);
      if (MUSIC_GENRES.has(normalized)) categories.add("music");
      addCues(name, categories);
      terms.add(name);
    }
  };
  const types = (value: unknown) => {
    for (const name of list(value)) {
      if (typeof name !== "string") continue;
      const type = name.split(/[\/#]/).at(-1)?.toLowerCase() ?? "";
      if (TYPES[type]) categories.add(TYPES[type]);
    }
  };
  for (const link of list(event.event_source_links)) {
    for (const entry of list(object(link).candidate)) {
      const row = object(entry);
      if (["ignored", "suppressed", "stale", "cancelled"].includes(String(row.status))) continue;
      types(row.structured_type);
      for (const name of labels(row.sport)) { categories.add("sports"); terms.add(name); }
      const home = labels(row.home_team), away = labels(row.away_team);
      for (const team of [row.home_team, row.away_team]) types(object(team)["@type"]);
      if (home.length && away.length) categories.add("sports");
      for (const name of [...home, ...away]) terms.add(name);
      for (const competitor of list(row.competitors)) {
        types(object(competitor)["@type"]);
        for (const name of labels(competitor)) terms.add(name);
      }
      for (const value of [row.categories, row.category, row.tags, row.event_categories]) {
        for (const label of labels(value)) genre(label);
      }
      genre(row.genre);
      for (const classification of list(row.classifications)) {
        const fields = object(classification);
        for (const name of labels(fields.segment)) { addCues(name, categories); terms.add(name); }
        for (const value of [fields.genre, fields.subGenre]) genre(value);
      }
      for (const value of [row.performer, row.event_performer]) {
        for (const person of list(value)) {
          const performer = object(person);
          types(performer["@type"]);
          genre(performer.genre);
          const performerTypes = list(performer["@type"]).map(value => String(value).split(/[\/#]/).at(-1)?.toLowerCase());
          if (typeof performer.name === "string" && performer.name.trim() && !performerTypes.includes("organization")) {
            const name = performer.name.trim().slice(0, 200);
            terms.add(name);
            if (!performerTypes.some(type => type === "sportsteam" || type === "athlete")) {
              performers.add(name); categories.add("entertainment");
            }
          }
        }
      }
      // Image evidence can repeat the page heading, so treat it as collection
      // context rather than letting it override a specific meal/game label.
      contexts.push(...labels(row.image_event_context));
      for (const context of [row.calendar_context, row.calendar_name, row.calendar_description]) {
        if (typeof context === "string") contexts.push(context.slice(0, 2000));
      }
    }
  }
  if (hasSportsEvidence(event.title, event.description ?? "",
    !categories.has("music") && !categories.has("comedy"))) categories.add("sports");
  // A round/final can inherit an explicit sports-calendar heading. An ordinary
  // performance or special on that same calendar cannot use this fallback.
  if (!categories.size && /\b(?:round|finals?|semifinals?|quarterfinals?|qualifying|fixture)\b/.test(normalizeEventSearch(event.title)) &&
    contexts.some(context => hasSportsEvidence(context, "", false))) categories.add("sports");
  // Collection-level context helps name-only performances, but must not turn
  // an explicitly identified meal, special, game or sport into a music event.
  if (!["games", "sports", "food", "drinks", "comedy"].some(category => categories.has(category as EventSearchCategory))) {
    const collection = new Set<EventSearchCategory>();
    for (const context of contexts) addCues(context, collection);
    for (const category of ["music", "entertainment"] as const) {
      if (collection.has(category)) categories.add(category);
    }
  }
  if (categories.has("music") || categories.has("dance") || categories.has("comedy")) categories.add("entertainment");
  return { categories: [...categories].sort(), terms: [...terms].slice(0, 100), performers: [...performers].slice(0, 30) };
}

export function publicCalendarEvent(row: Record<string, unknown>) {
  const { event_source_links: _privateLinks, ...publicFields } = row;
  return { ...publicFields, search_metadata: eventSearchMetadata(row as { title: string; description?: string | null; event_source_links?: unknown }) };
}
