"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import HarvesterBulkActions from "@/components/admin/HarvesterBulkActions";

type Finding = {
  id: string;
  venue_id: string;
  venue_name: string;
  website_url: string;
  fetched_url: string | null;
  first_seen_at: string;
  last_seen_at: string;
};

export default function NoSourcePage() {
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [rows, setRows] =
    useState<Finding[]>([]);
  const [facebookVenueIds, setFacebookVenueIds] =
    useState<Set<string>>(new Set());
  const [loading, setLoading] =
    useState(true);
  const [error, setError] =
    useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      const {
        data,
        error: rpcError,
      } = await supabase.rpc(
        "admin_event_harvest_no_source_findings"
      );

      if (!active) return;

      if (rpcError) {
        setError(
          "Unable to load No Source findings."
        );
      } else {
        const findings = (data ?? []) as Finding[];
        setRows(findings);

        const { data: facebookMarkers, error: facebookError } =
          await supabase.rpc(
            "admin_event_harvest_no_source_facebook_markers"
          );

        if (!active) return;

        if (facebookError) {
          setError("Unable to load Facebook detection markers.");
          setLoading(false);
          return;
        }

        setFacebookVenueIds(
          new Set(
            (facebookMarkers ?? []).map(
              (marker: { venue_id: string }) => marker.venue_id
            )
          )
        );
      }

      setLoading(false);
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
          style={{
            maxWidth: "1200px",
            margin: "0 auto",
          }}
        >
          <Link
            href="/admin/harvester"
            style={{
              display: "inline-block",
              marginBottom: "22px",
              color: "inherit",
            }}
          >
            ← Harvester Management
          </Link>

          <div className="eyebrow">
            EVENT HARVESTER
          </div>

          <h1
            style={{
              marginBottom: "8px",
            }}
          >
            No Source
          </h1>

          <p
            className="lead-copy"
            style={{
              marginTop: 0,
              marginBottom: "28px",
            }}
          >
            Spots where event-source discovery
            completed successfully but found no
            harvestable event source.
          </p>

          {loading ? (
            <p>Loading findings...</p>
          ) : error ? (
            <p>{error}</p>
          ) : rows.length === 0 ? (
            <p>
              No active No Source findings.
            </p>
          ) : (
            <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                flexWrap: "wrap",
                marginBottom: "14px",
              }}
            >
              <strong>{bulkSelected.size} selected</strong>
              <HarvesterBulkActions
                bucket="no_source"
                selected={rows
                  .filter((row) =>
                    bulkSelected.has(row.venue_id)
                  )
                  .map((row) => ({
                    id: row.venue_id,
                    name: row.venue_name,
                  }))}
                onComplete={(completedIds) => {
                  const completed = new Set(completedIds);
                  setRows((current) =>
                    current.filter(
                      (row) => !completed.has(row.venue_id)
                    )
                  );
                  setBulkSelected((current) => {
                    const next = new Set(current);
                    completedIds.forEach((id) =>
                      next.delete(id)
                    );
                    return next;
                  });
                }}
              />
            </div>
            <div
              style={{
                display: "grid",
                gap: "5px",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "30px minmax(300px,2fr) 150px 190px",
                  gap: "10px",
                  padding: "0 10px",
                  fontSize: ".66rem",
                  fontWeight: 800,
                  letterSpacing: ".08em",
                  textTransform: "uppercase",
                  opacity: 0.55,
                }}
              >
                <input
                  type="checkbox"
                  aria-label="Select all visible Spots"
                  style={{
                    width: 17,
                    height: 17,
                    borderRadius: "50%",
                    accentColor: "#557747",
                    cursor: "pointer",
                  }}
                  checked={
                    rows.length > 0 &&
                    rows.every((row) =>
                      bulkSelected.has(row.venue_id)
                    )
                  }
                  onChange={(event) => {
                    setBulkSelected(
                      event.target.checked
                        ? new Set(rows.map((row) => row.venue_id))
                        : new Set()
                    );
                  }}
                />
                <span>Spot</span>
                <span>Source</span>
                <span>Last Seen</span>

              </div>

              {rows.map((row) => (
                <div
                  key={row.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "30px minmax(300px,2fr) 150px 190px",
                    gap: "10px",
                    alignItems: "center",
                    padding: "7px 10px",
                    border:
                      "1px solid rgba(20,35,45,.12)",
                    borderRadius: "9px",
                    background:
                      "rgba(255,255,255,.9)",
                    fontSize: ".84rem",
                  }}
                >
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.venue_name}`}
                    checked={bulkSelected.has(row.venue_id)}
                    style={{
                      width: 17,
                      height: 17,
                      borderRadius: "50%",
                      accentColor: "#557747",
                      cursor: "pointer",
                    }}
                    onChange={(event) => {
                      setBulkSelected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) {
                          next.add(row.venue_id);
                        } else {
                          next.delete(row.venue_id);
                        }
                        return next;
                      });
                    }}
                  />
                  <strong
                    style={{
                      overflow: "hidden",
                      textOverflow:
                        "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {row.venue_name}
                    {facebookVenueIds.has(row.venue_id) && (
                      <span
                        title="Facebook detected but no validated event source"
                        style={{
                          display: "inline-block",
                          marginLeft: "9px",
                          padding: "2px 6px",
                          borderRadius: "4px",
                          background: "#b42318",
                          color: "#fff",
                          fontSize: ".65rem",
                          fontWeight: 800,
                          verticalAlign: "middle",
                        }}
                      >
                        FB
                      </span>
                    )}
                  </strong>

                  <a
                    href={row.website_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open Website
                  </a>

                  <span
                    style={{
                      opacity: 0.65,
                    }}
                  >
                    {new Date(
                      row.last_seen_at
                    ).toLocaleString()}
                  </span>

</div>


              ))}
            </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
