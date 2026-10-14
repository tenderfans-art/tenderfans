"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Finding = {
  id: string;
  venue_id: string;
  venue_name: string;
  website_url: string;
  source_url: string | null;
  confidence: string | null;
  first_seen_at: string;
  last_seen_at: string;
};

type Spot = {
  id: string;
  name: string;
};

export default function CalendarImagesPage() {
  const [rows, setRows] = useState<Finding[]>([]);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [selectedSpot, setSelectedSpot] = useState<Record<string, string>>({});
  const [spotSearch, setSpotSearch] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const [findingsResult, spotsResult] = await Promise.all([
      supabase.rpc("admin_event_harvest_calendar_image_findings"),
      supabase.rpc("admin_list_spots"),
    ]);

    if (findingsResult.error || spotsResult.error) {
      setError(
        findingsResult.error?.message ??
          spotsResult.error?.message ??
          "Unable to load calendar source review."
      );
      setLoading(false);
      return;
    }

    const findings = (findingsResult.data ?? []) as Finding[];
    setRows(findings);
    setSpots((spotsResult.data ?? []) as Spot[]);
    setError(null);

    setSelectedSpot((current) => {
      const next = { ...current };
      for (const finding of findings) {
        if (!(finding.id in next)) {
          next[finding.id] = finding.venue_id;
        }
      }
      return next;
    });

    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function review(finding: Finding, approve: boolean) {
    const venueId = selectedSpot[finding.id] ?? finding.venue_id;

    if (approve && !venueId) {
      setError("Select a Spot before approval.");
      return;
    }

    if (
      !window.confirm(
        approve
          ? `Approve this calendar for the selected Spot?`
          : `Reject this calendar source?`
      )
    ) {
      return;
    }

    setBusyId(finding.id);
    setError(null);
    setMessage("");

    const { error: reviewError } = await supabase.rpc(
      "admin_review_calendar_image_source",
      {
        p_finding_id: finding.id,
        p_approve: approve,
        p_venue_id: approve ? venueId : null,
      }
    );

    if (reviewError) {
      setError(reviewError.message);
    } else {
      setMessage(
        approve
          ? "Calendar source approved and registered."
          : "Calendar source rejected."
      );
      await load();
    }

    setBusyId(null);
  }

  return (
    <main className="flow-page">
      <div className="shell">
        <section
          className="flow-card"
          style={{ maxWidth: 1200, margin: "0 auto" }}
        >
          <Link
            href="/admin/harvester"
            style={{
              display: "inline-block",
              marginBottom: 22,
              color: "inherit",
            }}
          >
            ← Harvester Management
          </Link>

          <div className="eyebrow">EVENT HARVESTER</div>

          <h1 style={{ marginBottom: 8 }}>
            Calendar Image Source Review
          </h1>

          <p className="lead-copy" style={{ marginBottom: 28 }}>
            Review each discovered calendar independently. Select the
            correct Spot before approving its source. Calendar parsing
            begins only after source registration.
          </p>

          {error && (
            <p role="alert" style={{ color: "#a22" }}>
              {error}
            </p>
          )}

          {message && <p role="status">{message}</p>}

          {loading ? (
            <p>Loading findings...</p>
          ) : rows.length === 0 ? (
            <p>No pending calendar-image sources.</p>
          ) : (
            <div style={{ display: "grid", gap: 5 }}>
              <div style={{
                display: "grid",
                gridTemplateColumns: "minmax(250px,2fr) 130px 130px 190px",
                gap: 10, padding: "0 10px",
                fontSize: ".66rem", fontWeight: 800,
                letterSpacing: ".08em", textTransform: "uppercase",
                opacity: .55
              }}>
                <span>Spot</span><span>Confidence</span>
                <span>Source</span><span>Last Seen</span>
              </div>
              {rows.map((finding) => {
                const search = (
                  spotSearch[finding.id] ?? ""
                ).toLowerCase().trim();

                const choices = spots.filter((spot) =>
                  spot.name.toLowerCase().includes(search)
                );

                const currentSpot =
                  selectedSpot[finding.id] ?? finding.venue_id;

                const busy = busyId !== null;

                return (
                  <details
                    key={finding.id}
                    style={{
                      border: "1px solid rgba(20,35,45,.12)",
                      borderRadius: 9,
                      background: "rgba(255,255,255,.9)"
                    }}
                  >
                    <summary style={{ cursor: "pointer", listStyle: "none" }}>
                      <div style={{
                        display: "grid",
                        gridTemplateColumns: "minmax(250px,2fr) 130px 130px 190px",
                        gap: 10, alignItems: "center",
                        padding: "7px 10px", fontSize: ".84rem"
                      }}>
                        <strong style={{
                          overflow: "hidden", textOverflow: "ellipsis",
                          whiteSpace: "nowrap"
                        }}>{finding.venue_name}</strong>
                        <span>{finding.confidence ?? "unknown"}</span>
                        <a href={finding.source_url ?? finding.website_url}
                          target="_blank" rel="noopener noreferrer"
                          onClick={(event) => event.stopPropagation()}>
                          Open Source
                        </a>
                        <span style={{ opacity: .65 }}>
                          {new Date(finding.last_seen_at).toLocaleString()}
                        </span>
                      </div>
                    </summary>
                    <div style={{ padding: "10px 14px 14px" }}>
                      <strong>Review calendar source</strong>
                    <label
                      htmlFor={`search-${finding.id}`}
                      style={{ display: "block", marginTop: 14 }}
                    >
                      Search Spots
                    </label>

                    <input
                      id={`search-${finding.id}`}
                      type="search"
                      value={spotSearch[finding.id] ?? ""}
                      onChange={(event) =>
                        setSpotSearch((current) => ({
                          ...current,
                          [finding.id]: event.target.value,
                        }))
                      }
                      placeholder="Search by Spot name"
                      disabled={busy}
                      style={{
                        width: "100%",
                        padding: 10,
                        marginTop: 6,
                        marginBottom: 10,
                      }}
                    />

                    <label
                      htmlFor={`spot-${finding.id}`}
                      style={{ display: "block" }}
                    >
                      Assign source to Spot
                    </label>

                    <select
                      id={`spot-${finding.id}`}
                      value={currentSpot}
                      onChange={(event) =>
                        setSelectedSpot((current) => ({
                          ...current,
                          [finding.id]: event.target.value,
                        }))
                      }
                      disabled={busy}
                      style={{
                        width: "100%",
                        padding: 10,
                        marginTop: 6,
                        marginBottom: 14,
                      }}
                    >
                      {!choices.some((spot) => spot.id === currentSpot) &&
                        currentSpot && (
                          <option value={currentSpot}>
                            {spots.find((spot) => spot.id === currentSpot)
                              ?.name ?? finding.venue_name}
                          </option>
                        )}

                      {choices.map((spot) => (
                        <option key={spot.id} value={spot.id}>
                          {spot.name}
                        </option>
                      ))}
                    </select>

                    <div
                      style={{
                        display: "flex",
                        gap: 10,
                        flexWrap: "wrap",
                      }}
                    >
                      <button
                        type="button"
                        disabled={busy || !currentSpot}
                        onClick={() => void review(finding, true)}
                      >
                        {busyId === finding.id
                          ? "Processing..."
                          : "Approve Source"}
                      </button>

                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void review(finding, false)}
                      >
                        Reject
                      </button>
                    </div>
                    </div>
                  </details>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
