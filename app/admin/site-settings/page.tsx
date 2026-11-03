"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import GlobalAdapterErrors from "./GlobalAdapterErrors";

type MarketReview = {
  id: string;
  market_key: string;
  display_name: string;
  googlePending: number;
  redirectPending: number;
  googleExamples: string[];
  redirectExamples: string[];
};

type Overview = {
  totals: {
    google: number;
    redirects: number;
    missingMarket: number;
  };
  markets: MarketReview[];
};

export default function SiteSettingsPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
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
        "/api/admin/site-settings/spot-review",
        {
          headers: {
            Authorization:
              `Bearer ${session.access_token}`,
          },
          cache: "no-store",
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error || "Could not load Spot Review."
        );
      }

      setOverview(data as Overview);
    } catch (cause) {
      setOverview(null);
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load Site Settings."
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const total = overview
    ? overview.totals.google +
      overview.totals.redirects
    : 0;

  return (
    <main className="flow-page">
      <div className="shell">
        <section
          className="flow-card"
          style={{
            maxWidth: 1200,
            margin: "0 auto",
          }}
        >
          <Link href="/admin" className="text-link">
            ← Admin Dashboard
          </Link>

          <div
            className="eyebrow"
            style={{ marginTop: 24 }}
          >
            TENDERFANS GLOBAL ADMIN
          </div>

          <h1 style={{ marginBottom: 8 }}>
            Site Settings
          </h1>

          <p
            className="lead-copy"
            style={{ marginBottom: 24 }}
          >
            Cross-Market oversight and platform-wide
            administrative tools.
          </p>

          <div
            style={{
              border: "1px solid #d7d2c7",
              borderRadius: 18,
              padding: 22,
              background: "#fff",
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
                  Global Spot Review
                </h2>
                <p
                  style={{
                    marginBottom: 0,
                    opacity: 0.7,
                  }}
                >
                  Pending Google Spots and website redirects
                  across every Market.
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

            {loading && <p>Loading review queues...</p>}

            {overview && (
              <>
                <p
                  style={{
                    fontSize: 18,
                    fontWeight: 700,
                    marginTop: 22,
                  }}
                >
                  {total} pending review{" "}
                  {total === 1 ? "item" : "items"}
                  {" · "}
                  {overview.totals.google} Google Spots
                  {" · "}
                  {overview.totals.redirects} website redirects
                </p>

                {overview.totals.missingMarket > 0 && (
                  <p
                    role="alert"
                    style={{
                      border: "1px solid #d5aa91",
                      padding: 14,
                      borderRadius: 10,
                    }}
                  >
                    {overview.totals.missingMarket} pending
                    review{" "}
                    {overview.totals.missingMarket === 1
                      ? "item lacks"
                      : "items lack"}{" "}
                    Market attribution. These require intake
                    correction before Market-level review.
                    No automatic Market assignment has been made.
                  </p>
                )}

                <div
                  style={{
                    display: "grid",
                    gap: 14,
                    marginTop: 20,
                  }}
                >
                  {overview.markets.map((market) => {
                    const pending =
                      market.googlePending +
                      market.redirectPending;

                    return (
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
                            {pending} pending
                          </strong>
                        </div>

                        <p
                          style={{
                            margin: "10px 0",
                            opacity: 0.75,
                          }}
                        >
                          {market.googlePending} Google Spots
                          {" · "}
                          {market.redirectPending} redirects
                        </p>

                        {market.googleExamples.length > 0 && (
                          <p style={{ fontSize: 14 }}>
                            <strong>Google:</strong>{" "}
                            {market.googleExamples.join(", ")}
                            {market.googlePending > 5 ? "…" : ""}
                          </p>
                        )}

                        {market.redirectExamples.length > 0 && (
                          <p style={{ fontSize: 14 }}>
                            <strong>Redirects:</strong>{" "}
                            {market.redirectExamples.join(", ")}
                            {market.redirectPending > 5 ? "…" : ""}
                          </p>
                        )}

                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 10,
                            marginTop: 14,
                          }}
                        >
                          <Link
                            className="btn outline"
                            href={
                              `/admin/harvester/spot-review?market=` +
                              encodeURIComponent(market.market_key) +
                              "&tab=google"
                            }
                          >
                            Google Spots ({market.googlePending})
                          </Link>

                          <Link
                            className="btn outline"
                            href={
                              `/admin/harvester/spot-review?market=` +
                              encodeURIComponent(market.market_key) +
                              "&tab=redirect"
                            }
                          >
                            Website Redirects ({market.redirectPending})
                          </Link>

                          <Link
                            className="text-link"
                            href={
                              `/admin/markets/` +
                              encodeURIComponent(market.market_key)
                            }
                          >
                            Market Dashboard
                          </Link>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          <GlobalAdapterErrors />

          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(260px, 1fr))",
              gap: 18,
              marginTop: 22,
            }}
          >
            <div
              style={{
                padding: 22,
                border: "1px solid #ddd7cc",
                borderRadius: 18,
                background: "#f5f3ec",
              }}
            >
              <h2 style={{ fontSize: 20, marginTop: 0 }}>
                Site Banners
              </h2>
              <p>
                Manage homepage hero and site-wide
                promotional banners.
              </p>
              <small>COMING SOON</small>
            </div>

            <div
              style={{
                padding: 22,
                border: "1px solid #ddd7cc",
                borderRadius: 18,
                background: "#f5f3ec",
              }}
            >
              <h2 style={{ fontSize: 20, marginTop: 0 }}>
                Platform Controls
              </h2>
              <p>
                Future global settings and administrative
                configuration.
              </p>
              <small>COMING SOON</small>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
