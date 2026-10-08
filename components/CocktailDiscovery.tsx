"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { readDiscoveryRadius } from "@/lib/discovery-radius";

const COCKTAILS = [
  { name: "Margarita", trait: "Makes the Best Margarita" },
  { name: "Martini", trait: "Makes the Best Martini" },
  { name: "Beach Cocktail", trait: "Makes the Best Beach Cocktail" },
  { name: "Mojito", trait: "Makes the Best Mojito" },
  { name: "Old Fashioned / Manhattan", trait: "Makes the Best Old Fashioned / Manhattan" },
] as const;

type Candidate = {
  id: string;
  slug: string;
  name: string;
  spot: string;
  city: string;
  distance: number;
  recognized: boolean;
};

function milesBetween(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
) {
  const rad = (degrees: number) => degrees * Math.PI / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) *
    Math.sin(dLng / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(Math.min(1, h)));
}

function shuffled<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export default function CocktailDiscovery() {
  const [selected, setSelected] = useState<(typeof COCKTAILS)[number] | null>(null);
  const [radius, setRadius] = useState<number | null>(15);
  const [pool, setPool] = useState<Candidate[]>([]);
  const [results, setResults] = useState<Candidate[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const requestId = useRef(0);

  function chooseEight(candidates: Candidate[]) {
    const recognized = shuffled(candidates.filter(t => t.recognized));
    const others = shuffled(candidates.filter(t => !t.recognized));
    return [...recognized.slice(0, 8), ...others.slice(0, Math.max(0, 8 - recognized.length))];
  }

  function close() {
    requestId.current += 1;
    setSelected(null);
    setPool([]);
    setResults([]);
  }

  useEffect(() => {
    if (!selected) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selected]);

  async function openCocktail(cocktail: (typeof COCKTAILS)[number]) {
    const currentRequest = ++requestId.current;
    const selectedRadius = readDiscoveryRadius();
    setRadius(selectedRadius);
    setSelected(cocktail);
    setStatus("loading");
    setMessage("");
    setPool([]);
    setResults([]);

    if (!navigator.geolocation) {
      setStatus("error");
      setMessage("Your browser does not support location access.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async position => {
        try {
          const { latitude, longitude } = position.coords;

          const { data: venues, error: venueError } = await supabase
            .from("venues")
            .select("id,name,city,latitude,longitude")
            .eq("status", "active");

          if (venueError) throw venueError;

          const nearbyVenues = new Map<string, {
            name: string; city: string; distance: number;
          }>();

          for (const venue of venues ?? []) {
            if (venue.latitude == null || venue.longitude == null) continue;
            const distance = milesBetween(
              latitude, longitude, venue.latitude, venue.longitude
            );
            if (selectedRadius !== null && distance > selectedRadius) continue;
            nearbyVenues.set(venue.id, {
              name: venue.name,
              city: venue.city ?? "",
              distance,
            });
          }

          if (!nearbyVenues.size) {
            if (currentRequest !== requestId.current) return;
            setStatus("ready");
            return;
          }

          const { data: relationships, error: relationshipError } = await supabase
            .from("bartender_venues")
            .select("bartender_id,venue_id,is_primary")
            .eq("is_current", true)
            .in("venue_id", [...nearbyVenues.keys()]);

          if (relationshipError) throw relationshipError;

          const preferredSpot = new Map<string, {
            name: string; city: string; distance: number; primary: boolean;
          }>();

          for (const relationship of relationships ?? []) {
            const spot = nearbyVenues.get(relationship.venue_id);
            if (!spot) continue;
            const previous = preferredSpot.get(relationship.bartender_id);
            if (!previous ||
              (relationship.is_primary && !previous.primary) ||
              (Boolean(relationship.is_primary) === previous.primary &&
                spot.distance < previous.distance)
            ) {
              preferredSpot.set(relationship.bartender_id, {
                ...spot, primary: Boolean(relationship.is_primary),
              });
            }
          }

          const ids = [...preferredSpot.keys()];
          if (!ids.length) {
            if (currentRequest !== requestId.current) return;
            setStatus("ready");
            return;
          }

          const [{ data: tenders, error: tenderError },
            { data: traits, error: traitError }] = await Promise.all([
            supabase.from("bartenders")
              .select("id,slug,display_name")
              .eq("status", "active")
              .in("id", ids),
            supabase.from("traits")
              .select("id")
              .eq("label", cocktail.trait)
              .eq("active", true),
          ]);

          if (tenderError) throw tenderError;
          if (traitError) throw traitError;

          const traitId = traits?.[0]?.id;
          const recognizedIds = new Set<string>();

          if (traitId != null) {
            const { data: awarded, error: awardedError } = await supabase
              .from("shoutout_traits")
              .select("shoutouts!inner(bartender_id,status)")
              .eq("trait_id", traitId)
              .eq("shoutouts.status", "published")
              .in("shoutouts.bartender_id", ids);

            if (awardedError) throw awardedError;

            for (const row of awarded ?? []) {
              const raw = (row as any).shoutouts;
              const shout = Array.isArray(raw) ? raw[0] : raw;
              if (shout?.bartender_id) recognizedIds.add(shout.bartender_id);
            }
          }

          const candidates: Candidate[] = (tenders ?? []).flatMap(tender => {
            const spot = preferredSpot.get(tender.id);
            if (!spot || !tender.slug) return [];
            return [{
              id: tender.id,
              slug: tender.slug,
              name: tender.display_name,
              spot: spot.name,
              city: spot.city,
              distance: spot.distance,
              recognized: recognizedIds.has(tender.id),
            }];
          });

          if (currentRequest !== requestId.current) return;
          setPool(candidates);
          setResults(chooseEight(candidates));
          setStatus("ready");
        } catch (error) {
          console.error("Cocktail discovery:", error);
          if (currentRequest !== requestId.current) return;
          setStatus("error");
          setMessage("Unable to load nearby Tenders. Please try again.");
        }
      },
      () => {
        if (currentRequest !== requestId.current) return;
        setStatus("error");
        setMessage("Allow location access to discover nearby Tenders.");
      },
      { enableHighAccuracy: false, timeout: 12000 }
    );
  }

  return (
    <>
      <section className="cocktail-discovery" aria-label="Cocktail discovery">
        <div className="cocktail-eyebrow">Find Your Perfect Pour; Search Tenders By Their Specialties</div>
        <div className="cocktail-tiles">
          {COCKTAILS.map((cocktail, index) => (
            <button
              key={cocktail.trait}
              type="button"
              className={`cocktail-tile ${index === 4 ? "cocktail-tile-last" : ""}`}
              onClick={() => void openCocktail(cocktail)}
            >
              Best {cocktail.name}
            </button>
          ))}
        </div>
      </section>

      {selected && (
        <div
          className="cocktail-modal-backdrop"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <section
            className="cocktail-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Best ${selected.name} Tenders`}
          >
            <button
              type="button"
              className="cocktail-modal-close"
              onClick={close}
              aria-label="Close"
            >×</button>
            <div className="cocktail-eyebrow">Find your perfect pour</div>
            <h2>Best {selected.name}</h2>
            <p className="cocktail-modal-subtitle">
              {radius === null ? "All distances" : `Within ${radius} miles`}

            </p>

            {status === "loading" && (
              <p className="cocktail-modal-message">Finding Tenders near you...</p>
            )}
            {status === "error" && (
              <p className="cocktail-modal-message" role="alert">{message}</p>
            )}
            {status === "ready" && results.length === 0 && (
              <p className="cocktail-modal-message">
                No eligible Tenders found in this area yet.
              </p>
            )}
            {status === "ready" && results.length > 0 && (
              <>
                <div className="cocktail-modal-results">
                  {results.map(tender => (
                    <Link
                      key={tender.id}
                      href={`/t/${tender.slug}`}
                      className="cocktail-modal-tender"
                    >
                      <span className="cocktail-modal-kicker">
                        {tender.recognized
                          ? `Recognized for ${selected.name}`
                          : "More Tenders Near You"}
                      </span>
                      <strong>{tender.name}</strong>
                      <small>
                        {tender.spot}
                        {tender.city ? ` · ${tender.city}` : ""}
                        {` · ${tender.distance.toFixed(1)} mi`}
                      </small>
                    </Link>
                  ))}
                </div>
                <button
                  type="button"
                  className="cocktail-refresh"
                  onClick={() => setResults(chooseEight(pool))}
                >
                  Show me 8 more
                </button>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
