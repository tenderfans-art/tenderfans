"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useSearchParams } from "next/navigation";

type SpotResult = {
  id: string;
  slug: string;
  name: string;
  city: string;
  state_region: string;
  venue_type: string;
  tenderCount: number;
  shoutCount: number;
  latitude: number | null;
  longitude: number | null;
};

export default function HomeSearch({
  showDiscoverHeader = false,
}: {
  showDiscoverHeader?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [spots, setSpots] = useState<SpotResult[]>([]);
  const [loading, setLoading] = useState(true);
  const searchParams = useSearchParams();
  const view = searchParams.get("view");
  const isTrending = view === "trending";
  const isNearby = view === "nearby";
  const isRecent = view === "recent";
  const [nearbySpots, setNearbySpots] = useState<(SpotResult & { distance: number })[]>([]);
  const [locationStatus, setLocationStatus] = useState<"idle" | "loading" | "ready" | "denied" | "unsupported">("idle");
  const [recentShouts, setRecentShouts] = useState<any[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);

  useEffect(() => {
    async function loadSpots() {
      const { data, error } = await supabase
        .from("bartender_venues")
        .select(`
          venue_id,
          venues!inner(
            id,
            slug,
            name,
            city,
            state_region,
            venue_type,
            latitude,
            longitude,
            status
          )
        `)
        .eq("is_current", true)
        .eq("venues.status", "active");

      if (error) {
        console.error("TenderFans discovery search:", error);
        setSpots([]);
        setLoading(false);
        return;
      }

      const venueMap = new Map<string, SpotResult>();

      for (const row of data ?? []) {
        const venueData = (row as any).venues;
        const venue = Array.isArray(venueData)
          ? venueData[0]
          : venueData;

        if (!venue) continue;

        const existing = venueMap.get(venue.id);

        if (existing) {
          existing.tenderCount += 1;
        } else {
          venueMap.set(venue.id, {
            id: venue.id,
            slug: venue.slug,
            name: venue.name,
            city: venue.city ?? "",
            state_region: venue.state_region ?? "",
            venue_type: venue.venue_type ?? "bar",
            tenderCount: 1,
            shoutCount: 0,
            latitude: venue.latitude ?? null,
            longitude: venue.longitude ?? null,
          });
        }
      }
      
      const { data: shoutRows, error: shoutError } = await supabase
        .from("shoutouts")
        .select("venue_id")
        .eq("status", "published");

      if (shoutError) {
        console.error("TenderFans trending spots:", shoutError);
      }

      for (const row of shoutRows ?? []) {
        const spot = venueMap.get(row.venue_id);
        if (spot) spot.shoutCount += 1;
      }

      setSpots(
        [...venueMap.values()].sort((a, b) =>
          view === "trending"
            ? b.shoutCount - a.shoutCount || a.name.localeCompare(b.name)
            : a.name.localeCompare(b.name)
        )
      );

      setLoading(false);
    }

    loadSpots();
  }, [view]);
  
  useEffect(() => {
    if (!isRecent) return;

    async function loadRecentShouts() {
      setRecentLoading(true);

      const { data, error } = await supabase
        .from("shoutouts")
        .select(`
          id,
          created_at,
          bartender_id,
          venue_id,
          bartenders(
            slug,
            display_name
          ),
          venues(
            slug,
            name,
            city,
            state_region
          )
        `)
        .eq("status", "published")
        .order("created_at", { ascending: false })
        .limit(20);

      if (error) {
        console.error("TenderFans recent shouts:", error);
        setRecentShouts([]);
        setRecentLoading(false);
        return;
      }

      setRecentShouts(data ?? []);
      setRecentLoading(false);
    }

    loadRecentShouts();
  }, [isRecent]);

  useEffect(() => {
    if (!isNearby) return;

    if (!navigator.geolocation) {
      setLocationStatus("unsupported");
      return;
    }

    setLocationStatus("loading");

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const userLat = position.coords.latitude;
        const userLng = position.coords.longitude;

        const toRad = (value: number) => (value * Math.PI) / 180;

        const ranked = spots
          .filter((spot) => spot.latitude != null && spot.longitude != null)
          .map((spot) => {
            const earthRadiusMiles = 3958.8;
            const dLat = toRad(spot.latitude! - userLat);
            const dLng = toRad(spot.longitude! - userLng);
            const lat1 = toRad(userLat);
            const lat2 = toRad(spot.latitude!);

            const a =
              Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

            const distance =
              2 * earthRadiusMiles * Math.asin(Math.sqrt(a));

            return { ...spot, distance };
          })
          .sort((a, b) => a.distance - b.distance)
          .slice(0, 8);

        setNearbySpots(ranked);
        setLocationStatus("ready");
      },
      () => {
        setLocationStatus("denied");
      }
    );
  }, [isNearby, spots]);

  const matches = useMemo(() => {
    const normalize = (value: string) =>
      value
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\bsaint\b/g, "st")
        .replace(/\s+/g, " ")
        .trim();

    const q = normalize(query);

    if (!q) return view === "trending" ? spots.slice(0, 8) : [];

    return spots
      .filter((spot) =>
        normalize(`${spot.name} ${spot.city} ${spot.state_region} ${spot.venue_type}`).includes(q)
      )
      .slice(0, 8);
  }, [query, spots, view]);

  return (
    <div className="search-wrap">
      {isTrending && (
        <div className="section-title">
          <div>
            <span className="eyebrow">Trending Spots</span>
            <h2>Most shouted-about spots</h2>
          </div>
        </div>
      )}
      
      {showDiscoverHeader && !isTrending && !isNearby && !isRecent && (
        <div className="section-title">
          <div>
            <span className="eyebrow">Discover</span>
            <h2>Find your vibe. Find your Tender.</h2>
          </div>
        </div>
      )}

      {!isTrending && !isNearby && !isRecent && (
        <div className="search-box">
          <span aria-hidden="true">⌕</span>

          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search bars or city..."
            aria-label="Search bars or city"
          />
        </div>
      )}
 
      {isRecent && (
        <>
          <div className="section-title">
            <div>
              <span className="eyebrow">Recent Shouts</span>
              <h2>Fresh props from the community</h2>
            </div>
          </div>

          <div className="search-results">
            {recentLoading ? (
              <div className="search-empty">Loading recent shouts...</div>
            ) : recentShouts.length ? (
              recentShouts.map((shout) => {
                const bartender = Array.isArray(shout.bartenders)
                  ? shout.bartenders[0]
                  : shout.bartenders;

                const venue = Array.isArray(shout.venues)
                  ? shout.venues[0]
                  : shout.venues;

                return (
                  <Link
                    key={shout.id}
                    href={bartender?.slug ? `/t/${bartender.slug}` : "#"}
                    className="search-result"
                  >
                    <span className="result-kicker">Shout</span>

                    <strong>{bartender?.display_name ?? "Tender"}</strong>

                    <small>
                      {venue?.name ?? "Unknown spot"}
                      {venue?.city ? ` · ${venue.city}` : ""}
                      {venue?.state_region ? `, ${venue.state_region}` : ""}
                    </small>
                  </Link>
                );
              })
            ) : (
              <div className="search-empty">No recent shouts yet.</div>
            )}
          </div>
        </>
      )}

      {isNearby && (
        <div className="section-title">
          <div>
            <span className="eyebrow">Nearby Spots</span>
            <h2>Closest spots to you</h2>
          </div>
        </div>
      )}

      {isNearby && (
        <div className="search-results">
          {locationStatus === "loading" ? (
            <div className="search-empty">Finding nearby spots...</div>
          ) : locationStatus === "denied" ? (
            <div className="search-empty">
              Location access is needed to show nearby spots.
            </div>
          ) : locationStatus === "unsupported" ? (
            <div className="search-empty">
              Location is not supported in this browser.
            </div>
          ) : nearbySpots.length ? (
            nearbySpots.map((spot) => (
              <Link
                key={spot.id}
                href={`/s/${spot.slug}`}
                className="search-result"
              >
                <span className="result-kicker">Spot</span>

                <strong>{spot.name}</strong>

                <small>
                  {spot.city}
                  {spot.state_region ? `, ${spot.state_region}` : ""}
                  {" · "}
                  {spot.distance.toFixed(1)} mi
                  {" · "}
                  {spot.tenderCount}{" "}
                  {spot.tenderCount === 1 ? "Tender" : "Tenders"}
                </small>
              </Link>
            ))
          ) : locationStatus === "ready" ? (
            <div className="search-empty">
              No nearby TenderFans spots found yet.
            </div>
          ) : null}
        </div>
      )}

      {(query.trim() || view === "trending") && (
        <div className="search-results">
          {loading ? (
            <div className="search-empty">
              Searching TenderFans...
            </div>
          ) : matches.length ? (
            matches.map((spot) => (
              <Link
                key={spot.id}
                href={`/s/${spot.slug}`}
                className="search-result"
              >
                <span className="result-kicker">Spot</span>

                <strong>{spot.name}</strong>

                <small>
                  {spot.city}
                  {spot.state_region
                    ? `, ${spot.state_region}`
                    : ""}
                  {" · "}
                  {spot.tenderCount}{" "}
                  {spot.tenderCount === 1
                    ? "Tender"
                    : "Tenders"}
                </small>
              </Link>
            ))
          ) : (
            <div className="search-empty">
              No TenderFans spots found yet.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
