"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
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

export default function CalendarImagesPage() {
  const [rows, setRows] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      const { data, error: rpcError } = await supabase.rpc(
        "admin_event_harvest_calendar_image_findings",
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

          <h1 style={{ marginBottom: "8px" }}>
            Calendar Image Adapter
          </h1>

          <p
            className="lead-copy"
            style={{
              marginTop: 0,
              marginBottom: "28px",
            }}
          >
            Calendar-image sources detected automatically and awaiting
            adapter support.
          </p>

          {loading ? (
            <p>Loading findings...</p>
          ) : error ? (
            <div
              style={{
                padding: "14px 16px",
                border: "1px solid rgba(20, 35, 45, 0.12)",
                borderRadius: "12px",
              }}
            >
              Unable to load calendar-image findings: {error}
            </div>
          ) : rows.length === 0 ? (
            <p>No active calendar-image findings.</p>
          ) : (
            <div style={{ display: "grid", gap: "12px" }}>
              {rows.map((row) => (
                <div
                  key={row.id}
                  style={{
                    padding: "16px 18px",
                    border: "1px solid rgba(20, 35, 45, 0.12)",
                    borderRadius: "12px",
                    background: "rgba(255,255,255,0.9)",
                  }}
                >
                  <strong>{row.venue_name}</strong>

                  <div style={{ marginTop: "6px" }}>
                    Confidence: {row.confidence ?? "unknown"}
                  </div>

                  <div style={{ marginTop: "6px" }}>
                    <a
                      href={row.source_url ?? row.website_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open detected calendar
                    </a>
                  </div>

                  <div
                    style={{
                      marginTop: "6px",
                      fontSize: "0.85rem",
                      opacity: 0.65,
                    }}
                  >
                    Last seen:{" "}
                    {new Date(row.last_seen_at).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
