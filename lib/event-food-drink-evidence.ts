import { normalizeEventSearch } from "./event-search";

const FOOD = [
  "food", "meal", "meals", "dining", "breakfast", "brunch", "lunch", "dinner", "supper", "buffet", "cookout", "potluck",
  "oyster", "oysters", "wing", "wings", "wingy", "taco", "tacos", "burger", "burgers", "pizza", "barbecue", "bbq",
  "crab", "crabs", "seafood", "shrimp", "prawn", "prawns", "lobster", "clam", "clams", "mussel", "mussels",
  "steak", "prime rib", "fish fry", "sushi", "raclette", "cheese", "charcuterie", "tapas", "chili", "dessert", "desserts",
  "pancake", "pancakes", "waffle", "waffles", "crawfish", "crawfish boil", "low country boil", "food truck", "food trucks",
];
const DRINK = [
  "drink", "drinks", "beverage", "beverages", "cocktail", "cocktails", "mocktail", "mocktails", "beer", "beers", "wine", "wines",
  "cider", "ciders", "ale", "ales", "lager", "lagers", "seltzer", "seltzers", "happy hour", "happy hours", "booze",
  "margarita", "margaritas", "martini", "martinis", "mimosa", "mimosas", "mojito", "mojitos", "daiquiri", "daiquiris",
  "sangria", "vodka", "whiskey", "whisky", "bourbon", "scotch", "tequila", "rum", "gin", "mezcal", "champagne", "prosecco",
  "bloody mary", "bloody marys", "pint", "pints", "crowler", "crowlers", "growler", "growlers", "mixology",
];
const MEALS = ["breakfast", "brunch", "lunch", "dinner", "supper", "buffet", "cookout", "potluck", "fish fry", "food truck", "food trucks", "tasting menu", "chef s table"];
const DRINK_PROGRAM = ["happy hour", "happy hours", "open bar", "tap takeover", "paint and sip", "sip and paint", "mixology"];
const PROMOTION = /\b(?:specials?|tasting|pairing|bottomless|unlimited|release|takeover|pop up|cook off|half off|all you can (?:eat|drink)|two for one|2 for 1)\b|\d+\s*%\s*off/;
const DAY = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/;
const POLICY = /\b(?:no outside|not permitted|prohibited|not included|available for purchase)\b/;
const ADMISSION = /\b(?:tickets?|admission|cover|prizes?|gift cards?)\b/;

function contains(text: string, terms: readonly string[]) {
  const padded = ` ${text} `;
  return terms.some(term => padded.includes(` ${term} `));
}
function pricedOrFree(value: string, terms: readonly string[]) {
  const text = normalizeEventSearch(value.replace(/\$\s*\d+(?:\.\d{1,2})?/g, " menuprice "));
  const words = terms.join("|");
  const modifiers = "(?:(?:cold|hot|draft|craft|domestic|house|well|specialty|all)\\s+){0,2}";
  return new RegExp(`\\b(?:menuprice|free|complimentary)\\s+${modifiers}(?:${words})\\b|\\b(?:${words})\\s+menuprice\\b`).test(text);
}
function clean(value: string, venueName = "") {
  let text = normalizeEventSearch(value);
  const venue = normalizeEventSearch(venueName);
  if (venue.split(" ").length >= 2) text = ` ${text} `.split(` ${venue} `).join(" ").trim();
  return text.replace(/\b(?:beer garden|wine bar|cocktail (?:bar|lounge)|martini bar|seafood restaurant)\b/g, " ");
}

/** Publisher category labels are direct evidence, unlike a menu mentioned in prose. */
export function foodDrinkLabel(value: string) {
  const text = normalizeEventSearch(value);
  return { food: contains(text, FOOD), drinks: contains(text, DRINK) };
}

export function foodDrinkEvidence(title: string, description = "", options: {
  venueName?: string;
  isPerformance?: boolean;
  performerOnly?: boolean;
} = {}) {
  const heading = clean(title, options.venueName);
  const titleHasPromotion = PROMOTION.test(title.toLowerCase()) || pricedOrFree(title, [...FOOD, ...DRINK]);
  const useTitle = !options.performerOnly || titleHasPromotion;
  const weakTitle = !options.isPerformance || titleHasPromotion || DAY.test(heading);
  let food = useTitle && (contains(heading, MEALS) || (weakTitle && contains(heading, FOOD)));
  let drinks = useTitle && (contains(heading, DRINK_PROGRAM) || (weakTitle && contains(heading, DRINK)));
  for (const part of description.replace(/<\/?(?:p|div|li)\b[^>]*>|<br\s*\/?>/gi, "\n").split(/\r?\n|(?<=[.!?])\s+|;/)) {
    const text = clean(part, options.venueName);
    if (!text || POLICY.test(text)) continue;
    // Food/drink availability and ticket prices are not themselves a special.
    const promotion = PROMOTION.test(part.toLowerCase()) &&
      (!ADMISSION.test(text) || /\b(?:specials?|tasting|pairing|bottomless|takeover|all you can (?:eat|drink))\b/.test(text));
    if (contains(text, MEALS) || (promotion && contains(text, FOOD)) || pricedOrFree(part, FOOD)) food = true;
    if (contains(text, DRINK_PROGRAM) || (promotion && contains(text, DRINK)) || pricedOrFree(part, DRINK)) drinks = true;
  }
  return { food, drinks };
}
