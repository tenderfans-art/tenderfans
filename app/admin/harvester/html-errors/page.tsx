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
            <div style={{ display: "grid", gap: 12 }}>
              {rows.map((finding) => (
                <div
                  key={finding.id}
                  style={{
                    padding: 16,
                    border: "1px solid rgba(20,35,45,.14)",
                    borderRadius: 12,
                    background: "rgba(255,255,255,.9)"
                  }}
                >
                  <strong>{finding.venue_name}</strong>
                  <p>{finding.error ?? "Incomplete HTML extraction"}</p>

                  <a
                    href={finding.source_url ?? finding.website_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open Event Source
                  </a>

                  <details style={{ marginTop: 12 }}>
                    <summary>Extraction evidence</summary>
                    <pre style={{
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere"
                    }}>
                      {JSON.stringify(finding.evidence, null, 2)}
                    </pre>
                  </details>

                  <p style={{ opacity: 0.65, fontSize: ".8rem" }}>
                    Last seen: {new Date(
                      finding.last_seen_at
                    ).toLocaleString()}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
