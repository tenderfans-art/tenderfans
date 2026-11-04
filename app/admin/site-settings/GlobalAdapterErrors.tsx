"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Market = {
  id: string;
  market_key: string;
  display_name: string;
  affectedSpots: number;
  failures: number;
  facebookAffectedSpots: number;
  facebookFailures: number;
};

type Overview = {
  totals: {
    failures: number;
    affectedSpots: number;
    facebookFailures: number;
    facebookAffectedSpots: number;
    missingMarketFailures: number;
    missingMarketFacebookFailures: number;
  };
  markets: Market[];
};

const columns = "1.2fr 1.5fr 1.5fr 1.7fr";

const headingStyle = {
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: ".04em",
  opacity: 0.65,
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
            ? `${overview.totals.failures} Tier One errors · ${overview.totals.facebookFailures} Facebook errors`
            : "Market Adapter Error overview"}
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
          {(overview.totals.missingMarketFailures > 0 ||
            overview.totals.missingMarketFacebookFailures > 0) && (
            <p role="alert">
              Some Adapter Error findings have no Market
              membership and require investigation.
            </p>
          )}

          <div
            style={{
              border: "1px solid #ddd7cc",
              borderRadius: 12,
              overflowX: "auto",
            }}
          >
            <div style={{ minWidth: 950 }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: columns,
                  gap: 16,
                  padding: "12px 16px",
                  background: "#f5f3ec",
                }}
              >
                <span style={headingStyle}>Market</span>
                <span style={headingStyle}>Tier One</span>
                <span style={headingStyle}>Facebook</span>
                <span style={headingStyle}>Review</span>
              </div>

              {overview.markets.map((market) => (
                <div
                  key={market.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: columns,
                    gap: 16,
                    padding: "12px 16px",
                    alignItems: "center",
                    borderTop: "1px solid #e5e0d7",
                    background: "#fff",
                    fontSize: 13,
                  }}
                >
                  <strong>{market.display_name}</strong>

                  <span>
                    <strong>{market.affectedSpots}</strong>
                    {" Spots · "}
                    {market.failures} errors
                  </span>

                  <span>
                    <strong>
                      {market.facebookAffectedSpots}
                    </strong>
                    {" Spots · "}
                    {market.facebookFailures} errors
                  </span>

                  <div
                    style={{
                      display: "flex",
                      gap: 14,
                      whiteSpace: "nowrap",
                    }}
                  >
                    <Link
                      href={
                        "/admin/harvester/adapter-errors?market=" +
                        encodeURIComponent(market.market_key) +
                        "&tab=tier_one"
                      }
                    >
                      Tier One Review
                    </Link>

                    <Link
                      href={
                        "/admin/harvester/adapter-errors?market=" +
                        encodeURIComponent(market.market_key) +
                        "&tab=facebook"
                      }
                    >
                      Facebook Review
                    </Link>
                  </div>
                </div>
              ))}

              {overview.markets.length === 0 && (
                <p style={{ padding: 16 }}>
                  No Markets found.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
