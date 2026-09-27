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
       * Google's single NEAREST result is not always the useful street-facing
       * panorama. Search around the venue as well and keep the connected
       * Google panorama whose actual camera position is closest to the venue.
       *
       * This generalizes the recovery logic previously used for cases such as
       * The Galley and avoids venue-specific Street View overrides.
       */
      const bearings = [0, 45, 90, 135, 180, 225, 270, 315];
      const searchDistances = [15, 25, 35, 50];

      let best: google.maps.StreetViewPanoramaData | null =
        chosen?.location?.latLng && chosen.links?.length ? chosen : null;

      let bestScore =
        best?.location?.latLng
          ? google.maps.geometry.spherical.computeDistanceBetween(
              best.location.latLng,
              position
            )
          : Infinity;

      const seenPanos = new Set<string>();

      if (best?.location?.pano) {
        seenPanos.add(best.location.pano);
      }

      for (const searchDistance of searchDistances) {
        for (const bearing of bearings) {
          const searchPoint = google.maps.geometry.spherical.computeOffset(
            position,
            searchDistance,
            bearing
          );

          const candidate = await requestPanorama(searchPoint, 12);

          if (!candidate?.location?.latLng || !candidate.links?.length) continue;

          const panoId = candidate.location.pano;

          if (panoId && seenPanos.has(panoId)) continue;
          if (panoId) seenPanos.add(panoId);

          const distance =
            google.maps.geometry.spherical.computeDistanceBetween(
              candidate.location.latLng,
              position
            );

          // Reject panoramas that are clearly unrelated to the venue.
          if (distance > 90) continue;

          if (distance < bestScore) {
            best = candidate;
            bestScore = distance;
          }
        }
      }

      chosen = best;

      console.log(
        "Chosen Street View",
        venue.name,
        {
          pano: chosen?.location?.pano ?? null,
          lat: chosen?.location?.latLng?.lat() ?? null,
          lng: chosen?.location?.latLng?.lng() ?? null,
          distance: Number.isFinite(bestScore) ? bestScore : null,
        }
      );

      if (venue.name.toLowerCase().includes("enigma")) {
        const knownGood = await requestPanorama(
          { lat: 27.771065, lng: -82.650218 },
          12
        );

        console.log("ENIGMA CURRENT", {
          pano: chosen?.location?.pano ?? null,
          description: chosen?.location?.description ?? null,
          links: chosen?.links ?? [],
        });

        console.log("ENIGMA KNOWN GOOD", {
          pano: knownGood?.location?.pano ?? null,
          lat: knownGood?.location?.latLng?.lat() ?? null,
          lng: knownGood?.location?.latLng?.lng() ?? null,
          description: knownGood?.location?.description ?? null,
          links: knownGood?.links ?? [],
          distanceFromVenue: knownGood?.location?.latLng
            ? google.maps.geometry.spherical.computeDistanceBetween(
                knownGood.location.latLng,
                position
              )
            : null,
        });
      }

      if (cancelled || !visualRef.current) return;

      if (chosen?.location?.latLng && chosen.links?.length) {
        new StreetViewPanorama(visualRef.current, {
          position: chosen.location.latLng,
          pov: {
            heading: google.maps.geometry.spherical.computeHeading(
              chosen.location.latLng,
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
