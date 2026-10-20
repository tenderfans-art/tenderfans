import type { SupabaseClient } from "@supabase/supabase-js";

import {
  normalizeVenueMatchText,
  venueIdentityMatch,
  type VenueIdentity,
} from "./venue-identity";

type GooglePlace = VenueIdentity & {
  id: string;
  latitude: number | null;
  longitude: number | null;
  publicPhone: string;
  websiteUrl: string;
  regularHours: string[];
  formattedAddress: string;
  types: string[];
};

function googleKey() {
  const key = process.env.GOOGLE_PLACES_API_KEY;

  if (!key) {
    throw new Error(
      "GOOGLE_PLACES_API_KEY is not configured."
    );
  }

  return key;
}

function parsePlace(place: any): GooglePlace | null {
  if (
    typeof place?.id !== "string" ||
    typeof place?.displayName?.text !== "string"
  ) {
    return null;
  }

  const components = Array.isArray(place.addressComponents)
    ? place.addressComponents
    : [];

  const component = (type: string) =>
    components.find((item: any) =>
      item.types?.includes(type)
    );

  const streetNumber =
    component("street_number")?.longText ?? "";

  const route =
    component("route")?.longText ?? "";

  return {
    id: place.id,
    name: place.displayName.text,
    streetAddress: [streetNumber, route]
      .filter(Boolean)
      .join(" ") || null,
    city:
      component("locality")?.longText ?? null,
    stateRegion:
      component("administrative_area_level_1")
        ?.shortText ?? null,
    postalCode:
      component("postal_code")?.longText ?? null,
    latitude:
      typeof place.location?.latitude === "number"
        ? place.location.latitude
        : null,
    longitude:
      typeof place.location?.longitude === "number"
        ? place.location.longitude
        : null,
    publicPhone:
      place.nationalPhoneNumber ?? "",
    websiteUrl:
      place.websiteUri ?? "",
    regularHours:
      place.regularOpeningHours?.weekdayDescriptions ?? [],
    formattedAddress:
      place.formattedAddress ?? "",
    types: Array.isArray(place.types) ? place.types : [],
  };
}

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.types",
  "places.location",
  "places.addressComponents",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.regularOpeningHours.weekdayDescriptions",
].join(",");

function normalizeGoogleReviewName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .replace(/[\\u2018\\u2019\\u02BC]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\\s+/g, " ");
}

export async function searchGoogleVenue(
  evidence: VenueIdentity,
  options: { allowReviewCandidate?: boolean } = {},
): Promise<{
  place: GooglePlace;
  score: number;
  evidence: Record<string, unknown>;
} | null> {
  const textQuery = [
    evidence.name,
    evidence.streetAddress,
    evidence.city,
    evidence.stateRegion,
    evidence.postalCode,
  ]
    .filter(Boolean)
    .join(", ");

  if (!textQuery.trim()) {
    return null;
  }

  const response = await fetch(
    "https://places.googleapis.com/v1/places:searchText",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": googleKey(),
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery,
        pageSize: 5,
      }),
      cache: "no-store",
    }
  );

  if (!response.ok) {
    const detail = await response.text();

    throw new Error(
      `Google Places Text Search failed: ${response.status} ${detail.slice(0, 300)}`
    );
  }

  const payload = await response.json();

  const places: GooglePlace[] = (
    Array.isArray(payload?.places)
      ? payload.places
      : []
  )
    .map((place: unknown) => parsePlace(place))
    .filter(
      (place: GooglePlace | null): place is GooglePlace =>
        place !== null
    );

  /*
   * Address-first discovery:
   * Publisher location labels may describe a neighborhood, district,
   * festival site, or geographic area rather than a business.
   *
   * Search the address independently, preserving the existing
   * name-based search and qualification rules.
   */
  if (evidence.streetAddress && evidence.city && evidence.stateRegion) {
    const addressQuery = [
      evidence.streetAddress,
      evidence.city,
      evidence.stateRegion,
      evidence.postalCode,
    ].filter(Boolean).join(", ");

    const addressResponse = await fetch(
      "https://places.googleapis.com/v1/places:searchText",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": googleKey(),
          "X-Goog-FieldMask": FIELD_MASK,
        },
        body: JSON.stringify({
          textQuery: addressQuery,
          pageSize: 10,
        }),
        cache: "no-store",
      },
    );

    if (addressResponse.ok) {
      const addressPayload = await addressResponse.json();

      const existingIds = new Set(places.map((place) => place.id));

      for (const rawPlace of Array.isArray(addressPayload?.places)
        ? addressPayload.places
        : []) {
        const place = parsePlace(rawPlace);
        if (place && !existingIds.has(place.id)) {
          places.push(place);
          existingIds.add(place.id);
        }
      }
    }
  }

  /*
   * Discover businesses near a verified street address.
   * Nearby results supplement, rather than replace, Text Search.
   */
  if (evidence.streetAddress && evidence.city && evidence.stateRegion) {
    const addressPlace = places.find((place) =>
      normalizeVenueMatchText(place.name) ===
        normalizeVenueMatchText(evidence.streetAddress) &&
      place.latitude !== null &&
      place.longitude !== null
    );

    if (addressPlace) {
      const nearbyResponse = await fetch(
        "https://places.googleapis.com/v1/places:searchNearby",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": googleKey(),
            "X-Goog-FieldMask": FIELD_MASK,
          },
          body: JSON.stringify({
            locationRestriction: {
              circle: {
                center: {
                  latitude: addressPlace.latitude,
                  longitude: addressPlace.longitude,
                },
                radius: 100,
              },
            },
            maxResultCount: 20,
          }),
          cache: "no-store",
        },
      );

      if (!nearbyResponse.ok) {
        throw new Error(
          `Google Places Nearby Search failed: ${nearbyResponse.status}`
        );
      }

      const nearbyPayload = await nearbyResponse.json();
      const knownIds = new Set(places.map((place) => place.id));

      for (const rawPlace of Array.isArray(nearbyPayload?.places)
        ? nearbyPayload.places
        : []) {
        const place = parsePlace(rawPlace);

        if (place && !knownIds.has(place.id)) {
          places.push(place);
          knownIds.add(place.id);
        }
      }
    }
  }

  const scored = places
    .map((place: GooglePlace) => ({
      place,
      match: venueIdentityMatch({
        spot: evidence,
        candidate: place,
      }),
    }))
    .sort(
      (
        a: {
          place: GooglePlace;
          match: ReturnType<typeof venueIdentityMatch>;
        },
        b: {
          place: GooglePlace;
          match: ReturnType<typeof venueIdentityMatch>;
        }
      ) => b.match.score - a.match.score
    );

  const bestNameMatch = scored.find(({ match }) =>
    match.autoAttach === true
  ) ?? scored[0];

  if (!bestNameMatch) {
    return null;
  }

  /*
   * Address-only candidates are review suggestions, never
   * automatic venue identities.
   *
   * Require exact street/city/state and, when supplied,
   * exact postal code. Shared addresses remain ambiguous.
   */
  const addressMatches = scored.filter(({ match }) =>
    match.evidence.addressExact === true &&
    match.evidence.cityExact === true &&
    match.evidence.stateExact === true &&
    (
      !evidence.postalCode ||
      match.evidence.postalExact === true
    )
  );

  const businessAddressMatches = addressMatches.filter(
    ({ place }) =>
      !place.types.includes("street_address") &&
      !place.types.includes("route") &&
      !place.types.includes("premise") &&
      normalizeVenueMatchText(place.name) !==
        normalizeVenueMatchText(place.streetAddress) &&
      normalizeVenueMatchText(place.name) !==
        normalizeVenueMatchText(evidence.streetAddress)
  );

  const uniqueAddressCandidate =
    businessAddressMatches.length === 1
      ? businessAddressMatches[0]
      : null;

  const best = bestNameMatch.match.autoAttach
    ? bestNameMatch
    : uniqueAddressCandidate ?? bestNameMatch;

  /*
   * Google may append an official brand/collection qualifier to a
   * business name even when the publisher uses the shorter property
   * name, e.g.
   *
   *   Fenway Hotel
   *   Fenway Hotel, Autograph Collection
   *
   * Do not weaken the shared matcher or Ticketmaster thresholds.
   * Accept this Google-specific identity case only when:
   *
   * - one normalized name is a complete leading base of the other;
   * - street address matches exactly;
   * - city matches exactly;
   * - state matches exactly; and
   * - postal code matches exactly.
   */
  const publisherName =
    normalizeVenueMatchText(evidence.name);

  const googleName =
    normalizeVenueMatchText(best.place.name);

  const nameBaseMatch =
    publisherName !== "" &&
    googleName !== "" &&
    (
      googleName === publisherName ||
      googleName.startsWith(`${publisherName} `) ||
      publisherName.startsWith(`${googleName} `)
    );

  const exactLocationIdentity =
    best.match.evidence.addressExact &&
    best.match.evidence.cityExact &&
    best.match.evidence.stateExact &&
    best.match.evidence.postalExact;

  const googleQualified =
    best.match.autoAttach ||
    (nameBaseMatch && exactLocationIdentity);

  /*
   * A uniquely identified business at the exact published
   * address may qualify independently of publisher naming.
   *
   * Multiple matching businesses must go to Admin review.
   */
  const addressQualified =
    uniqueAddressCandidate !== null &&
    uniqueAddressCandidate.place.id === best.place.id &&
    businessAddressMatches.length === 1 &&
    normalizeVenueMatchText(best.place.name) !==
      normalizeVenueMatchText(best.place.streetAddress) &&
    normalizeVenueMatchText(best.place.name) !==
      normalizeVenueMatchText(evidence.streetAddress) &&
    best.match.evidence.addressExact === true &&
    best.match.evidence.cityExact === true &&
    best.match.evidence.stateExact === true &&
    (
      !evidence.postalCode ||
      best.match.evidence.postalExact === true
    );

  const autoQualified =
    googleQualified || addressQualified;

  const reviewCandidateQualified =
    options.allowReviewCandidate === true &&
    best.match.evidence.nameExact === true &&
    (!evidence.city || best.match.evidence.cityExact === true) &&
    (!evidence.stateRegion || best.match.evidence.stateExact === true) &&
    (!evidence.postalCode || best.match.evidence.postalExact === true) &&
    (!evidence.streetAddress || best.match.evidence.addressExact === true);

  /*
   * A publisher may use a neighborhood name where Google uses
   * the municipality. Unicode apostrophes and accents can also
   * differ between otherwise identical business names.
   *
   * Permit human review only when the complete normalized name
   * and street address match. Never change automatic qualification.
   */
  const localityReviewQualified =
    options.allowReviewCandidate === true &&
    Boolean(evidence.name && evidence.streetAddress && evidence.city) &&
    normalizeGoogleReviewName(evidence.name) !== "" &&
    normalizeGoogleReviewName(evidence.name) ===
      normalizeGoogleReviewName(best.place.name) &&
    best.match.evidence.addressExact === true &&
    (!evidence.stateRegion || best.match.evidence.stateExact === true) &&
    (!evidence.postalCode || best.match.evidence.postalExact === true);

  if (
    !autoQualified &&
    !reviewCandidateQualified &&
    !localityReviewQualified
  ) {
    if (!uniqueAddressCandidate) {
      return null;
    }

    return {
      place: uniqueAddressCandidate.place,
      score: uniqueAddressCandidate.match.score,
      evidence: {
        ...uniqueAddressCandidate.match.evidence,
        googleQualified: false,
        reviewOnly: true,
        addressOnlyCandidate: true,
      },
    };
  }

  return {
    place: best.place,
    score: best.match.autoAttach
      ? best.match.score
      : 1,
    evidence: {
      ...best.match.evidence,
      nameBaseMatch,
      exactLocationIdentity,
      googleQualified: autoQualified,
      addressQualified,
      localityReviewQualified,
      localityMismatch:
        localityReviewQualified &&
        best.match.evidence.cityExact !== true,
      reviewOnly: !autoQualified,
    },
  };
}

export async function upsertGoogleVenue(
  supabase: SupabaseClient,
  place: GooglePlace
): Promise<string> {
  const { data, error } = await supabase.rpc(
    "upsert_google_venue",
    {
      p_place_id: place.id,
      p_name: place.name,
      p_street_address:
        place.streetAddress ?? "",
      p_city: place.city ?? "",
      p_state_region:
        place.stateRegion ?? "",
      p_postal_code:
        place.postalCode ?? "",
      p_latitude: place.latitude,
      p_longitude: place.longitude,
      p_public_phone: place.publicPhone,
      p_website_url: place.websiteUrl,
      p_regular_hours: place.regularHours,
    }
  );

  if (error) {
    throw new Error(
      `Google venue upsert failed: ${error.message}`
    );
  }

  if (typeof data !== "string" || !data) {
    throw new Error(
      "Google venue upsert returned no venue ID."
    );
  }

  return data;
}


export async function recordGoogleSpotDiscovery(
  supabase: SupabaseClient,
  result: {
    place: GooglePlace;
    score: number;
    evidence: Record<string, unknown>;
  },
): Promise<"pending" | "approved" | "rejected"> {
  const { data, error } = await supabase.rpc(
    "record_event_harvest_google_spot",
    {
      p_place_id: result.place.id,
      p_place_data: result.place,
      p_confidence_score: result.score,
      p_evidence: result.evidence,
    },
  );

  if (error) {
    throw new Error(`Google Spot discovery failed: ${error.message}`);
  }

  if (data !== "pending" && data !== "approved" && data !== "rejected") {
    throw new Error("Unexpected Google Spot review status");
  }

  return data;
}



export async function resolveReviewedGoogleSpot(
  supabase: SupabaseClient,
  result: {
    place: GooglePlace;
    score: number;
    evidence: Record<string, unknown>;
  },
): Promise<string | null> {
  const { data, error } = await supabase.rpc(
    "resolved_event_harvest_google_spot",
    {
      p_place_id: result.place.id,
      p_place_data: result.place,
      p_confidence_score: result.score,
      p_evidence: result.evidence,
    },
  );

  if (error) {
    throw new Error(`Google Spot review lookup failed: ${error.message}`);
  }

  return typeof data === "string" && data ? data : null;
}

export async function registerHarvestGoogleSpot(
  supabase: SupabaseClient,
  result: {
    place: GooglePlace;
    score: number;
    evidence: Record<string, unknown>;
  },
): Promise<string | null> {
  const { data, error } = await supabase.rpc(
    "register_event_harvest_google_spot",
    {
      p_place_id: result.place.id,
      p_place_data: result.place,
      p_confidence_score: result.score,
      p_evidence: result.evidence,
    },
  );

  if (error) {
    throw new Error(`Harvester Google registration failed: ${error.message}`);
  }

  if (data !== null && typeof data !== "string") {
    throw new Error("Unexpected harvester registration result");
  }

  return data;
}
