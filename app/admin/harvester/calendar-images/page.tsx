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
    setRows([...findings].sort((a, b) =>
      a.venue_name.localeCompare(b.venue_name)
    ));
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
            <div style={{ display: "grid", gap: 8 }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "minmax(250px,2fr) minmax(110px,1fr) 150px 185px 82px 82px",
                  gap: 8,
                  alignItems: "end",
                  padding: "0 10px",
                  fontSize: ".66rem",
                  fontWeight: 800,
                  letterSpacing: ".08em",
                  textTransform: "uppercase",
                  opacity: .55,
                }}
              >
                <span>Source / Spot</span>
                <span>Confidence</span>
                <span>Spot Search</span>
                <span>Select Spot</span>
                <span style={{ gridColumn: "5 / 7", textAlign: "center" }}>
                  Action
                </span>
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
                const sourceUrl =
                  finding.source_url ?? finding.website_url;

                return (
                  <div
                    key={finding.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "minmax(250px,2fr) minmax(110px,1fr) 150px 185px 82px 82px",
                      gap: 8,
                      alignItems: "center",
                      padding: "8px 10px",
                      border: "1px solid rgba(20,35,45,.12)",
                      borderRadius: 10,
                      background: "rgba(255,255,255,.9)",
                    }}
                  >
                    <div style={{ minWidth: 0, fontSize: ".88rem" }}>
                      <a
                        href={sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`${finding.venue_name} — Open source`}
                        style={{
                          display: "block",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          fontWeight: 700,
                          color: "inherit",
                          textDecoration: "underline",
                          textUnderlineOffset: 3,
                        }}
                      >
                        {finding.venue_name}
                      </a>

                      <details style={{ marginTop: 5 }}>
                        <summary
                          style={{
                            cursor: "pointer",
                            fontSize: ".74rem",
                            opacity: .65,
                          }}
                        >
                          Source details
                        </summary>

                        <div
                          style={{
                            paddingTop: 8,
                            fontSize: ".76rem",
                            overflowWrap: "anywhere",
                          }}
                        >
                          <div>
                            <strong>Source: </strong>
                            <a
                              href={sourceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {sourceUrl}
                            </a>
                          </div>
                          <div style={{ marginTop: 5 }}>
                            First seen:{" "}
                            {new Date(
                              finding.first_seen_at
                            ).toLocaleString()}
                          </div>
                          <div style={{ marginTop: 5 }}>
                            Last seen:{" "}
                            {new Date(
                              finding.last_seen_at
                            ).toLocaleString()}
                          </div>
                        </div>
                      </details>
                    </div>

                    <div style={{ fontSize: ".84rem" }}>
                      {finding.confidence ?? "Unknown"}
                    </div>

                    <input
                      type="search"
                      value={spotSearch[finding.id] ?? ""}
                      onChange={(event) =>
                        setSpotSearch((current) => ({
                          ...current,
                          [finding.id]: event.target.value,
                        }))
                      }
                      placeholder="Search Spots..."
                      aria-label={`Search Spots for ${finding.venue_name}`}
                      disabled={busy}
                      style={{
                        width: "150px",
                        minWidth: "130px",
                        padding: "7px 9px",
                        fontSize: ".82rem",
                      }}
                    />

                    <select
                      value={currentSpot}
                      onChange={(event) =>
                        setSelectedSpot((current) => ({
                          ...current,
                          [finding.id]: event.target.value,
                        }))
                      }
                      aria-label={`Select Spot for ${finding.venue_name}`}
                      disabled={busy}
                      style={{
                        width: "185px",
                        minWidth: "160px",
                        padding: "7px 9px",
                        fontSize: ".82rem",
                      }}
                    >
                      {!choices.some(
                        (spot) => spot.id === currentSpot
                      ) && currentSpot && (
                        <option value={currentSpot}>
                          {spots.find(
                            (spot) => spot.id === currentSpot
                          )?.name ?? finding.venue_name}
                        </option>
                      )}

                      {choices.map((spot) => (
                        <option key={spot.id} value={spot.id}>
                          {spot.name}
                        </option>
                      ))}
                    </select>

                    <button
                      type="button"
                      disabled={busy || !currentSpot}
                      onClick={() => void review(finding, true)}
                      style={{
                        padding: "7px 11px",
                        border: 0,
                        borderRadius: 8,
                        cursor: busy ? "default" : "pointer",
                        fontWeight: 700,
                        fontSize: ".8rem",
                        whiteSpace: "nowrap",
                        opacity: busy || !currentSpot ? .55 : 1,
                      }}
                    >
                      {busyId === finding.id
                        ? "Working..."
                        : "Approve"}
                    </button>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void review(finding, false)}
                      style={{
                        padding: "6px 10px",
                        border: "1px solid rgba(20,35,45,.2)",
                        borderRadius: 8,
                        background: "transparent",
                        cursor: busy ? "default" : "pointer",
                        fontWeight: 700,
                        fontSize: ".8rem",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Reject
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
