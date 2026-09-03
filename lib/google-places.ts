import { setOptions, importLibrary } from "@googlemaps/js-api-loader";

let initialized = false;

export async function loadGooglePlaces() {
  if (!initialized) {
    setOptions({
      key: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY!,
      v: "weekly",
    });
    initialized = true;
  }

  return importLibrary("places");
}
