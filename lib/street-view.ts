import "server-only";

type StreetViewMetadata = {
  panoId: string;
  latitude: number;
  longitude: number;
};

type VenueForStreetView = {
  street_address?: string | null;
  city?: string | null;
  state_region?: string | null;
  postal_code?: string | null;
};

export async function getStreetViewMetadata(
  venue: VenueForStreetView
): Promise<StreetViewMetadata | null> {
  const key = process.env.GOOGLE_PLACES_API_KEY;

  if (!key) {
    console.error("Street View metadata: GOOGLE_PLACES_API_KEY is missing");
    return null;
  }

  const address = [
    venue.street_address,
    venue.city,
    venue.state_region,
    venue.postal_code,
  ]
    .filter(Boolean)
    .join(", ");

  if (!address) return null;

  const params = new URLSearchParams({
    location: address,
    key,
  });

  try {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/streetview/metadata?${params.toString()}`,
      {
        cache: "no-store",
      }
    );

    if (!response.ok) {
      console.error(
        "Street View metadata HTTP error:",
        response.status,
        response.statusText
      );
      return null;
    }

    const data = await response.json();

    if (
      data.status !== "OK" ||
      !data.pano_id ||
      typeof data.location?.lat !== "number" ||
      typeof data.location?.lng !== "number"
    ) {
      console.warn("Street View metadata unavailable:", address, data.status);
      return null;
    }

    return {
      panoId: data.pano_id,
      latitude: data.location.lat,
      longitude: data.location.lng,
    };
  } catch (error) {
    console.error("Street View metadata request failed:", error);
    return null;
  }
}
