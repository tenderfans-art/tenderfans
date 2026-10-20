"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { supabase } from "@/lib/supabase";

type ArchivedSpot = {
  venue_id: string;
  venue_name: string;
  city: string | null;
  state_region: string | null;
  website_url: string | null;
  original_bucket: string;
  archived_at: string;
  last_checked_at: string | null;
  next_check_at: string;
  last_result: string | null;
  check_count: number;
};

function cityKey(spot: ArchivedSpot) {
  const city = spot.city?.trim() || "Unknown city";
  const state = spot.state_region?.trim() || "";
  return state ? `${city}, ${state}` : city;
}

function dateLabel(value: string | null) {
  if (!value) return "Not yet";

  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : date.toLocaleDateString();
}

export default function HarvesterArchivePage() {
  const [rows, setRows] = useState<ArchivedSpot[]>([]);
  const [citySearch, setCitySearch] = useState("");
  const [spotSearch, setSpotSearch] = useState("");
  const [selectedCity, setSelectedCity] =
    useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      const { data, error: rpcError } = await supabase.rpc(
        "admin_list_harvest_archive"
      );

      if (!active) return;

      if (rpcError) {
        setError(rpcError.message);
      } else {
        setRows((data ?? []) as ArchivedSpot[]);
      }

      setLoading(false);
    }

    void load();

    return () => {
      active = false;
    };
  }, []);

  const cityCounts = useMemo(() => {
    const counts = new Map<string, number>();

    for (const spot of rows) {
      const key = cityKey(spot);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return [...counts.entries()].sort(
      (a, b) =>
        b[1] - a[1] ||
        a[0].localeCompare(b[0])
    );
  }, [rows]);

  const visibleCities = useMemo(() => {
    const term = citySearch.trim().toLowerCase();

    const matching = cityCounts.filter(([city]) =>
      city.toLowerCase().includes(term)
    );

    // Four columns, three rows: top 12 cities.
    // Searching can reveal any city beyond the top 12.
    return term ? matching : matching.slice(0, 12);
  }, [cityCounts, citySearch]);

  const citySpots = useMemo(() => {
    if (!selectedCity) return [];

    const term = spotSearch.trim().toLowerCase();

    return rows
      .filter((spot) => cityKey(spot) === selectedCity)
      .filter(
        (spot) =>
          spot.venue_name.toLowerCase().includes(term) ||
          spot.original_bucket.toLowerCase().includes(term) ||
          (spot.website_url ?? "")
            .toLowerCase()
            .includes(term)
      )
      .sort((a, b) =>
        a.venue_name.localeCompare(b.venue_name)
      );
  }, [rows, selectedCity, spotSearch]);

  const closeModal = useCallback(() => {
    if (busyId !== null) return;
    setSelectedCity(null);
    setSpotSearch("");
  }, [busyId]);

  useEffect(() => {
    if (!selectedCity) return;

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeModal();
      }
    }

    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener(
        "keydown",
        handleEscape
      );
    };
  }, [selectedCity, closeModal]);

  async function restore(spot: ArchivedSpot) {
    if (busyId !== null) return;

    const confirmed = window.confirm(
      `Restore ${spot.venue_name} to normal detector eligibility?`
    );

    if (!confirmed) return;

    setBusyId(spot.venue_id);
    setError("");

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
      current.filter(
        (row) => row.venue_id !== spot.venue_id
      )
    );
  }

  return (
    <main className="flow-page">
      <div className="shell">
        <section
          className="flow-card"
          style={{
            maxWidth: 1200,
            margin: "0 auto",
          }}
        >
          <Link href="/admin/harvester">
            ← Harvester Management
          </Link>

          <div
            className="eyebrow"
            style={{ marginTop: 22 }}
          >
            EVENT HARVESTER
          </div>

          <h1 style={{ marginBottom: 8 }}>
            Archive
          </h1>

          <p
            className="lead-copy"
            style={{ marginBottom: 18 }}
          >
            Archived Spots organized by city.
            Monthly source rechecks run independently
            across all archived Spots.
          </p>

          {error && (
            <p
              role="alert"
              style={{ color: "crimson" }}
            >
              {error}
            </p>
          )}

          <input
            type="search"
            value={citySearch}
            onChange={(event) =>
              setCitySearch(event.target.value)
            }
            placeholder="Search archived cities..."
            aria-label="Search archived cities"
            style={{
              width: "100%",
              padding: "11px 13px",
              border: "1px solid #ded8cc",
              borderRadius: 9,
              marginBottom: 15,
            }}
          />

          {loading ? (
            <p>Loading archive...</p>
          ) : (
            <>
              <p
                style={{
                  margin: "0 0 15px",
                  fontSize: ".85rem",
                  opacity: 0.7,
                }}
              >
                {rows.length} archived Spot
                {rows.length === 1 ? "" : "s"} across{" "}
                {cityCounts.length} cit
                {cityCounts.length === 1 ? "y" : "ies"}
              </p>

              {visibleCities.length === 0 ? (
                <p>No matching archived cities.</p>
              ) : (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(4, minmax(0, 1fr))",
                    gap: 10,
                  }}
                >
                  {visibleCities.map(([city, count]) => (
                    <button
                      key={city}
                      type="button"
                      onClick={() => {
                        setSpotSearch("");
                        setError("");
                        setSelectedCity(city);
                      }}
                      style={{
                        minWidth: 0,
                        minHeight: 74,
                        padding: "12px 14px",
                        borderRadius: 10,
                        border: "1px solid #ded8cc",
                        background: "#f4f0e8",
                        color: "inherit",
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                    >
                      <strong
                        style={{
                          display: "block",
                          fontSize: ".92rem",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {city}
                      </strong>

                      <span
                        style={{
                          display: "block",
                          marginTop: 5,
                          fontSize: ".79rem",
                          opacity: 0.75,
                        }}
                      >
                        {count} archived Spot
                        {count === 1 ? "" : "s"}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {selectedCity && (
        <div
          role="presentation"
          onMouseDown={(event) => {
            if (
              event.target === event.currentTarget
            ) {
              closeModal();
            }
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(10,20,28,.65)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label={
              `Archived Spots in ${selectedCity}`
            }
            style={{
              width: "min(1050px, 100%)",
              maxHeight: "min(85vh, 850px)",
              overflowY: "auto",
              background: "#fff",
              color: "#17232c",
              borderRadius: 16,
              padding: 22,
              boxShadow:
                "0 16px 55px rgba(0,0,0,.25)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
              }}
            >
              <h2 style={{ margin: 0 }}>
                {selectedCity}
              </h2>

              <button
                type="button"
                onClick={closeModal}
                disabled={busyId !== null}
                aria-label="Close city archive"
                style={{
                  border: "1px solid #ded8cc",
                  borderRadius: 8,
                  background: "#fff",
                  padding: "7px 12px",
                  cursor: "pointer",
                }}
              >
                Close ×
              </button>
            </div>

            <input
              type="search"
              value={spotSearch}
              onChange={(event) =>
                setSpotSearch(event.target.value)
              }
              placeholder={
                "Search archived Spots in this city..."
              }
              aria-label="Search archived Spots"
              autoFocus
              style={{
                width: "100%",
                padding: "11px 13px",
                border: "1px solid #ded8cc",
                borderRadius: 8,
                margin: "16px 0",
              }}
            />

            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(2, minmax(0, 1fr))",
                gap: 10,
              }}
            >
              {citySpots.length === 0 && (
                <p>No matching archived Spots.</p>
              )}

              {citySpots.map((spot) => (
                <div
                  key={spot.venue_id}
                  style={{
                    display: "flex",
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    minWidth: 0,
                    padding: "7px 10px",
                    border: "1px solid #e5dfd5",
                    borderRadius: 9,
                  }}
                >
                  <div
                    style={{
                      flex: "1 1 auto",
                      minWidth: 0,
                    }}
                  >
                    <strong>
                      {spot.venue_name}
                    </strong>

                    <div
                      style={{
                        fontSize: ".78rem",
                        opacity: 0.75,
                      }}
                    >
                      {spot.original_bucket}
                      {" · "}Archived{" "}
                      {dateLabel(spot.archived_at)}
                    </div>

                    <div
                      style={{
                        fontSize: ".78rem",
                        opacity: 0.75,
                      }}
                    >
                      Last check:{" "}
                      {dateLabel(spot.last_checked_at)}
                      {" · "}Next:{" "}
                      {dateLabel(spot.next_check_at)}
                      {" · "}Checks:{" "}
                      {spot.check_count}
                    </div>

                    {spot.last_result && (
                      <div
                        style={{
                          fontSize: ".78rem",
                          opacity: 0.75,
                        }}
                      >
                        Result: {spot.last_result}
                      </div>
                    )}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                    }}
                  >
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
                      onClick={() =>
                        void restore(spot)
                      }
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
        </div>
      )}
    </main>
  );
}
