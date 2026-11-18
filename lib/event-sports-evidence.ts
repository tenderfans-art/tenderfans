import { normalizeEventSearch } from "./event-search";

const SPORTS = [
  "sport", "sports", "football", "baseball", "softball", "basketball", "netball", "hockey", "soccer", "futsal",
  "rugby", "cricket", "volleyball", "tennis", "badminton", "pickleball", "padel", "golf", "bowling", "billiards",
  "darts", "cornhole", "bocce", "lacrosse", "handball", "curling", "water polo", "hurling", "squash tournament", "squash match",
  "boxing", "kickboxing", "wrestling", "mma", "mixed martial arts", "martial arts", "jiu jitsu", "judo", "karate", "taekwondo",
  "swimming", "diving", "surfing", "sailing", "rowing", "cycling", "triathlon", "duathlon", "athletics", "track and field",
  "gymnastics", "skiing", "snowboarding", "esports", "e sports", "runfest", "fun run", "run club", "running club",
  "half marathon", "ultramarathon", "5k", "10k", "15k", "20k", "50k", "100k",
  "motorsport", "motorsports", "motor racing", "auto racing", "horse racing", "drag racing", "formula 1", "formula one",
  "f1", "nascar", "indycar", "motogp", "supercross", "nhra", "grand prix",
  "nfl", "ncaa", "ncaaf", "ncaab", "nba", "wnba", "mlb", "nhl", "ahl", "mls", "nwsl", "usl", "pga", "lpga", "atp", "wta",
  "ufc", "bellator", "wwe", "aew", "premier league", "champions league", "six nations", "super bowl", "superbowl",
  "world cup", "world series", "stanley cup", "march madness", "final four", "pool tournament", "pool league",
];
const ATHLETIC_CONTEXT = [
  "marathon", "fight night", "race day", "raceday", "match day", "matchday", "game day", "gameday",
  "tailgate", "tailgating", "playoff", "playoffs", "kickoff", "kick off", "puck drop", "tipoff", "tip off",
];
const NON_SPORTS = /\b(?:music|concert|bands?|tribute|dj|karaoke|comedy|comedian|bingo|trivia|quiz|screening|movie|film|cinema|debate|election|seminar|workshop|lesson)\b/;
const TASTING = /\b(?:beer|wine|whiskey|bourbon|cocktails?|tasting|cookoff|cook off)\b/;
const SPORTS_EMOJI = /[🏈🏀⚽🏉🏐🏏🎾🏒🏑🥍🥊🥋🏎⛳]/u;

function sportsText(value: string) {
  // Venue branding describes the building, not the event taking place there.
  return normalizeEventSearch(value)
    .replace(/\bsports?\s+(?:bars?|clubs?|grills?|grilles?|pubs?|lounges?|taverns?|cafes?)\b/g, " ")
    .replace(/\b(?:tvs?|screens?)\s+for\s+sports?\s+viewing\b/g, " ");
}
function contains(text: string, phrases: readonly string[]) {
  return phrases.some(phrase => ` ${text} `.includes(` ${phrase} `));
}

/** Athletic evidence only; no team roster, venue or adapter-specific defaults. */
export function hasSportsEvidence(title: string, description = "", allowMatchup = true): boolean {
  const heading = sportsText(title);
  const detail = sportsText(description);
  if (contains(heading, SPORTS) || contains(detail, SPORTS) || SPORTS_EMOJI.test(title)) return true;
  const otherActivity = NON_SPORTS.test(`${heading} ${detail}`);
  if (!otherActivity && (contains(heading, ATHLETIC_CONTEXT) || contains(detail, ATHLETIC_CONTEXT))) return true;
  // A timed first bout is combat-sport evidence; "fight" alone is ambiguous.
  if (!otherActivity && /\b(?:first (?:fight|bout)|bell time)\s+\d{1,2}(?:\s+\d{2})?\s*(?:am|pm)\b/.test(detail)) return true;
  // Publisher titles often contain only the opponents. Avoid applying this
  // fallback to musical battles, tastings, screenings, debates or trivia.
  return allowMatchup && !otherActivity && !TASTING.test(heading) &&
    /[\p{L}\p{N}]+\s+(?:v|vs|versus)\s+[\p{L}\p{N}]+/u.test(heading);
}
