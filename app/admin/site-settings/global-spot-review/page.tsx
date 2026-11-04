"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type MarketReview = {
  id: string;
  market_key: string;
  display_name: string;
  googlePending: number;
  redirectPending: number;
};

type Overview = {
  totals: {
    google: number;
    redirects: number;
    missingMarket: number;
  };
  markets: MarketReview[];
};

const headingStyle = {
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: ".04em",
  opacity: 0.65,
};

const cellStyle = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
};

export default function GlobalSpotReviewPage() {
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
        "/api/admin/site-settings/spot-review",
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
          payload.error || "Could not load Spot Review."
        );
      }

      setOverview(payload as Overview);
    } catch (cause) {
      setOverview(null);
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load Spot Review."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const total = overview
    ? overview.totals.google + overview.totals.redirects
    : 0;

  return (
    <main className="flow-page">
      <div className="shell">
        <section
          className="flow-card"
          style={{ maxWidth: 1200, margin: "0 auto" }}
        >
          <Link href="/admin/site-settings">
            ← Site Settings
          </Link>

          <div
            className="eyebrow"
            style={{ marginTop: 24 }}
          >
            TENDERFANS GLOBAL ADMIN
          </div>

          <h1>Global Spot Review</h1>

          <p className="lead-copy">
            Pending Google Spots and website redirects
            across all Markets.
          </p>

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
                ? `${total} pending · ${overview.totals.google} Google · ${overview.totals.redirects} redirects`
                : "Market review overview"}
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

          {loading && <p>Loading Spot Reviews...</p>}
          {error && (
            <p role="alert" style={{ color: "crimson" }}>
              {error}
            </p>
          )}

          {overview && (
            <>
              {overview.totals.missingMarket > 0 && (
                <p role="alert">
                  {overview.totals.missingMarket} pending
                  reviews require Market attribution.
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
                      gridTemplateColumns:
                        "1.2fr 1.5fr 1.5fr 1.7fr",
                      gap: 16,
                      padding: "12px 16px",
                      background: "#f5f3ec",
                    }}
                  >
                    <span style={headingStyle}>Market</span>
                    <span style={headingStyle}>Google Spots</span>
                    <span style={headingStyle}>Redirects</span>
                    <span style={headingStyle}>Review</span>
                  </div>

                  {overview.markets.map((market) => (
                    <div
                      key={market.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "1.2fr 1.5fr 1.5fr 1.7fr",
                        gap: 16,
                        padding: "12px 16px",
                        alignItems: "center",
                        borderTop: "1px solid #e5e0d7",
                        background: "#fff",
                        fontSize: 13,
                      }}
                    >
                      <strong style={cellStyle}>
                        {market.display_name}
                      </strong>

                      <span style={cellStyle}>
                        <strong>{market.googlePending}</strong>
                      </span>

                      <span style={cellStyle}>
                        <strong>{market.redirectPending}</strong>
                      </span>

                      <div
                        style={{
                          display: "flex",
                          gap: 14,
                          flexWrap: "nowrap",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <Link
                          href={
                            "/admin/harvester/spot-review?market=" +
                            encodeURIComponent(market.market_key) +
                            "&tab=google"
                          }
                        >
                          Google Review
                        </Link>

                        <Link
                          href={
                            "/admin/harvester/spot-review?market=" +
                            encodeURIComponent(market.market_key) +
                            "&tab=redirect"
                          }
                        >
                          Redirect Review
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
        </section>
      </div>
    </main>
  );
}
