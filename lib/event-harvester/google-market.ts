import type { SupabaseClient } from "@supabase/supabase-js";

export type GoogleMarketIdentity = {
  id: string;
  countryCode?: string | null;
  stateRegion?: string | null;
  countyRegion?: string | null;
};

/*
 * Existing Google Place ownership always wins.
 *
 * For an unseen Place ID, resolve geographic membership using
 * the county verified by Google Places and configured through
 * Market Management.
 *
 * Never infer Market from a source publisher, nearby city,
 * postal prefix, or default Pinellas membership.
 */
export async function resolveGoogleSpotMarket(
  db: SupabaseClient,
  place: GoogleMarketIdentity,
): Promise<string | null> {
  const { data: reference, error: referenceError } = await db
    .from("venue_external_refs")
    .select("venue_id")
    .eq("provider", "google_places")
    .eq("provider_place_id", place.id)
    .maybeSingle();

  if (referenceError) {
    throw new Error(referenceError.message);
  }

  if (reference?.venue_id) {
    const { data: membership, error } = await db
      .from("event_processing_market_venues")
      .select("market_id")
      .eq("venue_id", reference.venue_id)
      .maybeSingle();

    if (error) throw new Error(error.message);

    if (!membership?.market_id) {
      throw new Error(
        "Existing Google Spot has no Market membership."
      );
    }

    return membership.market_id;
  }

  const { data: request, error: requestError } = await db
    .from("event_google_spot_market_requests")
    .select("market_id")
    .eq("place_id", place.id)
    .maybeSingle();

  if (requestError) {
    throw new Error(requestError.message);
  }

  if (request?.market_id) {
    return request.market_id;
  }

  const country = place.countryCode?.trim().toUpperCase();
  const state = place.stateRegion?.trim().toUpperCase();
  const county = place.countyRegion
    ?.trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  if (!country || !state || !county) {
    return null;
  }

  const { data: territory, error: territoryError } = await db
    .from("event_processing_market_counties")
    .select("market_id")
    .eq("country_code", country)
    .eq("state_region", state)
    .eq("county_key", county)
    .maybeSingle();

  if (territoryError) {
    throw new Error(territoryError.message);
  }

  return territory?.market_id ?? null;
}
