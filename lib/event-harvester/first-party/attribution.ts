import type { SupabaseClient } from "@supabase/supabase-js";

import {
  normalizeVenueMatchText,
  venueIdentityMatch,
  type VenueIdentity,
} from "../venue-identity";

import {
  searchGoogleVenue,
  registerHarvestGoogleSpot,
  recordGoogleSpotDiscovery,
  resolveReviewedGoogleSpot,
} from "../google-places";

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

  if (!address) {
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
    /^(.*?),\s*([^,]+),\s*([A-Za-z]{2})(?:\s+(\d{5}(?:-\d{4})?)|,\s*(\d{5}(?:-\d{4})?)(?:,\s*(?:US|USA))?)?$/,
  );

  if (!match) {
    return null;
  }

  const streetAddress = match[1].trim();
  const city = match[2].trim();
  const stateRegion = match[3].trim();
  const postalCode = match[4] ?? match[5] ?? null;

  if (
    !streetAddress ||
    !city ||
    /^\d{5}(?:-\d{4})?$/.test(city) ||
    /^(?:US|USA)$/i.test(stateRegion)
  ) {
    return null;
  }

  return {
    name: name || streetAddress,
    streetAddress,
    city,
    stateRegion,
    postalCode,
  };
}

export async function resolveFirstPartyAttribution(
  supabase: SupabaseClient,
  event: FirstPartyEventPreview,
): Promise<FirstPartyAttribution> {
  /*
   * HTML event adapters may identify a physical performance venue
   * that differs from the Spot publishing the schedule.
   * Do not treat that physical venue as publisher identity.
   */
  const evidence =
    event.sourceType === "html_events"
      ? null
      : publisherEvidence(event);
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
   * A previously approved Facebook place identity is reusable
   * across occurrences and shared Facebook sources.
   * Only an unambiguous approval qualifies. Never infer ownership
   * from event title, geographic proximity, or suggested Spot.
   */
  if (event.sourceType === "facebook_events" &&
      facebookPlace?.facebookPlaceId) {
    const { data: approvedPlaceRows, error: approvedPlaceError } =
      await supabase.rpc("resolved_facebook_place_venue", {
        p_facebook_place_id: facebookPlace.facebookPlaceId,
      });

    if (approvedPlaceError) {
      throw new Error(
        `Could not resolve approved Facebook place: ${approvedPlaceError.message}`,
      );
    }

    const approvedPlace = Array.isArray(approvedPlaceRows)
      ? approvedPlaceRows[0]
      : null;

    if (approvedPlace?.venue_id) {
      return {
        status: "resolved",
        venueId: approvedPlace.venue_id,
        confidenceScore: 1,
        rawVenueName: event.venueName ?? facebookPlace.name,
        rawAddress: event.venueAddress ?? event.location ?? null,
        method: "admin_resolved",
      };
    }
  }

  /*
   * Reuse a human-approved Facebook place attribution across
   * occurrences. A shared source is not itself Spot ownership.
   *
   * Require a stable place ID, explicit prior approval, agreement
   * among all approvals, and an active destination Spot.
   */
  if (event.sourceType === "facebook_events" &&
      facebookPlace?.facebookPlaceId) {
    const placeId = facebookPlace.facebookPlaceId;

    const approvedRows: Array<{
      source_id: string;
      resolved_venue_id: string;
    }> = [];

    for (let offset = 0; ; offset += 500) {
      const { data, error } = await supabase
        .from("event_harvest_unresolved_venues")
        .select("source_id,resolved_venue_id")
        .eq("status", "resolved")
        .contains("evidence", { facebookPlaceId: placeId })
        .range(offset, offset + 499);

      if (error) {
        throw new Error(
          `Could not inspect approved Facebook places: ${error.message}`,
        );
      }

      approvedRows.push(...(data ?? []));

      if (!data || data.length < 500) break;
    }

    if (approvedRows.length) {
      const sourceIds = [
        ...new Set(approvedRows.map((row) => row.source_id)),
      ];

      const { data: sourceRows, error: sourceError } =
        await supabase
          .from("event_harvest_sources")
          .select("id,source_type")
          .in("id", sourceIds);

      if (sourceError) {
        throw new Error(
          `Could not verify Facebook approval sources: ${sourceError.message}`,
        );
      }

      const facebookSourceIds = new Set(
        (sourceRows ?? [])
          .filter((source) => source.source_type === "facebook_events")
          .map((source) => source.id),
      );

      const approvedVenueIds = [
        ...new Set(
          approvedRows
            .filter((row) => facebookSourceIds.has(row.source_id))
            .map((row) => row.resolved_venue_id)
            .filter((id): id is string => Boolean(id)),
        ),
      ];

      if (approvedVenueIds.length === 1) {
        const { data: approvedVenue, error: venueError } =
          await supabase
            .from("venues")
            .select("id")
            .eq("id", approvedVenueIds[0])
            .eq("status", "active")
            .maybeSingle();

        if (venueError) {
          throw new Error(
            `Could not verify approved Facebook Spot: ${venueError.message}`,
          );
        }

        if (approvedVenue) {
          return {
            status: "resolved",
            venueId: approvedVenue.id,
            confidenceScore: 1,
            rawVenueName: facebookPlace.name ?? event.venueName ?? null,
            rawAddress: event.venueAddress ?? event.location ?? null,
            method: "admin_resolved",
          };
        }
      }
    }
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

    if (
      !event.allowSourceDefaultAttribution &&
      !event.venueName?.trim()
    ) {
      return {
        status: "unresolved",
        rawVenueName: null,
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

    /*
     * An explicitly named event venue is independent of the
     * publishing Spot, even when its postal address is missing.
     * Preserve it for event-level venue review rather than
     * silently assigning the publisher's source venue.
     */
    const namedEventVenue = event.venueName?.trim() ?? "";

    if (namedEventVenue) {
      const { data: sourceVenue, error: sourceVenueError } =
        event.venueId
          ? await supabase
              .from("venues")
              .select("name,street_address,city,state_region,postal_code")
              .eq("id", event.venueId)
              .maybeSingle()
          : { data: null, error: null };

      if (sourceVenueError) {
        throw new Error(
          `Could not inspect source Spot identity: ${sourceVenueError.message}`,
        );
      }

      const sameNameAsSource =
        sourceVenue?.name &&
        normalizeVenueMatchText(sourceVenue.name) ===
          normalizeVenueMatchText(namedEventVenue);

      const suppliedLocation =
        event.venueAddress?.trim() ||
        event.location?.trim() ||
        "";

      const sourceAddress =
        normalizeVenueMatchText(sourceVenue?.street_address);

      const normalizedLocation =
        normalizeVenueMatchText(suppliedLocation);

      const locationAgreesWithSource =
        !suppliedLocation ||
        normalizedLocation ===
          normalizeVenueMatchText(namedEventVenue) ||
        (
          sourceAddress !== "" &&
          normalizedLocation.includes(sourceAddress)
        );

      const sameAsSource =
        Boolean(sameNameAsSource) &&
        locationAgreesWithSource;

      if (!sameAsSource) {
        const { data: candidateVenues, error: candidateError } =
          await supabase
            .from("venues")
            .select("id,name,street_address,city,state_region,postal_code")
            .eq("status", "active");

        if (candidateError) {
          throw new Error(
            `Could not inspect candidate event Spots: ${candidateError.message}`,
          );
        }

        const namedEvidence: VenueIdentity = {
          name: namedEventVenue,
          streetAddress: null,
          city: null,
          stateRegion: null,
          postalCode: null,
        };

        const candidates = (candidateVenues ?? [])
          .map((venue) => ({
            venue,
            match: venueIdentityMatch({
              spot: namedEvidence,
              candidate: {
                name: venue.name,
                streetAddress: venue.street_address,
                city: venue.city,
                stateRegion: venue.state_region,
                postalCode: venue.postal_code,
              },
            }),
          }))
          .sort((a, b) => b.match.score - a.match.score);

        const exactNameCandidates = candidates.filter(
          ({ match }) => match.evidence.nameExact === true,
        );

        const best =
          exactNameCandidates.length === 1
            ? exactNameCandidates[0]
            : null;

        const google = await searchGoogleVenue(
          namedEvidence,
          { allowReviewCandidate: true },
        );

        return {
          status: "unresolved",
          rawVenueName: namedEventVenue,
          rawAddress:
            event.venueAddress?.trim() ||
            event.location?.trim() ||
            null,
          publisherEvidence: namedEvidence,
          suggestedVenueId:
            best?.match.evidence.nameExact === true
              ? best.venue.id
              : null,
          confidenceScore:
            best?.match.evidence.nameExact === true
              ? best.match.score
              : null,
          evidence: {
            reason: "named_event_venue_requires_location_resolution",
            sourceType: event.sourceType,
            venueName: namedEventVenue,
            candidateName: best?.venue.name ?? null,
            candidateScore: best?.match.score ?? null,
            exactNameCandidateCount: exactNameCandidates.length,
            needsReview: true,
            googlePlaceId: google?.place.id ?? null,
            googlePlaceName: google?.place.name ?? null,
            googlePlaceAddress: google?.place.formattedAddress ?? null,
            googlePlaceScore: google?.score ?? null,
            googleReviewOnly: google?.evidence.reviewOnly ?? null,
          },
        };
      }
    }

    if (!event.allowSourceDefaultAttribution) {
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
          reason: "source_default_attribution_disallowed",
          sourceType: event.sourceType,
        },
      };
    }

    if (!event.venueId) {
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
          reason: "source_has_no_default_venue",
          sourceType: event.sourceType,
        },
      };
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
    /*
     * Address-only evidence is valid location evidence, but the
     * address itself is not a verified business name.
     *
     * Use the shared Google Places address-first discovery and
     * preserve its qualification and review safeguards.
     */
    const google = await searchGoogleVenue(evidence);

    if (google?.evidence.reviewOnly === true) {
    const approvedVenueId = await resolveReviewedGoogleSpot(
      supabase,
      google,
    );

    if (approvedVenueId) {
      return {
        status: "resolved",
        venueId: approvedVenueId,
        confidenceScore: google.score,
        rawVenueName: evidence.name,
        rawAddress: event.venueAddress ?? null,
        method: "admin_resolved",
      };
    }

      await recordGoogleSpotDiscovery(supabase, google);
      return {
        status: "unresolved",
        rawVenueName: event.venueName?.trim() || null,
        rawAddress: event.venueAddress ?? null,
        publisherEvidence: evidence,
        suggestedVenueId: best?.venue.id ?? null,
        confidenceScore: google.score,
        evidence: {
          ...google.evidence,
          googlePlaceId: google.place.id,
          googlePlaceName: google.place.name,
          googleFormattedAddress: google.place.formattedAddress,
          reason: "google_address_candidate_requires_review",
        },
      };
    }

    if (google?.evidence.googleQualified === true) {
      const venueId = await registerHarvestGoogleSpot(supabase, google);

      if (!venueId) {
        return {
          status: "unresolved",
          rawVenueName: evidence.name,
          rawAddress: event.venueAddress ?? null,
          publisherEvidence: evidence,
          suggestedVenueId: best?.venue.id ?? null,
          confidenceScore: google.score,
          evidence: {
            ...google.evidence,
            googlePlaceId: google.place.id,
            reason: "google_spot_admin_rejected",
          },
        };
      }

      return {
        status: "resolved",
        venueId,
        confidenceScore: google.score,
        rawVenueName: event.venueName?.trim() || null,
        rawAddress: event.venueAddress ?? null,
        method: "google_created_or_resolved",
      };
    }

    return {
      status: "unresolved",
      rawVenueName: event.venueName?.trim() || null,
      rawAddress: event.venueAddress ?? null,
      publisherEvidence: evidence,
      suggestedVenueId: best?.venue.id ?? null,
      confidenceScore: best?.match.score ?? null,
      evidence: {
        ...(best?.match.evidence ?? {}),
        googlePlaceId: google?.place.id ?? null,
        googlePlaceName: google?.place.name ?? null,
        googleFormattedAddress: google?.place.formattedAddress ?? null,
        needsReview: true,
        reason: "address_only_venue_requires_review",
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

  if (google && google.evidence.reviewOnly === true) {
    const approvedVenueId = await resolveReviewedGoogleSpot(
      supabase,
      google,
    );

    if (approvedVenueId) {
      return {
        status: "resolved",
        venueId: approvedVenueId,
        confidenceScore: google.score,
        rawVenueName: evidence.name,
        rawAddress: event.venueAddress ?? null,
        method: "admin_resolved",
      };
    }

    await recordGoogleSpotDiscovery(supabase, google);
    return {
      status: "unresolved",
      rawVenueName: evidence.name,
      rawAddress: event.venueAddress ?? null,
      publisherEvidence: evidence,
      suggestedVenueId: best?.venue.id ?? null,
      confidenceScore: google.score,
      evidence: {
        ...google.evidence,
        googlePlaceId: google.place.id,
        googlePlaceName: google.place.name,
        googleFormattedAddress: google.place.formattedAddress,
        reason: "google_address_candidate_requires_review",
      },
    };
  }

  if (google && google.evidence.googleQualified === true) {
    const venueId = await registerHarvestGoogleSpot(supabase, google);

      if (!venueId) {
        return {
          status: "unresolved",
          rawVenueName: evidence.name,
          rawAddress: event.venueAddress ?? null,
          publisherEvidence: evidence,
          suggestedVenueId: best?.venue.id ?? null,
          confidenceScore: google.score,
          evidence: {
            ...google.evidence,
            googlePlaceId: google.place.id,
            reason: "google_spot_admin_rejected",
          },
        };
      }

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
