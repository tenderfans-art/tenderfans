"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

type RandomSpot = {
  id: string;
  slug: string;
  name: string;
  city: string | null;
  state: string | null;
  photoUrl: string | null;
};

function shuffle<T>(items: T[]) {
  const copy = [...items];

  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy;
}

export default function GoodTimesRandom() {
  const [pool, setPool] = useState<RandomSpot[]>([]);
  const [spots, setSpots] = useState<RandomSpot[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const loadedRef = useRef(false);

  async function loadPool() {
    if (loadedRef.current) return pool;

    setLoading(true);

    const { data: venueRows, error } = await supabase
      .from("venues")
      .select("id, slug, name, city, state_region")
      .eq("status", "active")
      .not("slug", "is", null)
      .limit(100);

    if (error || !venueRows?.length) {
      console.error("Could not load random Spots", error);
      setLoading(false);
      return [];
    }

    const venueIds = venueRows.map((venue) => venue.id);

    const { data: photos, error: photoError } = await supabase
      .from("media_assets")
      .select("venue_id, storage_path, sort_order, created_at")
      .eq("entity_kind", "venue")
      .eq("media_type", "photo")
      .eq("status", "published")
      .in("venue_id", venueIds)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false });

    if (photoError) {
      console.error("Could not load Spot photos", photoError);
    }

    const photoByVenue = new Map<string, string>();

    for (const photo of photos ?? []) {
      if (!photo.venue_id || photoByVenue.has(photo.venue_id)) continue;

      const url = supabase.storage
        .from("spot-media")
        .getPublicUrl(photo.storage_path).data.publicUrl;

      photoByVenue.set(photo.venue_id, url);
    }

    const nextPool: RandomSpot[] = venueRows.map((venue) => ({
      id: venue.id,
      slug: venue.slug,
      name: venue.name,
      city: venue.city ?? null,
      state: venue.state_region ?? null,
      photoUrl: photoByVenue.get(venue.id) ?? null,
    }));

    loadedRef.current = true;
    setPool(nextPool);
    setLoading(false);

    return nextPool;
  }

  async function handleGoodTimes() {
    const available = pool.length ? pool : await loadPool();

    if (!available.length) return;

    setSpots(shuffle(available).slice(0, 5));
    setOpen(true);
  }

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    window.addEventListener("keydown", handleEscape);

    return () => window.removeEventListener("keydown", handleEscape);
  }, []);

  return (
    <>
      <button
        type="button"
        className="landing-hotspot good-times-hotspot"
        aria-label="Discover five random Spots"
        onClick={handleGoodTimes}
      >
        <span className="sr-only">Discover five random Spots</span>
      </button>

      {open && (
        <div
          className="good-times-backdrop"
          onClick={() => setOpen(false)}
        >
          <section
            className="good-times-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="good-times-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="good-times-heading">
              <div>
                <span className="eyebrow">Good Times</span>
                <h2 id="good-times-title">Find somewhere new.</h2>
              </div>

              <button
                type="button"
                className="good-times-close"
                aria-label="Close"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>

            <div className="good-times-grid">
              {spots.map((spot) => (
                <Link
                  key={spot.id}
                  href={`/spots/${spot.slug}`}
                  className="good-times-card"
                >
                  <div className="good-times-photo">
                    {spot.photoUrl ? (
                      <img src={spot.photoUrl} alt="" />
                    ) : (
                      <span>{spot.name.slice(0, 1)}</span>
                    )}
                  </div>

                  <div className="good-times-copy">
                    <strong>{spot.name}</strong>

                    {(spot.city || spot.state) && (
                      <span>
                        {[spot.city, spot.state]
                          .filter(Boolean)
                          .join(", ")}
                      </span>
                    )}
                  </div>
                </Link>
              ))}
            </div>

            <button
              type="button"
              className="btn secondary good-times-again"
              onClick={handleGoodTimes}
              disabled={loading}
            >
              Show me 5 more
            </button>
          </section>
        </div>
      )}
    </>
  );
}
