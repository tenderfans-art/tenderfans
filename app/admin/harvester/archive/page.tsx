"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type ArchivedSpot = {
  venue_id: string;
  venue_name: string;
  city: string;
  state_region: string;
  website_url: string;
  original_bucket: string;
  archived_at: string;
  last_checked_at: string | null;
  next_check_at: string;
  last_result: string | null;
  check_count: number;
};

export default function HarvesterArchivePage() {
  const [rows, setRows] = useState<ArchivedSpot[]>([]);
  const [search, setSearch] = useState("");
  const [selectedCity, setSelectedCity] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    const { data, error: rpcError } = await supabase.rpc(
      "admin_list_harvest_archive"
    );

    if (rpcError) {
      setError(rpcError.message);
    } else {
      setRows((data ?? []) as ArchivedSpot[]);
      setError("");
    }
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  const cities = useMemo(() => {
    const counts = new Map<string, number>();

    for (const spot of rows) {
      const key = `${spot.city}, ${spot.state_region}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const term = search.trim().toLowerCase();

    return [...counts.entries()]
      .filter(([city]) => city.toLowerCase().includes(term))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, term ? undefined : 10);
  }, [rows, search]);

  const visibleSpots = useMemo(() => {
    if (!selectedCity) return [];

    return rows.filter(
      (spot) =>
        `${spot.city}, ${spot.state_region}` === selectedCity
    );
  }, [rows, selectedCity]);

  async function restore(spot: ArchivedSpot) {
    if (busyId) return;
    if (!window.confirm(`Restore ${spot.venue_name} to active review?`)) {
      return;
    }

    setBusyId(spot.venue_id);

    const { error: rpcError } = await supabase.rpc(
      "admin_restore_harvest_spot",
      { p_venue_id: spot.venue_id }
    );

    setBusyId(null);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    setRows((current) =>
      current.filter((row) => row.venue_id !== spot.venue_id)
    );
  }

  return (
    <main className="flow-page">
      <div className="shell">
        <section className="flow-card"
          style={{ maxWidth: "1200px", margin: "0 auto" }}>
          <Link href="/admin/harvester">
            ← Harvester Management
          </Link>

          <div className="eyebrow" style={{ marginTop: 22 }}>
            EVENT HARVESTER
          </div>

          <h1>Archive</h1>
          <p className="lead-copy">
            Archived Spots organized by city.
            Monthly source rechecks will run across all cities.
          </p>

          {error && <p role="alert" style={{ color: "crimson" }}>{error}</p>}

          {loading ? (
            <p>Loading archive...</p>
          ) : (
            <>
              <input
                type="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setSelectedCity(null);
                }}
                placeholder="Search cities..."
                aria-label="Search archived cities"
                style={{
                  width: "100%",
                  padding: "12px",
                  marginBottom: "20px",
                }}
              />

              <p>{rows.length} archived Spots across {
                new Set(rows.map(
                  (s) => `${s.city}, ${s.state_region}`
                )).size
              } cities</p>

              <div style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fit, minmax(200px, 1fr))",
                gap: "12px",
              }}>
                {cities.map(([city, count]) => (
                  <button
                    key={city}
                    type="button"
                    onClick={() =>
                      setSelectedCity(
                        selectedCity === city ? null : city
                      )
                    }
                    style={{
                      padding: "20px",
                      borderRadius: "14px",
                      border: "1px solid #ded8cc",
                      background: selectedCity === city
                        ? "#eee8dc" : "#fff",
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    <strong>{city}</strong>
                    <p style={{ marginBottom: 0 }}>
                      {count} archived Spot{count === 1 ? "" : "s"}
                    </p>
                  </button>
                ))}
              </div>

              {selectedCity && (
                <section style={{ marginTop: "28px" }}>
                  <h2>{selectedCity}</h2>
                  <div style={{ display: "grid", gap: "10px" }}>
                    {visibleSpots.map((spot) => (
                      <div
                        key={spot.venue_id}
                        style={{
                          border: "1px solid #ded8cc",
                          borderRadius: "12px",
                          padding: "15px",
                          background: "#fff",
                        }}
                      >
                        <strong>{spot.venue_name}</strong>
                        <p>Original bucket: {spot.original_bucket}</p>
                        <p>
                          Archived: {
                            new Date(spot.archived_at).toLocaleDateString()
                          }
                        </p>
                        <p>
                          Last checked: {
                            spot.last_checked_at
                              ? new Date(
                                  spot.last_checked_at
                                ).toLocaleDateString()
                              : "Not yet"
                          }
                        </p>
                        <p>
                          Next check: {
                            new Date(
                              spot.next_check_at
                            ).toLocaleDateString()
                          }
                        </p>
                        {spot.last_result && (
                          <p>Last result: {spot.last_result}</p>
                        )}
                        <div style={{
                          display: "flex",
                          gap: "12px",
                          alignItems: "center",
                        }}>
                          {spot.website_url && (
                            <a
                              href={spot.website_url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Website
                            </a>
                          )}
                          <button
                            type="button"
                            className="btn outline"
                            disabled={busyId !== null}
                            onClick={() => restore(spot)}
                          >
                            {busyId === spot.venue_id
                              ? "Restoring..."
                              : "Restore"}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
