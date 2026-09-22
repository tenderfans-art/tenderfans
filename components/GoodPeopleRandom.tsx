"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

type RandomTender = {
  id: string;
  slug: string;
  name: string;
  spotName: string | null;
  city: string | null;
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

export default function GoodPeopleRandom() {
  const [pool, setPool] = useState<RandomTender[]>([]);
  const [tenders, setTenders] = useState<RandomTender[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const loadedRef = useRef(false);

  async function loadPool() {
    if (loadedRef.current) return pool;

    setLoading(true);

    const { data: bartenderRows, error } = await supabase
      .from("bartenders")
      .select("id, slug, display_name")
      .eq("status", "active")
      .not("slug", "is", null)
      .limit(100);

    if (error || !bartenderRows?.length) {
      console.error("Could not load random Tenders", error);
      setLoading(false);
      return [];
    }

    const bartenderIds = bartenderRows.map((row) => row.id);

    const [{ data: relationships }, { data: photos }] = await Promise.all([
      supabase
        .from("bartender_venues")
        .select("bartender_id, venue_id, is_primary")
        .in("bartender_id", bartenderIds)
        .eq("is_current", true),

      supabase
        .from("media_assets")
        .select("bartender_id, storage_path, created_at")
        .eq("entity_kind", "bartender")
        .eq("media_type", "photo")
        .eq("is_hero", true)
        .eq("status", "published")
        .in("bartender_id", bartenderIds)
        .order("created_at", { ascending: false }),
    ]);

    const venueIds = [
      ...new Set(
        (relationships ?? [])
          .map((row) => row.venue_id)
          .filter(Boolean)
      ),
    ];

    const { data: venues } = venueIds.length
      ? await supabase
          .from("venues")
          .select("id, name, city")
          .in("id", venueIds)
          .eq("status", "active")
      : { data: [] };

    const venueById = new Map(
      (venues ?? []).map((venue) => [venue.id, venue])
    );

    const relationshipByTender = new Map<string, any>();

    for (const relationship of relationships ?? []) {
      const current = relationshipByTender.get(relationship.bartender_id);

      if (!current || relationship.is_primary) {
        relationshipByTender.set(
          relationship.bartender_id,
          relationship
        );
      }
    }

    const photoByTender = new Map<string, string>();

    for (const photo of photos ?? []) {
      if (!photo.bartender_id || photoByTender.has(photo.bartender_id)) {
        continue;
      }

      const url = supabase.storage
        .from("spot-media")
        .getPublicUrl(photo.storage_path).data.publicUrl;

      photoByTender.set(photo.bartender_id, url);
    }

    const nextPool: RandomTender[] = bartenderRows.map((bartender) => {
      const relationship = relationshipByTender.get(bartender.id);
      const venue = relationship
        ? venueById.get(relationship.venue_id)
        : null;

      return {
        id: bartender.id,
        slug: bartender.slug,
        name: bartender.display_name,
        spotName: venue?.name ?? null,
        city: venue?.city ?? null,
        photoUrl: photoByTender.get(bartender.id) ?? null,
      };
    });

    loadedRef.current = true;
    setPool(nextPool);
    setLoading(false);

    return nextPool;
  }

  async function handleGoodPeople() {
    const available = pool.length ? pool : await loadPool();

    if (!available.length) return;

    setTenders(shuffle(available).slice(0, 5));
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
        className="landing-hotspot good-people-hotspot"
        aria-label="Discover five random Tenders"
        onClick={handleGoodPeople}
      >
        <span className="sr-only">Discover five random Tenders</span>
      </button>

      {open && (
        <div
          className="good-people-backdrop"
          onClick={() => setOpen(false)}
        >
          <section
            className="good-people-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="good-people-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="good-people-heading">
              <div>
                <span className="eyebrow">Good People</span>
                <h2 id="good-people-title">Meet some Tenders.</h2>
              </div>

              <button
                type="button"
                className="good-people-close"
                aria-label="Close"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>

            <div className="good-people-grid">
              {tenders.map((tender) => (
                <Link
                  key={tender.id}
                  href={`/t/${tender.slug}`}
                  className="good-people-card"
                >
                  <div className="good-people-photo">
                    {tender.photoUrl ? (
                      <img src={tender.photoUrl} alt="" />
                    ) : (
                      <span>{tender.name.slice(0, 1)}</span>
                    )}
                  </div>

                  <div className="good-people-copy">
                    <strong>{tender.name}</strong>

                    {tender.spotName && (
                      <span>
                        {tender.spotName}
                        {tender.city ? ` · ${tender.city}` : ""}
                      </span>
                    )}
                  </div>
                </Link>
              ))}
            </div>

            <button
              type="button"
              className="btn secondary good-people-again"
              onClick={handleGoodPeople}
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
