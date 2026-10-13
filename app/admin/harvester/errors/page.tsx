"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Spot = {
  venue_id: string;
  venue_name: string;
  website_url: string;
  consecutive_failures: number;
  first_failed_at: string;
  last_failed_at: string;
  latest_stage: string;
  latest_error: string;
  needs_review: boolean;
};

export default function HarvesterErrorsPage() {
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
          "/api/admin/harvester-errors",
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
            Detector Execution Errors
          </h1>

          <p className="lead-copy">
            Active execution errors. Three consecutive failed scans trigger
            administrator review; a completed successful scan resolves them.
          </p>

          {loading && <p>Loading Spots...</p>}

          {error && <p role="alert">{error}</p>}

          {!loading && !error && (
            <>
              <p>
                <strong>{spots.length}</strong> Spots with active execution errors
              </p>

              {spots.length === 0 ? (
                <p>No active execution errors.</p>
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
                        <th style={{ padding: "12px" }}>Failures</th>
                        <th style={{ padding: "12px" }}>Status</th>
                        <th style={{ padding: "12px" }}>Latest error</th>
                        <th style={{ padding: "12px" }}>First / last failure</th>
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
                          <td style={{
                            padding: "12px",
                            borderTop: "1px solid #ddd",
                          }}>
                            {spot.consecutive_failures}
                          </td>
                          <td style={{
                            padding: "12px",
                            borderTop: "1px solid #ddd",
                          }}>
                            {spot.needs_review ? "REVIEW" : "Retry"}
                          </td>
                          <td style={{
                            padding: "12px",
                            borderTop: "1px solid #ddd",
                            overflowWrap: "anywhere",
                          }}>
                            {spot.latest_stage}: {spot.latest_error}
                          </td>
                          <td style={{
                            padding: "12px",
                            borderTop: "1px solid #ddd",
                          }}>
                            {new Date(spot.first_failed_at).toLocaleString()}
                            {" / "}
                            {new Date(spot.last_failed_at).toLocaleString()}
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
