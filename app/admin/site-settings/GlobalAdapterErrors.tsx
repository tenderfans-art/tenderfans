"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
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

const columns =
  "1.1fr 1.4fr 1.1fr 2.6fr 1fr 0.8fr";

const cellStyle = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
};

export default function GlobalAdapterErrors() {
  const [overview, setOverview] =
    useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = overview
    ? overview.markets.flatMap((market) =>
        market.findings.map((finding) => ({
          ...finding,
          marketKey: market.market_key,
          marketName: market.display_name,
        }))
      )
    : [];

  return (
    <>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 18,
        }}
      >
        <strong>
          {overview
            ? `${overview.totals.affectedSpots} affected Spots · ${overview.totals.failures} active Tier One failures`
            : "Tier One overview"}
        </strong>

        <button
          type="button"
          className="btn outline"
          disabled={loading}
          onClick={() => void load()}
        >
          Refresh
        </button>
      </div>

      {loading && <p>Loading Adapter Errors...</p>}

      {error && (
        <p role="alert" style={{ color: "crimson" }}>
          {error}
        </p>
      )}

      {overview && (
        <>
          {overview.totals.missingMarketFailures > 0 && (
            <p role="alert">
              {overview.totals.missingMarketFailures}
              {" "}Tier One failures require Market attribution.
            </p>
          )}

          <div
            style={{
              border: "1px solid #ddd7cc",
              borderRadius: 12,
              overflowX: "auto",
            }}
          >
            <div style={{ minWidth: 1080 }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: columns,
                  gap: 14,
                  padding: "12px 16px",
                  background: "#f5f3ec",
                  fontSize: 12,
                  fontWeight: 800,
                }}
              >
                <span>Market</span>
                <span>Spot</span>
                <span>Adapter</span>
                <span>Error</span>
                <span>Last Seen</span>
                <span>Review</span>
              </div>

              {rows.map((finding) => (
                <div
                  key={finding.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: columns,
                    gap: 14,
                    padding: "11px 16px",
                    alignItems: "center",
                    borderTop: "1px solid #e5e0d7",
                    background: "#fff",
                    fontSize: 13,
                  }}
                >
                  <span style={cellStyle}>
                    {finding.marketName}
                  </span>

                  <strong style={cellStyle}>
                    {finding.venue_name}
                  </strong>

                  <span style={cellStyle}>
                    {finding.source_type ?? "Unspecified"}
                  </span>

                  <span
                    style={cellStyle}
                    title={
                      finding.error ?? "Evaluation interrupted"
                    }
                  >
                    {finding.error ??
                      "Evaluation interrupted"}
                  </span>

                  <span style={cellStyle}>
                    {new Date(
                      finding.last_seen_at
                    ).toLocaleDateString()}
                  </span>

                  <Link
                    href={
                      "/admin/harvester/adapter-errors?market=" +
                      encodeURIComponent(finding.marketKey)
                    }
                  >
                    Market HM
                  </Link>
                </div>
              ))}

              {rows.length === 0 && (
                <p style={{ padding: 16 }}>
                  No active Tier One Adapter Errors.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
