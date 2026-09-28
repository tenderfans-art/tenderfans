"use client";

import { useEffect, useRef } from "react";
import { importLibrary, setOptions } from "@googlemaps/js-api-loader";

type VenueVisualVenue = {
  name: string;
  street_address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

type StreetViewStart = {
  panoId: string;
  latitude: number;
  longitude: number;
};

type VenueVisualProps = {
  venue: VenueVisualVenue;
  streetViewStart?: StreetViewStart | null;
};

let configured = false;

export default function VenueVisual({
  venue,
  streetViewStart,
}: VenueVisualProps) {
  const visualRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (
      !visualRef.current ||
      venue.latitude == null ||
      venue.longitude == null
    ) {
      return;
    }

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

      const position = {
        lat: venue.latitude!,
        lng: venue.longitude!,
      };

      const { StreetViewService, StreetViewPanorama } =
        (await importLibrary(
          "streetView"
        )) as google.maps.StreetViewLibrary;

      const service = new StreetViewService();

      const requestPanoramaAtLocation = (
        location:
          | google.maps.LatLng
          | google.maps.LatLngLiteral,
        radius = 75
      ) =>
        new Promise<google.maps.StreetViewPanoramaData | null>(
          (resolve) => {
            service.getPanorama(
              {
                location,
                radius,
                preference:
                  google.maps.StreetViewPreference.NEAREST,
                sources: [
                  google.maps.StreetViewSource.GOOGLE,
                  google.maps.StreetViewSource.OUTDOOR,
                ],
              },
              (data, status) => {
                resolve(
                  status ===
                    google.maps.StreetViewStatus.OK &&
                    data?.location?.latLng
                    ? data
                    : null
                );
              }
            );
          }
        );

      const requestPanoramaById = (pano: string) =>
        new Promise<google.maps.StreetViewPanoramaData | null>(
          (resolve) => {
            service.getPanorama(
              {
                pano,
                sources: [
                  google.maps.StreetViewSource.GOOGLE,
                  google.maps.StreetViewSource.OUTDOOR,
                ],
              },
              (data, status) => {
                resolve(
                  status ===
                    google.maps.StreetViewStatus.OK &&
                    data?.location?.latLng
                    ? data
                    : null
                );
              }
            );
          }
        );

      const normalizeStreet = (
        value?: string | null
      ) =>
        (value ?? "")
          .toLowerCase()
          .replace(/^\s*\d+[a-z]?\s+/i, "")
          .replace(/\b(avenue)\b/g, "ave")
          .replace(/\b(street)\b/g, "st")
          .replace(/\b(road)\b/g, "rd")
          .replace(/\b(boulevard)\b/g, "blvd")
          .replace(/\b(drive)\b/g, "dr")
          .replace(/\b(lane)\b/g, "ln")
          .replace(/\b(court)\b/g, "ct")
          .replace(/\b(place)\b/g, "pl")
          .replace(/\b(terrace)\b/g, "ter")
          .replace(/\b(highway)\b/g, "hwy")
          .replace(/[^a-z0-9]/g, "");

      const venueStreet = normalizeStreet(
        venue.street_address
      );

      const streetMatches = (
        candidate:
          | google.maps.StreetViewPanoramaData
          | null
      ) => {
        if (
          !candidate?.location?.description ||
          !venueStreet
        ) {
          return false;
        }

        const descriptionStreet = normalizeStreet(
          candidate.location.description.split(",")[0]
        );

        return (
          descriptionStreet.includes(venueStreet) ||
          venueStreet.includes(descriptionStreet)
        );
      };

      const distanceToVenue = (
        candidate: google.maps.StreetViewPanoramaData
      ) =>
        google.maps.geometry.spherical.computeDistanceBetween(
          candidate.location!.latLng!,
          position
        );

      /*
       * Preferred path for Spot profile pages:
       *
       * The server asks Google's Street View metadata endpoint to
       * resolve the venue's verified postal address. That gives us a
       * starting panorama on the street Google associates with the
       * address.
       *
       * From there, follow Google's real Street View links rather than
       * probing arbitrary coordinates around the building.
       */
      let selectedPanorama:
        | google.maps.StreetViewPanoramaData
        | null = null;

      if (streetViewStart?.panoId) {
        const start = await requestPanoramaById(
          streetViewStart.panoId
        );

        if (start) {
          const queue: Array<{
            pano: google.maps.StreetViewPanoramaData;
            depth: number;
          }> = [{ pano: start, depth: 0 }];

          const visited = new Set<string>();

          let bestAny:
            | google.maps.StreetViewPanoramaData
            | null = null;
          let bestAnyDistance = Infinity;

          let bestStreet:
            | google.maps.StreetViewPanoramaData
            | null = null;
          let bestStreetDistance = Infinity;

          const maxDepth = 6;
          const maxVisited = 24;

          while (
            queue.length &&
            visited.size < maxVisited
          ) {
            const current = queue.shift()!;
            const panoId =
              current.pano.location?.pano;

            if (!panoId || visited.has(panoId)) {
              continue;
            }

            visited.add(panoId);

            if (!current.pano.location?.latLng) {
              continue;
            }

            const distance = distanceToVenue(
              current.pano
            );

            if (distance < bestAnyDistance) {
              bestAny = current.pano;
              bestAnyDistance = distance;
            }

            if (
              streetMatches(current.pano) &&
              distance < bestStreetDistance
            ) {
              bestStreet = current.pano;
              bestStreetDistance = distance;
            }

            if (current.depth >= maxDepth) {
              continue;
            }

            for (const link of current.pano.links ?? []) {
              if (
                !link.pano ||
                visited.has(link.pano)
              ) {
                continue;
              }

              const linked =
                await requestPanoramaById(link.pano);

              if (linked) {
                queue.push({
                  pano: linked,
                  depth: current.depth + 1,
                });
              }

              if (visited.size + queue.length >= maxVisited) {
                break;
              }
            }
          }

          selectedPanorama =
            bestStreet ?? bestAny;

          console.log(
            "Street View graph result",
            venue.name,
            {
              startPano: streetViewStart.panoId,
              selectedPano:
                selectedPanorama?.location?.pano ??
                null,
              description:
                selectedPanorama?.location
                  ?.description ?? null,
              distance: selectedPanorama
                ? distanceToVenue(selectedPanorama)
                : null,
              streetMatch: selectedPanorama
                ? streetMatches(selectedPanorama)
                : false,
              visited: visited.size,
            }
          );
        }
      }

      /*
       * Fallback path.
       *
       * Used by lightweight card renders and whenever the server-side
       * address lookup cannot produce a starting panorama.
       */
      if (!selectedPanorama) {
        let chosen =
          await requestPanoramaAtLocation(position);

        const bearings = [
          0, 45, 90, 135, 180, 225, 270, 315,
        ];
        const searchDistances = [
          5, 8, 12, 15, 20, 25, 30, 35, 40, 50,
        ];

        let best:
          | google.maps.StreetViewPanoramaData
          | null = null;
        let bestStreetMatch = false;
        let bestDistance = Infinity;

        const seenPanos = new Set<string>();

        const considerCandidate = (
          candidate:
            | google.maps.StreetViewPanoramaData
            | null
        ) => {
          if (
            !candidate?.location?.latLng ||
            !candidate.links?.length
          ) {
            return;
          }

          const panoId = candidate.location.pano;

          if (
            panoId &&
            seenPanos.has(panoId)
          ) {
            return;
          }

          if (panoId) {
            seenPanos.add(panoId);
          }

          const distance =
            distanceToVenue(candidate);

          if (distance > 90) return;

          const match =
            streetMatches(candidate);

          if (
            best === null ||
            (match && !bestStreetMatch) ||
            (match === bestStreetMatch &&
              distance < bestDistance)
          ) {
            best = candidate;
            bestStreetMatch = match;
            bestDistance = distance;
          }
        };

        considerCandidate(chosen);

        for (const searchDistance of searchDistances) {
          for (const bearing of bearings) {
            const searchPoint =
              google.maps.geometry.spherical.computeOffset(
                position,
                searchDistance,
                bearing
              );

            const candidate =
              await requestPanoramaAtLocation(
                searchPoint,
                5
              );

            considerCandidate(candidate);
          }
        }

        selectedPanorama =
          best as google.maps.StreetViewPanoramaData | null;

        console.log(
          "Street View fallback result",
          venue.name,
          {
            pano:
              selectedPanorama?.location?.pano ??
              null,
            description:
              selectedPanorama?.location
                ?.description ?? null,
            distance: Number.isFinite(bestDistance)
              ? bestDistance
              : null,
            streetMatch: bestStreetMatch,
          }
        );
      }

      if (
        cancelled ||
        !visualRef.current
      ) {
        return;
      }

      if (
        selectedPanorama?.location?.latLng &&
        selectedPanorama.links?.length
      ) {
        new StreetViewPanorama(
          visualRef.current,
          {
            pano:
              selectedPanorama.location.pano,
            pov: {
              heading:
                google.maps.geometry.spherical.computeHeading(
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
          }
        );

        return;
      }

      const { Map } = (await importLibrary(
        "maps"
      )) as google.maps.MapsLibrary;

      const { AdvancedMarkerElement } =
        (await importLibrary(
          "marker"
        )) as google.maps.MarkerLibrary;

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
  }, [
    venue.latitude,
    venue.longitude,
    venue.name,
    venue.street_address,
    streetViewStart?.panoId,
  ]);

  if (
    venue.latitude == null ||
    venue.longitude == null
  ) {
    return (
      <div className="map-placeholder roadmap">
        <span className="map-label">
          Map unavailable
        </span>
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
