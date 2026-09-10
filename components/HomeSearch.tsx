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

type TenderResult = {
  id: string;
  slug: string;
  display_name: string;
  currentSpots: {
    id: string;
    name: string;
    city: string;
    is_primary: boolean;
  }[];
};

export default function HomeSearch({
  showDiscoverHeader = false,
}: {
  showDiscoverHeader?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [spots, setSpots] = useState<SpotResult[]>([]);
  const [tenders, setTenders] = useState<TenderResult[]>([]);
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
      // Start with every active TenderFans Spot.
      // A Spot should remain discoverable even if it does not yet
      // have a current Tender attached to it.
      const { data: venueRows, error: venueError } = await supabase
        .from("venues")
        .select(`
          id,
          slug,
          name,
          city,
          state_region,
          venue_type,
          latitude,
          longitude,
          status
        `)
        .eq("status", "active");

      if (venueError) {
        console.error("TenderFans discovery search:", venueError);
        setSpots([]);
        setLoading(false);
        return;
      }

      const venueMap = new Map<string, SpotResult>();

      for (const venue of venueRows ?? []) {
        venueMap.set(venue.id, {
          id: venue.id,
          slug: venue.slug,
          name: venue.name,
          city: venue.city ?? "",
          state_region: venue.state_region ?? "",
          venue_type: venue.venue_type ?? "bar",
          tenderCount: 0,
          shoutCount: 0,
          latitude: venue.latitude ?? null,
          longitude: venue.longitude ?? null,
        });
      }

      // Count current Tenders separately so the Spot itself is not
      // dependent on having a Tender association.
      const { data: tenderVenueRows, error: tenderVenueError } = await supabase
        .from("bartender_venues")
        .select("venue_id")
        .eq("is_current", true);

      if (tenderVenueError) {
        console.error("TenderFans Tender counts:", tenderVenueError);
      }

      for (const row of tenderVenueRows ?? []) {
        const spot = venueMap.get(row.venue_id);
        if (spot) spot.tenderCount += 1;
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
    async function loadTenders() {
      const { data, error } = await supabase
        .from("bartenders")
        .select("id, slug, display_name")
        .eq("status", "active")
        .order("display_name");

      if (error) {
        console.error("TenderFans Tender search:", error);
        setTenders([]);
        return;
      }

      const bartenderRows = data ?? [];
      const bartenderIds = bartenderRows.map((bartender) => bartender.id);

      let relationshipRows: any[] = [];

      if (bartenderIds.length) {
        const { data: relationships, error: relationshipError } = await supabase
          .from("bartender_venues")
          .select(`
            bartender_id,
            is_primary,
            venues!inner(
              id,
              name,
              city,
              status
            )
          `)
          .in("bartender_id", bartenderIds)
          .eq("is_current", true)
          .eq("venues.status", "active");

        if (relationshipError) {
          console.error(
            "TenderFans Tender Spot search:",
            relationshipError
          );
        } else {
          relationshipRows = relationships ?? [];
        }
      }

      const spotMap = new Map<string, TenderResult["currentSpots"]>();

      for (const row of relationshipRows) {
        const venueData = row.venues;
        const venue = Array.isArray(venueData)
          ? venueData[0]
          : venueData;

        if (!venue) continue;

        const current = spotMap.get(row.bartender_id) ?? [];

        current.push({
          id: venue.id,
          name: venue.name,
          city: venue.city ?? "",
          is_primary: Boolean(row.is_primary),
        });

        spotMap.set(row.bartender_id, current);
      }

      setTenders(
        bartenderRows.map((bartender) => ({
          ...bartender,
          currentSpots: (spotMap.get(bartender.id) ?? []).sort(
            (a, b) =>
              Number(b.is_primary) - Number(a.is_primary) ||
              a.name.localeCompare(b.name)
          ),
        }))
      );
    }

    loadTenders();
  }, []);

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
        .limit(5);

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
          .slice(0, 10);

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

    if (!q) return view === "trending" ? spots.slice(0, 5) : [];

    return spots
      .filter((spot) =>
        normalize(`${spot.name} ${spot.city} ${spot.state_region} ${spot.venue_type}`).includes(q)
      )
      .slice(0, 8);
  }, [query, spots, view]);

  const tenderMatches = useMemo(() => {
    const normalize = (value: string) =>
      value
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();

    const q = normalize(query);

    if (!q || isTrending || isNearby || isRecent) return [];

    return tenders
      .filter((tender) => normalize(tender.display_name).includes(q))
      .slice(0, 8);
  }, [query, tenders, isTrending, isNearby, isRecent]);

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
            placeholder="Search bartenders, bars or city..."
            aria-label="Search bartenders, bars or city"
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
          ) : view === "trending" ? (
            matches.length ? (
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
                    {spot.state_region ? `, ${spot.state_region}` : ""}
                    {" · "}
                    {spot.tenderCount}{" "}
                    {spot.tenderCount === 1 ? "Tender" : "Tenders"}
                  </small>
                </Link>
              ))
            ) : (
              <div className="search-empty">No trending spots yet.</div>
            )
          ) : tenderMatches.length || matches.length ? (
            <>
              {tenderMatches.map((tender) => (
                <Link
                  key={`tender-${tender.id}`}
                  href={`/t/${tender.slug}`}
                  className="search-result"
                >
                  <span className="result-kicker">Tender</span>
                  <strong>{tender.display_name}</strong>
                  <small>
                    {tender.currentSpots.length
                      ? tender.currentSpots
                          .map(
                            (spot) =>
                              `${spot.name}${spot.city ? ` · ${spot.city}` : ""}`
                          )
                          .join(" | ")
                      : "No current Spot listed"}
                  </small>
                </Link>
              ))}

              {matches.map((spot) => (
                <Link
                  key={`spot-${spot.id}`}
                  href={`/s/${spot.slug}`}
                  className="search-result"
                >
                  <span className="result-kicker">Spot</span>
                  <strong>{spot.name}</strong>

                  <small>
                    {spot.city}
                    {spot.state_region ? `, ${spot.state_region}` : ""}
                    {" · "}
                    {spot.tenderCount}{" "}
                    {spot.tenderCount === 1 ? "Tender" : "Tenders"}
                  </small>
                </Link>
              ))}
            </>
          ) : (
            <div className="search-empty">
              No TenderFans results found.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
