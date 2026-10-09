import { recoveryFetch } from "@/lib/event-harvester/recovery-fetch";
import type { FirstPartyHarvestEvent } from "./types";

const GRAPHQL_URL = "https://backend.beatgig.com/api/v1/graphql";
const USER_AGENT = "TenderFans Event Harvester/1.0";

type BeatGigSeo = {
  name?: string | null;
  description?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  eventStatus?: string | null;
  url?: string | null;
  location?: {
    name?: string | null;
    address?: {
      streetAddress?: string | null;
      addressLocality?: string | null;
      postalCode?: string | null;
    } | null;
  } | null;
  performer?: {
    name?: string | null;
    genre?: string | null;
  } | null;
  image?: {
    contentUrl?: string | null;
  } | null;
};

type BeatGigBooking = {
  id?: string | null;
  seo?: BeatGigSeo | null;
};

type BeatGigResponse = {
  data?: {
    calendarBookings?: {
      bookings?: BeatGigBooking[] | null;
    } | null;
  } | null;
  errors?: Array<{
    message?: string | null;
  }> | null;
};

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

export function beatGigVenueSlugFromUrl(value: string): string | null {
  try {
    const url = new URL(value);

    if (
      url.hostname !== "dusk.fm" &&
      !url.hostname.endsWith(".dusk.fm")
    ) {
      return null;
    }

    const embedMatch = url.pathname.match(
      /\/(?:embed|iframe)\/venue-calendar\/([^/?#]+)/i,
    );

    if (embedMatch?.[1]) {
      return decodeURIComponent(embedMatch[1]);
    }

    const querySlug =
      url.searchParams.get("venueSlug") ??
      url.searchParams.get("venue_slug") ??
      url.searchParams.get("slug");

    return clean(querySlug);
  } catch {
    return null;
  }
}

function venueAddress(seo: BeatGigSeo): string | null {
  const address = seo.location?.address;

  if (!address) {
    return null;
  }

  const parts = [
    clean(address.streetAddress),
    clean(address.addressLocality),
    clean(address.postalCode),
  ].filter((value): value is string => Boolean(value));

  return parts.length > 0 ? parts.join(", ") : null;
}

export async function fetchBeatGigEvents(
  sourceUrl: string,
): Promise<FirstPartyHarvestEvent[]> {
  const slug = beatGigVenueSlugFromUrl(sourceUrl);

  if (!slug) {
    throw new Error(
      "BeatGig source URL does not expose a venue slug.",
    );
  }

  const query = `
    query CalendarBookingsSeo(
      $slug: String!
      $start: DateTime!
      $limit: Int!
      $offset: Int!
      $stageIds: [String!]
    ) {
      calendarBookings(
        organizationSlugs: [$slug]
        start: $start
        limit: $limit
        offset: $offset
        stageIds: $stageIds
      ) {
        bookings: calendarBookings {
          id
          seo {
            name
            description
            startDate
            endDate
            eventStatus
            url

            location {
              name
              address {
                streetAddress
                addressLocality
                postalCode
              }
            }

            performer {
              name
              genre
            }

            image {
              contentUrl
            }
          }
        }
      }
    }
  `;

  const response = await recoveryFetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      Origin: "https://dusk.fm",
      Referer: "https://dusk.fm/iframe/venue-calendar",
    },
    cache: "no-store",
    body: JSON.stringify({
      operationName: "CalendarBookingsSeo",
      query,
      variables: {
        slug,
        start: new Date().toISOString(),
        limit: 250,
        offset: 0,
        stageIds: null,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `BeatGig calendar returned HTTP ${response.status}.`,
    );
  }

  const payload = (await response.json()) as BeatGigResponse;

  if (payload.errors?.length) {
    throw new Error(
      `BeatGig calendar query failed: ${
        payload.errors
          .map((error) => clean(error.message))
          .filter(Boolean)
          .join("; ") || "unknown GraphQL error"
      }`,
    );
  }

  const bookings =
    payload.data?.calendarBookings?.bookings ?? [];

  const events: FirstPartyHarvestEvent[] = [];

  for (const booking of bookings) {
    const externalEventId = clean(booking.id);
    const seo = booking.seo;

    if (!externalEventId || !seo) {
      continue;
    }

    const title = clean(seo.name);
    const startsAt = clean(seo.startDate);

    if (!title || !startsAt) {
      continue;
    }

    /*
     * The public BeatGig calendar explicitly exposes lifecycle
     * status. Do not publish cancelled inventory.
     */
    if (
      clean(seo.eventStatus)?.toLowerCase() ===
      "eventcancelled"
    ) {
      continue;
    }

    const endsAt = clean(seo.endDate);
    const sourceEventUrl = clean(seo.url);
    const location = clean(seo.location?.name);
    const address = venueAddress(seo);

    events.push({
      externalEventId,
      title,
      description: clean(seo.description),
      startsAt,
      endsAt,
      allDay: false,
      sourceUrl: sourceEventUrl,
      flyerUrl: clean(seo.image?.contentUrl),
      location,
      venueName: location,
      venueAddress: address,
      rawPayload: {
        provider: "beatgig",
        bookingId: externalEventId,
        venueSlug: slug,
        eventStatus: clean(seo.eventStatus),
        sourceUrl: sourceEventUrl,
        location,
        venueAddress: address,
        performer: seo.performer
          ? {
              name: clean(seo.performer.name),
              genre: clean(seo.performer.genre),
            }
          : null,
      },
    });
  }

  return events.sort(
    (a, b) =>
      Date.parse(a.startsAt) - Date.parse(b.startsAt),
  );
}
