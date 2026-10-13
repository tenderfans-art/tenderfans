"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Spot = {
  venue_id: string;
  venue_name: string;
  website_url: string;
};

export default function UnaccountedSpotsPage() {
  const [spots, setSpots] = useState<Spot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const { data: { session }, error: sessionError } =
          await supabase.auth.getSession();

        if (sessionError || !session?.access_token) {
          throw new Error("Administrator sign-in required.");
        }

        const response = await fetch(
          "/api/admin/harvester-unaccounted",
          {
            headers: {
              Authorization: `Bearer ${session.access_token}`,
            },
            cache: "no-store",
          },
        );

        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error ?? "Could not load Spots.");
        }

        if (active) setSpots(result as Spot[]);
      } catch (err) {
        if (active) {
          setError(
            err instanceof Error ? err.message : "Request failed.",
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();

    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="flow-page">
      <div className="shell">
        <section
          className="flow-card"
          style={{ maxWidth: "1200px", margin: "0 auto" }}
        >
          <Link href="/admin/harvester">
            ← Harvester Management
          </Link>

          <h1 style={{ marginTop: "24px" }}>
            Unaccounted Spots
          </h1>

          <p className="lead-copy">
            Active Spots with websites, no enabled first-party
            source, and no active detector exception.
          </p>

          {loading && <p>Loading Spots...</p>}

          {error && <p role="alert">{error}</p>}

          {!loading && !error && (
            <>
              <p>
                <strong>{spots.length}</strong> Spots missing from
                exception buckets
              </p>

              {spots.length === 0 ? (
                <p>All non-validated Spots are accounted for.</p>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      textAlign: "left",
                    }}
                  >
                    <thead>
                      <tr>
                        <th style={{ padding: "12px" }}>Spot</th>
                        <th style={{ padding: "12px" }}>Website</th>
                      </tr>
                    </thead>
                    <tbody>
                      {spots.map((spot) => (
                        <tr key={spot.venue_id}>
                          <td style={{
                            padding: "12px",
                            borderTop: "1px solid #ddd",
                          }}>
                            {spot.venue_name}
                          </td>
                          <td style={{
                            padding: "12px",
                            borderTop: "1px solid #ddd",
                          }}>
                            <a
                              href={spot.website_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ overflowWrap: "anywhere" }}
                            >
                              {spot.website_url}
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
