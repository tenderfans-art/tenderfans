"use client";

import { useEffect, useRef } from "react";
import { importLibrary, setOptions } from "@googlemaps/js-api-loader";

type VenueVisualVenue = {
  name: string;
  street_address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

let configured = false;

export default function VenueVisual({ venue }: { venue: VenueVisualVenue }) {
  const visualRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visualRef.current || venue.latitude == null || venue.longitude == null) return;

    let cancelled = false;

    async function init() {
      if (!configured) {
        setOptions({
          key: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY!,
          v: "weekly",
        });
        configured = true;
      }

      await importLibrary("geometry");

      const position = { lat: venue.latitude!, lng: venue.longitude! };
      const { StreetViewService, StreetViewPanorama } =
        await importLibrary("streetView") as google.maps.StreetViewLibrary;

      const service = new StreetViewService();

      const requestPanorama = (location: google.maps.LatLng | google.maps.LatLngLiteral, radius = 75) =>
        new Promise<google.maps.StreetViewPanoramaData | null>((resolve) => {
          service.getPanorama(
            {
              location,
              radius,
              preference: google.maps.StreetViewPreference.NEAREST,
              sources: [google.maps.StreetViewSource.GOOGLE, google.maps.StreetViewSource.OUTDOOR],
            },
            (data, status) => {
              resolve(
                status === google.maps.StreetViewStatus.OK && data?.location?.latLng
                  ? data
                  : null
              );
            }
          );
        });

      let chosen = await requestPanorama(position);

      /*
       * Street View candidate selection
       *
       * Google can return several nearby road panoramas. The physically
       * nearest panorama is not always the storefront side of the venue.
       *
       * Prefer panoramas whose Google description matches the venue's street
       * address, then use physical distance as the tie-breaker.
       */
      const bearings = [0, 45, 90, 135, 180, 225, 270, 315];
      const searchDistances = [5, 8, 12, 15, 20, 25, 30, 35, 40, 50];

      const normalize = (value?: string | null) =>
        (value ?? "")
          .toLowerCase()
          .replace(/\b(avenue)\b/g, "ave")
          .replace(/\b(street)\b/g, "st")
          .replace(/\b(road)\b/g, "rd")
          .replace(/\b(boulevard)\b/g, "blvd")
          .replace(/\b(drive)\b/g, "dr")
          .replace(/\b(lane)\b/g, "ln")
          .replace(/\b(court)\b/g, "ct")
          .replace(/\b(place)\b/g, "pl")
          .replace(/[^a-z0-9]/g, "");

      const venueAddress = normalize(venue.street_address);

      const addressMatches = (
        candidate: google.maps.StreetViewPanoramaData | null
      ) => {
        if (!candidate?.location?.description || !venueAddress) return false;

        const description = normalize(candidate.location.description);

        return (
          description.includes(venueAddress) ||
          venueAddress.includes(description)
        );
      };

      let best: google.maps.StreetViewPanoramaData | null = null;
      let bestAddressMatch = false;
      let bestDistance = Infinity;

      const seenPanos = new Set<string>();

      const considerCandidate = (
        candidate: google.maps.StreetViewPanoramaData | null
      ) => {
        if (!candidate?.location?.latLng || !candidate.links?.length) return;

        const panoId = candidate.location.pano;

        if (panoId && seenPanos.has(panoId)) return;
        if (panoId) seenPanos.add(panoId);

        const distance =
          google.maps.geometry.spherical.computeDistanceBetween(
            candidate.location.latLng,
            position
          );

        if (distance > 90) return;

        const match = addressMatches(candidate);

        if (
          best === null ||
          (match && !bestAddressMatch) ||
          (match === bestAddressMatch && distance < bestDistance)
        ) {
          best = candidate;
          bestAddressMatch = match;
          bestDistance = distance;
        }
      };

      considerCandidate(chosen);

      for (const searchDistance of searchDistances) {
        for (const bearing of bearings) {
          const searchPoint = google.maps.geometry.spherical.computeOffset(
            position,
            searchDistance,
            bearing
          );

          const candidate = await requestPanorama(searchPoint, 12);
          considerCandidate(candidate);
        }
      }

      const selectedPanorama =
        best as google.maps.StreetViewPanoramaData | null;

      console.log("Chosen Street View", venue.name, {
        pano: selectedPanorama?.location?.pano ?? null,
        description: selectedPanorama?.location?.description ?? null,
        distance: Number.isFinite(bestDistance) ? bestDistance : null,
        addressMatch: bestAddressMatch,
      });

      if (cancelled || !visualRef.current) return;

      if (selectedPanorama?.location?.latLng && selectedPanorama.links?.length) {
        new StreetViewPanorama(visualRef.current, {
          position: selectedPanorama.location.latLng,
          pov: {
            heading: google.maps.geometry.spherical.computeHeading(
              selectedPanorama.location.latLng,
              position
            ),
            pitch: 0,
          },
          zoom: 1,
          addressControl: false,
          linksControl: true,
          panControl: true,
          enableCloseButton: false,
          fullscreenControl: false,
        });

        return;
      }

      const { Map } = await importLibrary("maps") as google.maps.MapsLibrary;
      const { AdvancedMarkerElement } =
        await importLibrary("marker") as google.maps.MarkerLibrary;
      
      const map = new Map(visualRef.current, {
        center: position,
        zoom: 16,
        mapId: "DEMO_MAP_ID",
        streetViewControl: true,
        mapTypeControl: false,
        fullscreenControl: false,
      });

      new AdvancedMarkerElement({
        map,
        position,
        title: venue.name,
      });
    }

    init();

    return () => {
      cancelled = true;
    };
  }, [venue.latitude, venue.longitude, venue.name]);

  if (venue.latitude == null || venue.longitude == null) {
    return (
      <div className="map-placeholder roadmap">
        <span className="map-label">Map unavailable</span>
        <strong>{venue.name}</strong>
        <small>{venue.street_address}</small>
      </div>
    );
  }

  return (
    <div
      ref={visualRef}
      className="venue-google-map"
      aria-label={`Street View or map for ${venue.name}`}
    />
  );
}
