"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import HarvesterSpotActions from "@/components/admin/HarvesterSpotActions";
import HarvesterBulkActions from "@/components/admin/HarvesterBulkActions";

type Finding = {
  id: string;
  venue_id: string;
  venue_name: string;
  detector_status: string;
  website_url: string;
  fetched_url: string | null;
  error: string | null;
  first_seen_at: string;
  last_seen_at: string;
};

export default function TransportErrorsPage() {
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      const { data, error: rpcError } = await supabase.rpc(
        "admin_event_harvest_transport_findings",
      );

      if (!active) return;

      if (rpcError) {
        setError(rpcError.message);
      } else {
        setRows((data ?? []) as Finding[]);
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

          <div className="eyebrow">EVENT HARVESTER</div>

          <h1 style={{ marginBottom: "8px" }}>Transport Errors</h1>

          <p
            className="lead-copy"
            style={{
              marginTop: 0,
              marginBottom: "28px",
            }}
          >
            Spots whose websites could not be reached reliably by the scheduled
            detector.
          </p>

          {loading ? (
            <p>Loading findings...</p>
          ) : error ? (
            <p>Unable to load transport findings: {error}</p>
          ) : rows.length === 0 ? (
            <p>No active transport errors.</p>
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
                bucket="transport"
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
            <div style={{ display: "grid", gap: "5px" }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "30px minmax(250px,2fr) 130px minmax(180px,1fr) 120px 190px 165px",
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
                <span>Status</span>
                <span>Error</span>
                <span>Source</span>
                <span>Last Seen</span>
                <span>Actions</span>
              </div>
              {rows.map((row) => (
                <div
                  key={row.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "30px minmax(250px,2fr) 130px minmax(180px,1fr) 120px 190px 165px",
                    gap: "10px",
                    alignItems: "center",
                    padding: "7px 10px",
                    border: "1px solid rgba(20,35,45,.12)",
                    borderRadius: "9px",
                    background: "rgba(255,255,255,.9)",
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
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {row.venue_name}
                  </strong>
                  <span>{row.detector_status}</span>
                  <span
                    title={row.error ?? ""}
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {row.error ?? "—"}
                  </span>
                  <a
                    href={row.website_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open Website
                  </a>
                  <span style={{ opacity: 0.65 }}>
                    {new Date(row.last_seen_at).toLocaleString()}
                  </span>
                                  <HarvesterSpotActions
                    venueId={row.venue_id}
                    venueName={row.venue_name}
                    bucket="transport"
                    onComplete={(id) =>
                      setRows((current) =>
                        current.filter((item) => item.venue_id !== id)
                      )
                    }
                  />
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
