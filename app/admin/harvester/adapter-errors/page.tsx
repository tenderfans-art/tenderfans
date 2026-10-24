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
  const [activeTab, setActiveTab] = useState<"tier_one" | "facebook">(
    "tier_one"
  );
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

  const isFacebookError = (finding: Finding) =>
    finding.source_type === "facebook" ||
    finding.source_type === "facebook_events";

  const facebookFindings = findings.filter(isFacebookError);
  const tierOneFindings = findings.filter(
    (finding) => !isFacebookError(finding)
  );

  const visibleFindings =
    activeTab === "facebook" ? facebookFindings : tierOneFindings;

  const tierOneSpotCount = new Set(
    tierOneFindings.map((finding) => finding.venue_id)
  ).size;

  const facebookSpotCount = new Set(
    facebookFindings.map((finding) => finding.venue_id)
  ).size;

  const failureCategory = (finding: Finding) => {
    const message = finding.error ?? "Evaluation interrupted";

    if (
      /HTTP (403|429|503)\b|access restricted|access challenge|verification interstitial|verification challenge/i.test(
        message
      )
    ) {
      return "access_restricted";
    }

    return `message:${message}`;
  };

  const groupedFindings = new Map<string, Finding[]>();

  for (const finding of visibleFindings) {
    const key = JSON.stringify([
      finding.venue_id,
      finding.source_type,
      failureCategory(finding),
    ]);

    const group = groupedFindings.get(key) ?? [];
    group.push(finding);
    groupedFindings.set(key, group);
  }

  const visibleGroups = Array.from(groupedFindings.values());

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

              <div
                role="tablist"
                aria-label="Adapter error categories"
                style={{
                  display: "flex",
                  gap: 12,
                  margin: "20px 0",
                }}
              >
                {([
                  ["tier_one", "Tier One", tierOneSpotCount],
                  ["facebook", "Facebook", facebookSpotCount],
                ] as const).map(([key, label, count]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === key}
                    onClick={() => setActiveTab(key)}
                    style={{
                      padding: "10px 18px",
                      borderRadius: 8,
                      fontWeight: activeTab === key ? 700 : 400,
                      opacity: activeTab === key ? 1 : 0.7,
                    }}
                  >
                    {label} ({count})
                  </button>
                ))}
              </div>

              {visibleFindings.length === 0 ? (
                <p>No active {activeTab === "facebook"
                  ? "Facebook"
                  : "Tier One"} Adapter Errors.</p>
              ) : (
                <div style={{ display: "grid", gap: 16 }}>
                  {visibleGroups.map((group) => {
                    const finding = group[0];

                    return (
                      <details
                        key={group.map((item) => item.id).sort().join(":")}
                        style={{
                          border: "1px solid rgba(20,35,45,.15)",
                          borderRadius: 8,
                          overflow: "hidden",
                        }}
                      >
                        <summary
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 12,
                            padding: "9px 14px",
                            cursor: "pointer",
                            listStyle: "none",
                          }}
                        >
                          <span
                            style={{
                              display: "flex",
                              alignItems: "center",
                              flexWrap: "wrap",
                              gap: 10,
                              minWidth: 0,
                            }}
                          >
                            <strong>{finding.venue_name}</strong>
                            <span style={{ opacity: 0.45 }}>|</span>
                            <span>{finding.source_type ?? "Unspecified"}</span>
                            <span style={{ opacity: 0.45 }}>|</span>
                            <span>
                              {failureCategory(finding) === "access_restricted"
                                ? "Access restricted"
                                : finding.error ?? "Evaluation interrupted"}
                            </span>
                          </span>
                          <span
                            aria-hidden="true"
                            style={{ flexShrink: 0, fontSize: 14 }}
                          >
                            ▾
                          </span>
                        </summary>

                        <div
                          style={{
                            padding: "8px 14px 14px",
                            borderTop: "1px solid rgba(20,35,45,.10)",
                          }}
                        >
                          <p>
                            <strong>Status:</strong>{" "}
                            {finding.detector_status}
                          </p>

                          <p>
                            <a
                              href={finding.website_url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Spot website
                            </a>
                          </p>

                          <p style={{ fontWeight: 600 }}>
                            {group.length} error{" "}
                            {group.length === 1 ? "instance" : "instances"}
                          </p>

                          {group.map((item) => (
                            <div
                              key={item.id}
                              style={{
                                padding: "10px 0",
                                borderTop: "1px solid rgba(20,35,45,.12)",
                              }}
                            >
                              <p>
                                <strong>Error:</strong>{" "}
                                {item.error ?? "Evaluation interrupted"}
                              </p>

                              {item.source_url && (
                                <p>
                                  <a
                                    href={item.source_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    Source URL
                                  </a>
                                </p>
                              )}

                              <button
                                type="button"
                                disabled={resolvingId !== null}
                                onClick={() => void resolveFinding(item)}
                              >
                                {resolvingId === item.id
                                  ? "Resolving..."
                                  : "Resolve this finding"}
                              </button>

                              <details style={{ marginTop: 10 }}>
                                <summary>Technical details</summary>
                                <pre style={{
                                  whiteSpace: "pre-wrap",
                                  overflowWrap: "anywhere",
                                }}>
                                  {JSON.stringify({
                                    finding_key: item.finding_key,
                                    fetched_url: item.fetched_url,
                                    evidence: item.evidence,
                                    first_seen_at: item.first_seen_at,
                                    last_seen_at: item.last_seen_at,
                                  }, null, 2)}
                                </pre>
                              </details>
                            </div>
                          ))}
                        </div>
                      </details>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
