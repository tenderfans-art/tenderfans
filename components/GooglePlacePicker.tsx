"use client";

import { useEffect, useRef } from "react";
import { loadGooglePlaces } from "@/lib/google-places";

type GooglePlace = {
  id: string;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  city: string;
  state: string;
  postalCode: string;
  streetAddress: string;
  publicPhone: string;
  websiteUrl: string;
  regularHours: string[];
};

export default function GooglePlacePicker({
  onSelect,
}: {
  onSelect: (place: GooglePlace) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
  async function init() {
    const { PlaceAutocompleteElement } = await loadGooglePlaces();
    const autocomplete = new PlaceAutocompleteElement();
    autocomplete.addEventListener("gmp-select", async (event: any) => {
  const place = event.placePrediction.toPlace();

  await place.fetchFields({
    fields: [
      "id",
      "displayName",
      "formattedAddress",
      "location",
      "addressComponents",
      "nationalPhoneNumber",
      "websiteURI",
      "regularOpeningHours",
    ],
  });

  const city = place.addressComponents?.find((c:any) => c.types.includes("locality"))?.longText ?? "";
  const state = place.addressComponents?.find((c:any) => c.types.includes("administrative_area_level_1"))?.shortText ?? "";
  const postalCode = place.addressComponents?.find((c:any) => c.types.includes("postal_code"))?.longText ?? "";
  const streetNumber = place.addressComponents?.find((c:any) => c.types.includes("street_number"))?.longText ?? "";
  const route = place.addressComponents?.find((c:any) => c.types.includes("route"))?.longText ?? "";
  const streetAddress = [streetNumber, route].filter(Boolean).join(" ");
  
  onSelect({
    id: place.id,
    name: place.displayName ?? "Unknown place",
    address: place.formattedAddress ?? "",
    latitude: place.location?.lat() ?? null,
    longitude: place.location?.lng() ?? null,
    city,
    state,
    postalCode,
    streetAddress,
    publicPhone: place.nationalPhoneNumber ?? "",
    websiteUrl: place.websiteURI ?? "",
    regularHours: place.regularOpeningHours?.weekdayDescriptions ?? []
  });
});

    containerRef.current?.replaceChildren(autocomplete);
  }

  init();
}, []);

  return <div ref={containerRef} />;
}
