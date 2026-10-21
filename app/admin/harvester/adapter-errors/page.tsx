"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Finding = {
  id: string;
  venue_id: string;
  venue_name: string;
  finding_key: string;
  detector_status: string;
  source_type: string | null;
  website_url: string;
  source_url: string | null;
  fetched_url: string | null;
  error: string | null;
  evidence: unknown;
  first_seen_at: string;
  last_seen_at: string;
};

export default function AdapterErrorsPage() {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  async function resolveFinding(finding: Finding) {
    if (resolvingId) return;

    if (!window.confirm(
      `Manually resolve the ${finding.source_type ?? "adapter"} error for ${finding.venue_name}?`
    )) return;

    setResolvingId(finding.id);
    setError(null);

    try {
      const result = await supabase.rpc(
        "admin_resolve_event_harvest_adapter_error",
        { p_finding_id: finding.id }
      );

      if (result.error) {
        setError(result.error.message);
        return;
      }

      if (result.data !== 1) {
        setError("Finding was already resolved or is no longer active.");
        return;
      }

      setFindings((current) =>
        current.filter((item) => item.id !== finding.id)
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not resolve Adapter Error."
      );
    } finally {
      setResolvingId(null);
    }
  }

  useEffect(() => {
    let active = true;

    async function load() {
      const result = await supabase.rpc(
        "admin_event_harvest_adapter_error_findings"
      );

      if (!active) return;

      if (result.error) {
        setError(result.error.message);
      } else {
        setFindings((result.data ?? []) as Finding[]);
      }

      setLoading(false);
    }

    void load();
    return () => { active = false; };
  }, []);

  const spotCount = new Set(
    findings.map((finding) => finding.venue_id)
  ).size;

  return (
    <main className="flow-page">
      <div className="shell">
        <section
          className="flow-card"
          style={{ maxWidth: 1200, margin: "0 auto" }}
        >
          <Link href="/admin/harvester">
            ← Harvester Management
          </Link>

          <div className="eyebrow" style={{ marginTop: 24 }}>
            EVENT HARVESTER
          </div>
          <h1>Adapter Errors</h1>

          <p className="lead-copy">
            Source-specific adapter evaluations that could not
            complete. Successful evaluations and ordinary source
            rejection do not belong in this queue.
          </p>

          {loading ? (
            <p>Loading adapter errors...</p>
          ) : error ? (
            <p role="alert">{error}</p>
          ) : (
            <>
              <p>
                <strong>{spotCount}</strong> affected Spots ·{" "}
                <strong>{findings.length}</strong> active failures
              </p>

              {findings.length === 0 ? (
                <p>No active Adapter Errors.</p>
              ) : (
                <div style={{ display: "grid", gap: 16 }}>
                  {findings.map((finding) => (
                    <article
                      key={finding.id}
                      style={{
                        padding: 18,
                        border: "1px solid rgba(20,35,45,.15)",
                        borderRadius: 12,
                      }}
                    >
                      <h2 style={{ marginTop: 0 }}>
                        {finding.venue_name}
                      </h2>

                      <p>
                        <strong>Adapter:</strong>{" "}
                        {finding.source_type ?? "Unspecified"}
                      </p>

                      <p>
                        <strong>Status:</strong>{" "}
                        {finding.detector_status}
                      </p>

                      <p>
                        <strong>Failure:</strong>{" "}
                        {finding.error ?? "Evaluation interrupted"}
                      </p>

                      {finding.source_url && (
                        <p>
                          <a
                            href={finding.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Source URL
                          </a>
                        </p>
                      )}

                      <p>
                        <a
                          href={finding.website_url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Spot website
                        </a>
                      </p>

                      <button
                        type="button"
                        disabled={resolvingId !== null}
                        onClick={() => void resolveFinding(finding)}
                        style={{ marginBottom: 16 }}
                      >
                        {resolvingId === finding.id
                          ? "Resolving..."
                          : "Resolve error"}
                      </button>

                      <details>
                        <summary>Technical details</summary>
                        <pre style={{
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                        }}>
                          {JSON.stringify({
                            finding_key: finding.finding_key,
                            fetched_url: finding.fetched_url,
                            evidence: finding.evidence,
                            first_seen_at: finding.first_seen_at,
                            last_seen_at: finding.last_seen_at,
                          }, null, 2)}
                        </pre>
                      </details>
                    </article>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
