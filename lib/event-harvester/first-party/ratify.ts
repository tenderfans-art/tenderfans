import { fetchEventbriteEventIdentity } from "./eventbrite-organizer";

import type { SourceDetection } from "./source-detector";

export type SourceVenueIdentity = {
  name: string;
  streetAddress: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
};

export type RatifiedSource = {
  sourceType: string;
  sourceUrl: string;
  externalSourceId: string | null;
  config: Record<string, unknown>;
};

export type SourceRatification =
  | {
      status: "ratified";
      source: RatifiedSource;
      evidence: string[];
      error: null;
    }
  | {
      status: "rejected";
      source: null;
      evidence: string[];
      error: null;
    }
  | {
      status: "ratification_failed";
      source: null;
      evidence: string[];
      error: string;
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

function eventbriteUrlKind(value: string): "organizer" | "event" | null {
  try {
    const url = new URL(value);

    if (!/(^|\.)eventbrite\.com$/i.test(url.hostname)) {
      return null;
    }

    if (/\/o\//i.test(url.pathname)) {
      return "organizer";
    }

    if (/\/e\//i.test(url.pathname)) {
      return "event";
    }

    return null;
  } catch {
    return null;
  }
}

function eventbriteOrganizerId(value: string): string | null {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/o\/(?:.*-)?(\d+)\/?$/i);

    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function ratifyEventbrite(
  detection: SourceDetection,
  venue: SourceVenueIdentity,
): Promise<SourceRatification> {
  const kind = eventbriteUrlKind(detection.url);

  if (!kind) {
    return {
      status: "ratification_failed",
      source: null,
      evidence: [
        ...detection.evidence,
        "Detected Eventbrite URL could not be classified",
      ],
      error: "Detected Eventbrite URL is neither an organizer nor event URL.",
    };
  }

  if (kind === "organizer") {
    const organizerId = eventbriteOrganizerId(detection.url);

    if (!organizerId) {
      return {
        status: "ratification_failed",
        source: null,
        evidence: [
          ...detection.evidence,
          "Eventbrite organizer URL did not expose a stable organizer ID",
        ],
        error: "Could not derive Eventbrite organizer ID.",
      };
    }

    return {
      status: "ratification_failed",
      source: null,
      evidence: [
        ...detection.evidence,
        `Eventbrite organizer ID ${organizerId} resolved from durable source`,
        "Direct organizer URL does not by itself establish Spot attribution",
      ],
      error:
        "Eventbrite organizer source requires Spot attribution before ratification.",
    };
  }

  try {
    const identity = await fetchEventbriteEventIdentity(detection.url);

    if (identity.isOnline) {
      return {
        status: "rejected",
        source: null,
        evidence: [
          ...detection.evidence,
          "Eventbrite candidate is an online event rather than a physical Spot event",
        ],
        error: null,
      };
    }

    if (!identity.venue) {
      return {
        status: "ratification_failed",
        source: null,
        evidence: [
          ...detection.evidence,
          "Eventbrite event did not expose a physical venue",
        ],
        error: "Insufficient Eventbrite venue identity for Spot attribution.",
      };
    }

    const external = identity.venue;

    if (
      venue.latitude === null ||
      venue.longitude === null ||
      external.latitude === null ||
      external.longitude === null
    ) {
      return {
        status: "ratification_failed",
        source: null,
        evidence: [
          ...detection.evidence,
          "Eventbrite event and TenderFans Spot did not both expose coordinates",
        ],
        error:
          "Insufficient coordinate evidence for Eventbrite Spot attribution.",
      };
    }

    const miles = distanceMiles(
      venue.latitude,
      venue.longitude,
      external.latitude,
      external.longitude,
    );

    if (miles > 1) {
      return {
        status: "rejected",
        source: null,
        evidence: [
          ...detection.evidence,
          `Eventbrite identifies physical venue "${external.name ?? "unknown"}"`,
          `Eventbrite venue is ${miles.toFixed(1)} miles from the TenderFans Spot`,
        ],
        error: null,
      };
    }

    if (miles > 0.25) {
      return {
        status: "ratification_failed",
        source: null,
        evidence: [
          ...detection.evidence,
          `Eventbrite venue is ${miles.toFixed(2)} miles from the TenderFans Spot`,
        ],
        error: "Eventbrite venue proximity is inconclusive.",
      };
    }

    const organizerId = identity.organizer.id;

    const organizerUrl = identity.organizer.url;

    if (!organizerId || !organizerUrl) {
      return {
        status: "ratification_failed",
        source: null,
        evidence: [
          ...detection.evidence,
          "Attributed Eventbrite event did not expose a durable organizer source",
        ],
        error: "Could not derive durable Eventbrite organizer source.",
      };
    }

    return {
      status: "ratified",
      source: {
        sourceType: "eventbrite_organizer",
        sourceUrl: organizerUrl,
        externalSourceId: `eventbrite:organizer:${organizerId}`,
        config: {
          organizer_id: organizerId,
          venue_id: external.id,
        },
      },
      evidence: [
        ...detection.evidence,
        `Eventbrite identifies physical venue "${external.name ?? "unknown"}"`,
        `Eventbrite venue matches the TenderFans Spot within ${miles.toFixed(2)} miles`,
        "Attributed Eventbrite event resolved to durable organizer source",
      ],
      error: null,
    };
  } catch (error) {
    return {
      status: "ratification_failed",
      source: null,
      evidence: [
        ...detection.evidence,
        "Eventbrite event identity could not be inspected",
      ],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const directlyRatifiableSourceTypes = new Set([
  "godaddy_menu_recurring",
  "cp_multi_view_calendar",
  "uvtix_events",
  "schema_org_events",
  "pwpc_events_calendar",
  "shopify_events",
  "spothopper_events",
  "squarespace_events",
  "google_calendar",
  "beatgig_events",
  "bandzoogle_events",
  "eventscalendar_events",
  "sociablekit_facebook_events",
  "tribe_rest",
  "next_rsc_events",
  "wordpress_event_feed",
  "calendar_image",
]);

function stableExternalSourceId(detection: SourceDetection): string {
  return ["first_party", detection.sourceType, detection.url].join(":");
}

export async function ratifyDetectedSource(
  detection: SourceDetection,
  venue: SourceVenueIdentity,
): Promise<SourceRatification> {
  if (
    detection.sourceType === "facebook" &&
    detection.adapterAvailable
  ) {
    /*
     * Preserve "facebook" as the detector/finding type while storing
     * the implemented production adapter as "facebook_events".
     *
     * Facebook Pages may publish events for multiple physical venues,
     * so event-level venue attribution remains downstream rather than
     * forcing every harvested event onto the source Spot.
     */
    return {
      status: "ratified",
      source: {
        sourceType: "facebook_events",
        sourceUrl: detection.url,
        externalSourceId: [
          "first_party",
          "facebook_events",
          detection.url,
        ].join(":"),
        config: {},
      },
      evidence: [
        ...detection.evidence,
        "Facebook Page was discovered from the Spot surface",
        "TenderFans has an implemented Facebook Events adapter",
        "Event venue attribution will be resolved per harvested event",
      ],
      error: null,
    };
  }

  if (detection.sourceType === "eventbrite_organizer") {
    /*
     * Eventbrite is the exception because an Eventbrite
     * event or organizer can belong to a completely different
     * physical venue. Preserve the stronger venue-attribution
     * ratifier for this provider.
     */
    return ratifyEventbrite(detection, venue);
  }

  if (
    detection.adapterAvailable &&
    directlyRatifiableSourceTypes.has(detection.sourceType)
  ) {
    /*
     * These source types were discovered from the Spot's own
     * first-party website/event surface (or a provider handoff
     * exposed by that surface), and each has an implemented
     * preview adapter.
     *
     * Ratification establishes the source candidate. The
     * adapter is still exercised separately by validation;
     * zero current events remains a valid/empty source rather
     * than a failed source.
     */
    return {
      status: "ratified",
      source: {
        sourceType: detection.sourceType,
        sourceUrl: detection.url,
        externalSourceId: stableExternalSourceId(detection),
        config: {},
      },
      evidence: [
        ...detection.evidence,
        "Source was discovered from the Spot event surface",
        "TenderFans has an implemented adapter for this source type",
      ],
      error: null,
    };
  }

  return {
    status: "ratification_failed",
    source: null,
    evidence: [
      ...detection.evidence,
      "No automatic ratification rule is available for this detected source type",
    ],
    error: `No automatic ratifier implemented for ${detection.sourceType}.`,
  };
}
