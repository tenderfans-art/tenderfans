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
  error: string | null;
  evidence: unknown;
  first_seen_at: string;
  last_seen_at: string;
};

export default function HtmlErrorsPage() {
  const [rows, setRows] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      const result = await supabase.rpc(
        "admin_event_harvest_html_error_findings"
      );

      if (!active) return;

      if (result.error) {
        setError(result.error.message);
      } else {
        setRows((result.data ?? []) as Finding[]);
      }

      setLoading(false);
    }

    void load();
    return () => { active = false; };
  }, []);

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
              color: "inherit"
            }}
          >
            ← Harvester Management
          </Link>

          <div className="eyebrow">EVENT HARVESTER</div>
          <h1>HTML Error</h1>

          <p className="lead-copy">
            HTML event schedules requiring extraction troubleshooting.
            Findings automatically resolve after successful extraction.
          </p>

          {loading ? (
            <p>Loading findings...</p>
          ) : error ? (
            <p role="alert">{error}</p>
          ) : rows.length === 0 ? (
            <p>No active HTML extraction errors.</p>
          ) : (
            <div style={{ display: "grid", gap: 5 }}>
              <div style={{
                display: "grid",
                gridTemplateColumns: "minmax(250px,2fr) minmax(180px,1fr) 130px 190px",
                gap: 10, padding: "0 10px",
                fontSize: ".66rem", fontWeight: 800,
                letterSpacing: ".08em", textTransform: "uppercase",
                opacity: .55
              }}>
                <span>Spot</span><span>Error</span>
                <span>Source</span><span>Last Seen</span>
              </div>
              {rows.map((finding) => (
                <details key={finding.id} style={{
                  border: "1px solid rgba(20,35,45,.12)",
                  borderRadius: 9, background: "rgba(255,255,255,.9)"
                }}>
                  <summary style={{ cursor: "pointer", listStyle: "none" }}>
                    <div style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(250px,2fr) minmax(180px,1fr) 130px 190px",
                      gap: 10, alignItems: "center",
                      padding: "7px 10px", fontSize: ".84rem"
                    }}>
                      <strong style={{
                        overflow: "hidden", textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                      }}>{finding.venue_name}</strong>
                      <span style={{
                        overflow: "hidden", textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                      }}>{finding.error ?? "Incomplete HTML extraction"}</span>
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
                  <div style={{ padding: "8px 12px 14px", fontSize: ".84rem" }}>
                    <strong>Extraction evidence</strong>
                    <pre style={{
                      whiteSpace: "pre-wrap", overflowWrap: "anywhere"
                    }}>{JSON.stringify(finding.evidence, null, 2)}</pre>
                  </div>
                </details>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
