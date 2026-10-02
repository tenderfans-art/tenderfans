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
  };
}

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.addressComponents",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.regularOpeningHours.weekdayDescriptions",
].join(",");

export async function searchGoogleVenue(
  evidence: VenueIdentity
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

  const best = scored[0];

  if (!best) {
    return null;
  }

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

  if (!googleQualified) {
    return null;
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
      googleQualified,
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
