export type VenueIdentity = {
  name: string;
  streetAddress: string | null;
  city: string | null;
  stateRegion: string | null;
  alternateStateRegion?: string | null;
  postalCode: string | null;
};

export function normalizeVenueMatchText(
  value: string | null | undefined
) {
  return (value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((token) => {
      const aliases: Record<string, string> = {
        street: "st",
        avenue: "ave",
        boulevard: "blvd",
        road: "rd",
        drive: "dr",
        lane: "ln",
        court: "ct",
        circle: "cir",
        highway: "hwy",
        parkway: "pkwy",
        place: "pl",
        terrace: "ter",
        trail: "trl",
        north: "n",
        south: "s",
        east: "e",
        west: "w",
        northeast: "ne",
        northwest: "nw",
        southeast: "se",
        southwest: "sw",
      };

      return aliases[token] ?? token;
    })
    .join(" ");
}

export function normalizeVenuePostalCode(
  value: string | null | undefined
) {
  return (value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

export function venueTokenSimilarity(
  left: string | null | undefined,
  right: string | null | undefined
) {
  const a = new Set(
    normalizeVenueMatchText(left)
      .split(" ")
      .filter(Boolean)
  );

  const b = new Set(
    normalizeVenueMatchText(right)
      .split(" ")
      .filter(Boolean)
  );

  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  let intersection = 0;

  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }

  const union = new Set([...a, ...b]).size;

  return union === 0 ? 0 : intersection / union;
}

export function venueIdentityMatch(input: {
  spot: VenueIdentity;
  candidate: VenueIdentity;
}) {
  const { spot, candidate } = input;

  const nameExact =
    normalizeVenueMatchText(spot.name) !== "" &&
    normalizeVenueMatchText(spot.name) ===
      normalizeVenueMatchText(candidate.name);

  const nameSimilarity = venueTokenSimilarity(
    spot.name,
    candidate.name
  );

  const addressExact =
    normalizeVenueMatchText(spot.streetAddress) !== "" &&
    normalizeVenueMatchText(spot.streetAddress) ===
      normalizeVenueMatchText(candidate.streetAddress);

  const cityExact =
    normalizeVenueMatchText(spot.city) !== "" &&
    normalizeVenueMatchText(spot.city) ===
      normalizeVenueMatchText(candidate.city);

  const normalizedSpotState =
    normalizeVenueMatchText(spot.stateRegion);

  const stateExact =
    normalizedSpotState !== "" &&
    (
      normalizedSpotState ===
        normalizeVenueMatchText(
          candidate.stateRegion
        ) ||
      normalizedSpotState ===
        normalizeVenueMatchText(
          candidate.alternateStateRegion
        )
    );

  const postalExact =
    normalizeVenuePostalCode(spot.postalCode) !== "" &&
    normalizeVenuePostalCode(spot.postalCode) ===
      normalizeVenuePostalCode(candidate.postalCode);

  let score = 0;

  score += nameExact
    ? 0.55
    : Math.min(nameSimilarity, 1) * 0.45;

  if (addressExact) score += 0.20;
  if (postalExact) score += 0.10;
  if (cityExact) score += 0.10;
  if (stateExact) score += 0.05;

  score = Math.min(1, Number(score.toFixed(4)));

  const autoAttach =
    score >= 0.9 &&
    (addressExact || postalExact) &&
    cityExact &&
    stateExact;

  const needsReview =
    !autoAttach &&
    score >= 0.65 &&
    nameSimilarity >= 0.5 &&
    cityExact &&
    stateExact;

  return {
    score,
    autoAttach,
    needsReview,
    evidence: {
      nameExact,
      nameSimilarity: Number(nameSimilarity.toFixed(4)),
      addressExact,
      cityExact,
      stateExact,
      postalExact,
    },
  };
}
