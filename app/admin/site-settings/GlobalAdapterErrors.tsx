"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Finding = {
  id: string;
  venue_id: string;
  venue_name: string;
  source_type: string | null;
  error: string | null;
  source_url: string | null;
  last_seen_at: string;
};

type Market = {
  id: string;
  market_key: string;
  display_name: string;
  affectedSpots: number;
  failures: number;
  findings: Finding[];
};

type Overview = {
  totals: {
    failures: number;
    affectedSpots: number;
    missingMarketFailures: number;
    missingMarketSpots: number;
  };
  markets: Market[];
};

export default function GlobalAdapterErrors() {
  const [overview, setOverview] = useState<Overview | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");

    try {
      const { data: { session } } =
        await supabase.auth.getSession();

      if (!session?.access_token) {
        throw new Error("Administrator sign-in required.");
      }

      const response = await fetch(
        "/api/admin/site-settings/adapter-errors",
        {
          headers: {
            Authorization:
              `Bearer ${session.access_token}`,
          },
          cache: "no-store",
        }
      );

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(
          payload.error ||
          "Could not load Global Adapter Errors."
        );
      }

      setOverview(payload as Overview);
    } catch (cause) {
      setOverview(null);
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load Global Adapter Errors."
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <section
      style={{
        border: "1px solid #d7d2c7",
        borderRadius: 18,
        padding: 22,
        background: "#fff",
        marginTop: 22,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h2 style={{ margin: 0 }}>
            Global Adapter Errors
          </h2>

          <p style={{ marginBottom: 0, opacity: 0.7 }}>
            Active Tier One Adapter Errors across every Market.
            Facebook errors are tracked separately in HM.
          </p>
        </div>

        <button
          type="button"
          className="btn outline"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {error && (
        <p role="alert" style={{ color: "crimson" }}>
          {error}
        </p>
      )}

      {loading && <p>Loading Tier One errors...</p>}

      {overview && (
        <>
          <p
            style={{
              fontSize: 18,
              fontWeight: 700,
              marginTop: 22,
            }}
          >
            {overview.totals.affectedSpots} affected Spots
            {" · "}
            {overview.totals.failures} active Tier One failures
          </p>

          {overview.totals.missingMarketFailures > 0 && (
            <p
              role="alert"
              style={{
                padding: 14,
                border: "1px solid #d5aa91",
                borderRadius: 10,
              }}
            >
              {overview.totals.missingMarketFailures}
              {" "}Tier One failures across{" "}
              {overview.totals.missingMarketSpots}
              {" "}Spots have no Market membership.
              This is an ownership inconsistency requiring
              investigation, not a separate review queue.
            </p>
          )}

          <div
            style={{
              display: "grid",
              gap: 14,
              marginTop: 20,
            }}
          >
            {overview.markets.map((market) => (
              <article
                key={market.id}
                style={{
                  border: "1px solid #ddd7cc",
                  borderRadius: 14,
                  padding: 18,
                  background: "#faf9f5",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: 12,
                  }}
                >
                  <h3
                    style={{
                      margin: 0,
                      fontSize: 20,
                    }}
                  >
                    {market.display_name}
                  </h3>

                  <strong>
                    {market.affectedSpots} affected Spots
                  </strong>
                </div>

                <p
                  style={{
                    margin: "10px 0 14px",
                    opacity: 0.75,
                  }}
                >
                  {market.failures} active Tier One failures
                </p>

                {market.findings.length === 0 ? (
                  <p>No active Tier One Adapter Errors.</p>
                ) : (
                  <div
                    style={{
                      display: "grid",
                      gap: 8,
                      marginBottom: 16,
                    }}
                  >
                    {market.findings.map((finding) => (
                      <details
                        key={finding.id}
                        style={{
                          border:
                            "1px solid rgba(20,35,45,.12)",
                          borderRadius: 10,
                          background: "#fff",
                        }}
                      >
                        <summary
                          style={{
                            padding: "10px 14px",
                            cursor: "pointer",
                            overflowWrap: "anywhere",
                          }}
                        >
                          <strong>
                            {finding.venue_name}
                          </strong>
                          {" · "}
                          {finding.source_type ?? "Unspecified"}
                          {" · "}
                          <span style={{ opacity: 0.75 }}>
                            {finding.error ??
                              "Evaluation interrupted"}
                          </span>
                        </summary>

                        <div
                          style={{
                            padding: "4px 14px 14px",
                            borderTop:
                              "1px solid rgba(20,35,45,.1)",
                            overflowWrap: "anywhere",
                          }}
                        >
                          <p>
                            <strong>Adapter:</strong>{" "}
                            {finding.source_type ??
                              "Unspecified"}
                          </p>

                          <p>
                            <strong>Error:</strong>{" "}
                            {finding.error ??
                              "Evaluation interrupted"}
                          </p>

                          <p>
                            <strong>Last seen:</strong>{" "}
                            {new Date(
                              finding.last_seen_at
                            ).toLocaleString()}
                          </p>

                          {finding.source_url &&
                            /^https?:\/\//i.test(
                              finding.source_url
                            ) && (
                              <a
                                href={finding.source_url}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                Open source URL
                              </a>
                            )}
                        </div>
                      </details>
                    ))}
                  </div>
                )}

                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: 12,
                  }}
                >
                  <Link
                    className="btn outline"
                    href={
                      "/admin/harvester/adapter-errors?market=" +
                      encodeURIComponent(market.market_key)
                    }
                  >
                    Market Adapter Errors
                  </Link>

                  <Link
                    className="text-link"
                    href={
                      "/admin/markets/" +
                      encodeURIComponent(market.market_key)
                    }
                  >
                    Market Dashboard
                  </Link>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
