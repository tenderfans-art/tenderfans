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

export default function SourceOwnershipPanel() {
  const [rows, setRows] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      const result = await supabase.rpc(
        "admin_event_harvest_source_ownership_findings"
      );

      if (!active) return;

      if (result.error) {
        setError(result.error.message);
      } else {
        const findings = (result.data ?? []) as Finding[];

        setRows(
          [...findings].sort(
            (a, b) =>
              a.venue_name.localeCompare(b.venue_name) ||
              a.source_url?.localeCompare(b.source_url ?? "") ||
              0
          )
        );
      }

      setLoading(false);
    }

    void load();
    return () => { active = false; };
  }, []);

  async function review(finding: Finding, approve: boolean) {
    if (!window.confirm(
      `${approve ? "Approve and register" : "Reject"} HTML source for ${finding.venue_name}?`
    )) return;

    setReviewing(finding.id);
    setActionError(null);

    const { error: reviewError } = await supabase.rpc(
      "admin_review_html_source_ownership",
      {
        p_finding_id: finding.id,
        p_approve: approve,
        p_venue_id: finding.venue_id,
      }
    );

    if (reviewError) {
      setActionError(reviewError.message);
    } else {
      setRows(current => current.filter(row => row.id !== finding.id));
    }

    setReviewing(null);
  }

  return (
    <div>
          {actionError && <p role="alert">{actionError}</p>}
          {loading ? (
            <p>Loading findings...</p>
          ) : error ? (
            <p role="alert">{error}</p>
          ) : rows.length === 0 ? (
            <p>No active source ownership conflicts.</p>
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
                      }}>{finding.error ?? "Ownership requires review"}</span>
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
                    <strong>Ownership evidence</strong>
                    <pre style={{
                      whiteSpace: "pre-wrap", overflowWrap: "anywhere"
                    }}>{JSON.stringify(finding.evidence, null, 2)}</pre>
                    <div style={{
                      display: "flex",
                      gap: 12,
                      marginTop: 12
                    }}>
                      <button
                        type="button"
                        disabled={reviewing !== null}
                        onClick={() => void review(finding, true)}
                      >
                        {reviewing === finding.id
                          ? "Processing..."
                          : "Approve source for this Spot"}
                      </button>
                      <button
                        type="button"
                        disabled={reviewing !== null}
                        onClick={() => void review(finding, false)}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                </details>
              ))}
            </div>
          )}
    </div>
  );
}
