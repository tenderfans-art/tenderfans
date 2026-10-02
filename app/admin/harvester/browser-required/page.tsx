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
  source_url: string | null;
  confidence: string | null;
  evidence: unknown;
  first_seen_at: string;
  last_seen_at: string;
};

function evidenceText(value: unknown): string {
  if (!Array.isArray(value)) return "Browser execution required";

  const text = value
    .filter((item): item is string => typeof item === "string")
    .join(" · ");

  return text || "Browser execution required";
}

export default function BrowserRequiredPage() {
  const [rows, setRows] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      const { data, error: rpcError } = await supabase.rpc(
        "admin_event_harvest_browser_required_findings",
      );

      if (!active) return;

      if (rpcError) {
        setError("Unable to load Browser Required findings.");
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

          <h1 style={{ marginBottom: "8px" }}>Browser Required</h1>

          <p
            className="lead-copy"
            style={{
              marginTop: 0,
              marginBottom: "28px",
            }}
          >
            Spots whose event-source discovery has been established to require
            browser execution.
          </p>

          {loading ? (
            <p>Loading findings...</p>
          ) : error ? (
            <p>{error}</p>
          ) : rows.length === 0 ? (
            <p>No active Browser Required findings.</p>
          ) : (
            <div style={{ display: "grid", gap: "5px" }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "minmax(240px,2fr) minmax(300px,2fr) 120px 190px",
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
                <span>Reason</span>
                <span>Source</span>
                <span>Last Seen</span>
              </div>

              {rows.map((row) => (
                <div
                  key={row.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "minmax(240px,2fr) minmax(300px,2fr) 120px 190px",
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

                  <span
                    title={evidenceText(row.evidence)}
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {evidenceText(row.evidence)}
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
