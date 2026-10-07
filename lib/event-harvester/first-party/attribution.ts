import type { SupabaseClient } from "@supabase/supabase-js";

import {
  normalizeVenueMatchText,
  venueIdentityMatch,
  type VenueIdentity,
} from "../venue-identity";

import { searchGoogleVenue, upsertGoogleVenue } from "../google-places";

import type { FirstPartyEventPreview } from "./preview";

export type FirstPartyAttribution =
  | {
      status: "resolved";
      venueId: string;
      confidenceScore: number;
      rawVenueName: string | null;
      rawAddress: string | null;
      method:
        | "source_default"
        | "existing_spot"
        | "google_created_or_resolved"
        | "admin_resolved";
    }
  | {
      status: "unresolved";
      rawVenueName: string | null;
      rawAddress: string | null;
      publisherEvidence: VenueIdentity | null;
      suggestedVenueId: string | null;
      confidenceScore: number | null;
      evidence: Record<string, unknown>;
    };

function distanceMiles(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;

  return 2 * earthRadiusMiles * Math.asin(Math.sqrt(a));
}

function facebookPlaceEvidence(
  event: FirstPartyEventPreview,
): {
  latitude: number;
  longitude: number;
  name: string | null;
  facebookPlaceId: string | null;
} | null {
  if (event.sourceType !== "facebook_events") {
    return null;
  }

  const raw = event.rawPayload as Record<string, unknown> | null;
  const place =
    raw &&
    typeof raw.eventPlace === "object" &&
    raw.eventPlace !== null
      ? (raw.eventPlace as Record<string, unknown>)
      : null;

  if (!place) {
    return null;
  }

  const latitude =
    typeof place.latitude === "number" ? place.latitude : null;
  const longitude =
    typeof place.longitude === "number" ? place.longitude : null;

  if (latitude === null || longitude === null) {
    return null;
  }

  return {
    latitude,
    longitude,
    name:
      typeof place.name === "string" && place.name.trim()
        ? place.name.trim()
        : null,
    facebookPlaceId:
      typeof place.facebookPlaceId === "string" &&
      place.facebookPlaceId.trim()
        ? place.facebookPlaceId.trim()
        : null,
  };
}

function publisherEvidence(
  event: FirstPartyEventPreview,
): VenueIdentity | null {
  const name = event.venueName?.trim() ?? "";
  const address = event.venueAddress?.trim() ?? "";

  if (!name || !address) {
    return null;
  }

  /*
   * WordPress currently supplies the publisher's complete address
   * string. The existing matcher needs city/state/postal separately,
   * so derive only the trailing US locality fields. If the publisher
   * evidence cannot be safely decomposed, attribution remains
   * unresolved instead of guessing.
   */
  const match = address.match(
    /^(.*?),\s*([^,]+),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/,
  );

  if (!match) {
    return null;
  }

  return {
    name,
    streetAddress: match[1].trim(),
    city: match[2].trim(),
    stateRegion: match[3].trim(),
    postalCode: match[4].trim(),
  };
}

export async function resolveFirstPartyAttribution(
  supabase: SupabaseClient,
  event: FirstPartyEventPreview,
): Promise<FirstPartyAttribution> {
  const evidence = publisherEvidence(event);
  const facebookPlace = facebookPlaceEvidence(event);

  /*
   * A previous unresolved harvest may already have been resolved by
   * an administrator. That durable event-level attribution takes
   * precedence over repeating automated venue matching.
   */
  const { data: resolvedRows, error: resolvedError } = await supabase.rpc(
    "resolved_event_harvest_venue",
    {
      p_source_id: event.sourceId,
      p_external_event_id: event.externalEventId,
    },
  );

  if (resolvedError) {
    throw new Error(
      `Could not load resolved publisher venue attribution for "${event.title}": ${resolvedError.message}`,
    );
  }

  const resolved = Array.isArray(resolvedRows) ? resolvedRows[0] : null;

  if (resolved?.venue_id) {
    return {
      status: "resolved",
      venueId: resolved.venue_id,
      confidenceScore: 1,
      rawVenueName: event.venueName ?? null,
      rawAddress: event.venueAddress ?? event.location ?? null,
      method: "admin_resolved",
    };
  }

  /*
   * No structured publisher venue identity means this adapter has
   * supplied no reason to override established source ownership.
   */
  if (!evidence) {
    if (event.sourceType === "facebook_events" && facebookPlace) {
      const { data: nearbyVenues, error: nearbyError } = await supabase
        .from("venues")
        .select("id,name,latitude,longitude")
        .eq("status", "active")
        .not("latitude", "is", null)
        .not("longitude", "is", null);

      if (nearbyError) {
        throw new Error(
          `Could not load active Spot coordinates for Facebook attribution: ${nearbyError.message}`,
        );
      }

      const publisherName = normalizeVenueMatchText(
        facebookPlace.name ?? event.venueName ?? "",
      );

      const nearby = (nearbyVenues ?? [])
        .map((venue: any) => {
          const miles = distanceMiles(
            facebookPlace.latitude,
            facebookPlace.longitude,
            venue.latitude,
            venue.longitude,
          );

          const spotName = normalizeVenueMatchText(venue.name);

          const compactPublisherName =
            publisherName.replace(/\s+/g, "");
          const compactSpotName =
            spotName.replace(/\s+/g, "");

          const nameMatch =
            publisherName !== "" &&
            spotName !== "" &&
            (spotName === publisherName ||
              spotName.startsWith(`${publisherName} `) ||
              publisherName.startsWith(`${spotName} `) ||
              compactSpotName === compactPublisherName);

          return {
            venue,
            miles,
            nameMatch,
          };
        })
        .sort((a: any, b: any) => a.miles - b.miles);

      const best = nearby[0];

      const matched = nearby.find(
        (candidate: any) =>
          candidate.miles <= 0.25 &&
          candidate.nameMatch,
      );

      if (matched) {
        return {
          status: "resolved",
          venueId: matched.venue.id,
          confidenceScore: 1,
          rawVenueName: facebookPlace.name ?? event.venueName ?? null,
          rawAddress:
            event.venueAddress?.trim() ||
            event.location?.trim() ||
            null,
          method: "existing_spot",
        };
      }

      return {
        status: "unresolved",
        rawVenueName: facebookPlace.name ?? event.venueName ?? null,
        rawAddress:
          event.venueAddress?.trim() ||
          event.location?.trim() ||
          null,
        publisherEvidence: null,
        suggestedVenueId:
          best && best.miles <= 0.25 ? best.venue.id : null,
        confidenceScore:
          best && best.miles <= 0.25
            ? Math.max(0, 1 - best.miles / 0.25)
            : null,
        evidence: {
          reason: "facebook_place_requires_review",
          sourceType: event.sourceType,
          facebookPlaceId: facebookPlace.facebookPlaceId,
          latitude: facebookPlace.latitude,
          longitude: facebookPlace.longitude,
          nearestSpotMiles: best?.miles ?? null,
          nearestSpotName: best?.venue.name ?? null,
          nameMatch: false,
        },
      };
    }

    if (event.sourceType === "facebook_events") {
      return {
        status: "unresolved",
        rawVenueName: event.venueName?.trim() || null,
        rawAddress:
          event.venueAddress?.trim() ||
          event.location?.trim() ||
          null,
        publisherEvidence: null,
        suggestedVenueId: null,
        confidenceScore: null,
        evidence: {
          reason: "shared_source_missing_complete_venue_identity",
          sourceType: event.sourceType,
        },
      };
    }

    if (!event.venueId) {
      throw new Error(
        `First-party source ${event.sourceId} has no Spot for source-default attribution.`,
      );
    }

    return {
      status: "resolved",
      venueId: event.venueId,
      confidenceScore: 1,
      rawVenueName: event.venueName ?? null,
      rawAddress: event.venueAddress ?? event.location ?? null,
      method: "source_default",
    };
  }

  const { data, error } = await supabase
    .from("venues")
    .select("id,name,street_address,city,state_region,postal_code")
    .eq("status", "active");

  if (error) {
    throw new Error(
      `Could not load active Spots for first-party attribution: ${error.message}`,
    );
  }

  const scored = (data ?? [])
    .map((venue: any) => ({
      venue,
      match: venueIdentityMatch({
        spot: evidence,
        candidate: {
          name: venue.name,
          streetAddress: venue.street_address,
          city: venue.city,
          stateRegion: venue.state_region,
          postalCode: venue.postal_code,
        },
      }),
    }))
    .sort((a: any, b: any) => b.match.score - a.match.score);

  const best = scored[0];

  /*
   * Some publishers can degrade a venue's name into its street
   * address. In that case the apparent name must not manufacture
   * confidence for Google venue creation.
   *
   * Preserve the best existing Spot as a suggestion and route the
   * event through the established venue-match review workflow.
   */
  const publisherNameIsAddress =
    normalizeVenueMatchText(evidence.name) !== "" &&
    normalizeVenueMatchText(evidence.name) ===
      normalizeVenueMatchText(evidence.streetAddress);

  if (publisherNameIsAddress) {
    return {
      status: "unresolved",
      rawVenueName: evidence.name,
      rawAddress: event.venueAddress ?? null,
      publisherEvidence: evidence,
      suggestedVenueId: best?.venue.id ?? null,
      confidenceScore: best?.match.score ?? null,
      evidence: {
        ...(best?.match.evidence ?? {}),
        autoAttach: best?.match.autoAttach ?? false,
        needsReview: true,
        reason: "publisher_venue_name_is_address",
      },
    };
  }

  if (best) {
    const publisherName = normalizeVenueMatchText(evidence.name);

    const existingName = normalizeVenueMatchText(best.venue.name);

    const nameBaseMatch =
      publisherName !== "" &&
      existingName !== "" &&
      (existingName === publisherName ||
        existingName.startsWith(`${publisherName} `) ||
        publisherName.startsWith(`${existingName} `));

    const exactLocationIdentity =
      best.match.evidence.addressExact &&
      best.match.evidence.cityExact &&
      best.match.evidence.stateExact &&
      best.match.evidence.postalExact;

    const existingQualified =
      best.match.autoAttach || (nameBaseMatch && exactLocationIdentity);

    if (existingQualified) {
      return {
        status: "resolved",
        venueId: best.venue.id,
        confidenceScore: best.match.autoAttach ? best.match.score : 1,
        rawVenueName: evidence.name,
        rawAddress: event.venueAddress ?? null,
        method: "existing_spot",
      };
    }
  }

  const google = await searchGoogleVenue(evidence);

  if (google) {
    const venueId = await upsertGoogleVenue(supabase, google.place);

    return {
      status: "resolved",
      venueId,
      confidenceScore: google.score,
      rawVenueName: evidence.name,
      rawAddress: event.venueAddress ?? null,
      method: "google_created_or_resolved",
    };
  }

  return {
    status: "unresolved",
    rawVenueName: evidence.name,
    rawAddress: event.venueAddress ?? null,
    publisherEvidence: evidence,
    suggestedVenueId: best?.venue.id ?? null,
    confidenceScore: best?.match.score ?? null,
    evidence: best
      ? {
          ...best.match.evidence,
          autoAttach: best.match.autoAttach,
          needsReview: best.match.needsReview,
        }
      : {},
  };
}
