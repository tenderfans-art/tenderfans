"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

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
            <div style={{ display: "grid", gap: "5px" }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "minmax(250px,2fr) 130px minmax(180px,1fr) 120px 190px",
                  gap: "10px",
                  padding: "0 10px",
                  fontSize: ".66rem",
                  fontWeight: 800,
                  letterSpacing: ".08em",
                  textTransform: "uppercase",
                  opacity: 0.55,
                }}
              >
                <span>Spot</span>
                <span>Status</span>
                <span>Error</span>
                <span>Source</span>
                <span>Last Seen</span>
              </div>
              {rows.map((row) => (
                <div
                  key={row.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "minmax(250px,2fr) 130px minmax(180px,1fr) 120px 190px",
                    gap: "10px",
                    alignItems: "center",
                    padding: "7px 10px",
                    border: "1px solid rgba(20,35,45,.12)",
                    borderRadius: "9px",
                    background: "rgba(255,255,255,.9)",
                    fontSize: ".84rem",
                  }}
                >
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
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
