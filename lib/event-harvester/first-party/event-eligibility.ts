import type { FirstPartyHarvestEvent } from "./types";

export type EventEligibility = {
  eligible: boolean;
  reason: string;
};

type EventLike = Pick<
  FirstPartyHarvestEvent,
  "title" | "description" | "location" | "rawPayload"
>;

const hostedEvidence =
  /\b(?:watch\s*part(?:y|ies)|viewing\s*part(?:y|ies)|game[\s-]*day\s*(?:part(?:y|ies)|specials?|deals?|promotions?)|tailgat(?:e|ing)\s*(?:part(?:y|ies)|event)|(?:in[\s-]*house|on[\s-]*site|at\s+(?:our|the)\s+(?:bar|venue|location))\s+(?:tournament|competition|league)|(?:tournament|competition)\s+(?:at\s+our\s+(?:bar|venue|location)|hosted\s+here))\b/i;

const broadcastEvidence =
  /\b(?:televised|broadcast|live\s+coverage|tv\s+schedule|sports?\s+schedule|on\s+(?:our\s+)?(?:tv|tvs|screens?))\b/i;

const sportsLeague =
  /\b(?:NFL|MLB|NBA|NHL|NCAA|MLS|WNBA|PGA|UFC|F1|Formula\s+1|Premier\s+League|Champions\s+League)\b/i;

const fixtureEvidence =
  /(?:\s@\s|\s+vs\.?\s+|\s+versus\s+|\b(?:game\s+\d+|preseason|playoffs?|qualifying|grand\s+prix)\b)/i;

const sportsTitle =
  /^(?:NFL|MLB|NBA|NHL|NCAA|MLS|WNBA|PGA|UFC|F1|Formula\s+1|Golf|Soccer|Football|Basketball|Baseball|Hockey|Tennis)\s*[-:]/i;

export function classifyEventEligibility(
  event: EventLike,
): EventEligibility {
  const title = event.title ?? "";
  const description = event.description ?? "";
  const text = `${title}\n${description}`;

  const raw = event.rawPayload ?? {};

  const category =
    typeof raw.category === "string"
      ? raw.category.toLowerCase().trim()
      : "";

  if (hostedEvidence.test(text)) {
    return {
      eligible: true,
      reason: "Explicit Spot-hosted activity or promotion",
    };
  }

  if (broadcastEvidence.test(text)) {
    return {
      eligible: false,
      reason: "Explicit television or broadcast listing",
    };
  }

  const structuredSports =
    category === "sports" || category === "sport";

  if (structuredSports) {
    return {
      eligible: false,
      reason: "Sports calendar listing without hosted-event evidence",
    };
  }

  if (
    sportsLeague.test(title) &&
    fixtureEvidence.test(title)
  ) {
    return {
      eligible: false,
      reason: "Professional sports fixture listing",
    };
  }

  return {
    eligible: true,
    reason: "No conclusive broadcast evidence",
  };
}
