"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import VenueVisual from "@/components/VenueVisual";
import { supabase } from "@/lib/supabase";

type LiveVenue = {
  id: string;
  slug: string;
  name: string;
  city: string;
  state_region: string;
  venue_type: string;
  street_address: string | null;
  latitude: number | null;
  longitude: number | null;
  cheers: number;
};

export default function PopularSpots() {
  const [venues, setVenues] = useState<LiveVenue[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadPopularSpots() {
      const { data: venueRows, error: venueError } = await supabase
        .from("venues")
        .select(`
          id,
          slug,
          name,
          city,
          state_region,
          venue_type,
          street_address,
          latitude,
          longitude
        `)
        .eq("status", "active");

      if (venueError) {
        console.error("Popular spots:", venueError);
        setLoading(false);
        return;
      }

      const { data: shoutRows, error: shoutError } = await supabase
        .from("shoutouts")
        .select("venue_id")
        .eq("status", "published");

      if (shoutError) {
        console.error("Popular spot shouts:", shoutError);
      }

      const shoutCounts = new Map<string, number>();

      for (const shout of shoutRows ?? []) {
        shoutCounts.set(
          shout.venue_id,
          (shoutCounts.get(shout.venue_id) ?? 0) + 1
        );
      }

      const liveVenues: LiveVenue[] = (venueRows ?? [])
        .map((venue: any) => ({
          ...venue,
          city: venue.city ?? "",
          state_region: venue.state_region ?? "",
          venue_type: venue.venue_type ?? "Bar",
          cheers: shoutCounts.get(venue.id) ?? 0,
        }))
        .sort((a, b) => b.cheers - a.cheers)
        .slice(0, 3);

      setVenues(liveVenues);
      setLoading(false);
    }

    loadPopularSpots();
  }, []);

  return (
    <section className="section soft home-popular">
      <div className="shell">
        <div className="section-title">
          <div>
            <span className="eyebrow">Popular Spots</span>
            <h2>Where people keep finding great hospitality.</h2>
          </div>
        </div>

        {loading ? (
          <p className="muted">Loading spots...</p>
        ) : venues.length ? (
          <div className="spot-grid">
            {venues.map((venue) => (
              <Link
                href={`/s/${venue.slug}`}
                className="spot-card"
                key={venue.id}
              >
                <VenueVisual venue={venue} />

                <div className="spot-copy">
                  <div className="card-row">
                    <h3>{venue.name}</h3>
                    <strong>{venue.cheers.toLocaleString()} Cheers</strong>
                  </div>

                  <p>
                    {venue.venue_type} · {venue.city}
                  </p>

                  <span className="status-pill">
                    Community Spot
                  </span>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <p className="muted">No spots to show yet.</p>
        )}
      </div>
    </section>
  );
}
