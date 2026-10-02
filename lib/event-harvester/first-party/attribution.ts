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
      rawVenueName: string;
      rawAddress: string | null;
      publisherEvidence: VenueIdentity;
      suggestedVenueId: string | null;
      confidenceScore: number | null;
      evidence: Record<string, unknown>;
    };

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
