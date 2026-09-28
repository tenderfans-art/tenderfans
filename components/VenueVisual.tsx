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

let configured = false;

export default function VenueVisual({
  venue,
  streetViewStart,
}: {
  venue: VenueVisualVenue;
  streetViewStart?: StreetViewStart | null;
}) {
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

      /*
       * Spot profile pages start with the panorama Google's Street View
       * metadata service associates with the venue's verified address.
       *
       * From there, walk Google's actual Street View road links toward
       * the venue. At each step, move only to a linked panorama that is
       * physically closer to the venue. Stop as soon as no link improves
       * the distance.
       *
       * This keeps us on Google's address-selected road sequence instead
       * of probing arbitrary coordinates around the building.
       */
      if (streetViewStart?.panoId) {
        const getPanoramaById = (pano: string) =>
          new Promise<google.maps.StreetViewPanoramaData | null>(
            (resolve) => {
              service.getPanorama(
                { pano },
                (data, status) => {
                  resolve(
                    status === google.maps.StreetViewStatus.OK &&
                      data?.location?.latLng
                      ? data
                      : null
                  );
                }
              );
            }
          );

        const distanceToVenue = (
          data: google.maps.StreetViewPanoramaData
        ) =>
          google.maps.geometry.spherical.computeDistanceBetween(
            data.location!.latLng!,
            position
          );

        let current = await getPanoramaById(
          streetViewStart.panoId
        );

        if (current?.location?.latLng) {
          const visited = new Set<string>();

          let currentDistance =
            distanceToVenue(current);

          const startDistance = currentDistance;
          let steps = 0;

          while (steps < 10) {
            const currentPano =
              current.location?.pano;

            if (!currentPano) break;

            visited.add(currentPano);

            let next:
              | google.maps.StreetViewPanoramaData
              | null = null;

            let nextDistance = currentDistance;

            for (const link of current.links ?? []) {
              if (
                !link.pano ||
                visited.has(link.pano)
              ) {
                continue;
              }

              const candidate =
                await getPanoramaById(link.pano);

              if (!candidate?.location?.latLng) {
                continue;
              }

              const candidateDistance =
                distanceToVenue(candidate);

              if (candidateDistance < nextDistance) {
                next = candidate;
                nextDistance = candidateDistance;
              }
            }

            if (!next) {
              break;
            }

            current = next;
            currentDistance = nextDistance;
            steps += 1;
          }

          const selectedPosition =
            current.location!.latLng!;

          const selectedPano =
            current.location?.pano;

          const coordinateHeading =
            google.maps.geometry.spherical.computeHeading(
              selectedPosition,
              position
            );

          const normalizeHeading = (heading: number) =>
            ((heading % 360) + 360) % 360;

          const headingDifference = (
            a: number,
            b: number
          ) => {
            const diff = Math.abs(
              normalizeHeading(a) - normalizeHeading(b)
            );
            return Math.min(diff, 360 - diff);
          };

          /*
           * TEMP FRAMING DIAGNOSTIC
           *
           * Street View link headings describe the road direction from
           * this panorama. Use the first usable road link to infer the
           * road axis, then compare the two perpendicular directions
           * against the venue-coordinate heading.
           */
          const roadLink = (current.links ?? []).find(
            (link) => link.heading != null
          );

          const roadHeading =
            roadLink?.heading ?? null;

          let storefrontHeading:
            | number
            | null = null;

          if (roadHeading != null) {
            const sideA =
              normalizeHeading(roadHeading + 90);
            const sideB =
              normalizeHeading(roadHeading - 90);

            storefrontHeading =
              headingDifference(
                sideA,
                coordinateHeading
              ) <=
              headingDifference(
                sideB,
                coordinateHeading
              )
                ? sideA
                : sideB;
          }

          const storefrontDifference =
            storefrontHeading != null
              ? headingDifference(
                  coordinateHeading,
                  storefrontHeading
                )
              : Infinity;

          const finalHeading =
            storefrontHeading != null &&
            storefrontDifference <= 30
              ? storefrontHeading
              : coordinateHeading;

          console.log(
            "Address Street View walk",
            venue.name,
            {
              startPano: streetViewStart.panoId,
              startDistance,
              selectedPano,
              description:
                current.location?.description ?? null,
              selectedDistance: currentDistance,
              steps,
              visited: Array.from(visited),
              heading:
                google.maps.geometry.spherical.computeHeading(
                  selectedPosition,
                  position
                ),
            }
          );

          if (
            !cancelled &&
            visualRef.current &&
            selectedPano
          ) {
            new StreetViewPanorama(
              visualRef.current,
              {
                pano: selectedPano,
                pov: {
                  heading: finalHeading,
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
        }
      }

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

          const candidate = await requestPanorama(searchPoint, 5);
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
  }, [
    venue.latitude,
    venue.longitude,
    venue.name,
    streetViewStart?.panoId,
    streetViewStart?.latitude,
    streetViewStart?.longitude,
  ]);

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
