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

      if (chosen?.location?.latLng) {
        const naturalDistance = google.maps.geometry.spherical.computeDistanceBetween(
          chosen.location.latLng,
          position
        );

        if (!chosen.links?.length) {
          const bearings = [0, 45, 90, 135, 180, 225, 270, 315];
          const searchDistances = [15, 25, 35, 50];

          let best: google.maps.StreetViewPanoramaData | null = null;
          let bestScore = Infinity;

          for (const searchDistance of searchDistances) {
            for (const bearing of bearings) {
              const searchPoint = google.maps.geometry.spherical.computeOffset(
                position,
                searchDistance,
                bearing
              );

              const candidate = await requestPanorama(searchPoint, 12);

              if (!candidate?.location?.latLng || !candidate.links?.length) continue;

              const distance = google.maps.geometry.spherical.computeDistanceBetween(
                candidate.location.latLng,
                position
              );

              if (distance > 90) continue;

              const score = distance;

              if (score < bestScore) {
                best = candidate;
                bestScore = score;
              }
            }
          }

          chosen = best;
        }
      }

      console.log("Chosen panorama FULL", venue.name, chosen);
      console.log("Chosen distance", venue.name, chosen?.location?.latLng ? google.maps.geometry.spherical.computeDistanceBetween(chosen.location.latLng, position) : null);
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
