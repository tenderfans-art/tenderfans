"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Market = {
  id: string;
  market_key: string;
  display_name: string;
  is_enabled: boolean;
  spot_count: number;
};

export default function MarketsPage() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    async function load() {
      const { data: { session } } =
        await supabase.auth.getSession();

      if (!session) {
        window.location.replace("/login");
        return;
      }

      try {
        const response = await fetch("/api/admin/markets", {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
          cache: "no-store",
        });

        if (response.status === 403) {
          window.location.replace("/account");
          return;
        }

        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error ?? "Unable to load markets.");
        }

        if (active) setMarkets(result.markets ?? []);
      } catch (cause) {
        if (active) {
          setError(
            cause instanceof Error ? cause.message : "Unable to load."
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => { active = false; };
  }, []);

  return (
    <main className="flow-page">
      <div className="shell">
        <section className="flow-card"
          style={{ maxWidth: 1200, margin: "0 auto" }}>
          <Link href="/admin" className="text-link">
            ← Admin Dashboard
          </Link>
          <div className="eyebrow" style={{ marginTop: 24 }}>
            TENDERFANS ADMIN
          </div>
          <h1>Market Management</h1>
          <p className="lead-copy">
            Onboard, test and manage each TenderFans market.
            Market activation controls automated processing,
            not public Spot visibility.
          </p>

          {loading && <p>Loading markets...</p>}
          {error && <p role="alert" style={{ color: "crimson" }}>{error}</p>}

          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 18,
            marginTop: 24,
          }}>
            {markets.map((market) => (
              <Link
                key={market.id}
                href={`/admin/markets/${encodeURIComponent(market.market_key)}`}
                style={{
                  display: "block",
                  padding: 24,
                  border: "1px solid #ddd7cc",
                  borderRadius: 18,
                  background: "#fff",
                  textDecoration: "none",
                  color: "inherit",
                }}
              >
                <div style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  alignItems: "center",
                }}>
                  <h2 style={{ margin: 0 }}>{market.display_name}</h2>
                  <span style={{ fontSize: 12, fontWeight: 800 }}>
                    {market.is_enabled ? "ENABLED" : "DISABLED"}
                  </span>
                </div>
                <p style={{ marginBottom: 0, opacity: 0.7 }}>
                  {market.spot_count} assigned Spots
                </p>
              </Link>
            ))}
          </div>
          {!loading && !error && markets.length === 0 && (
            <p>No markets configured.</p>
          )}
        </section>
      </div>
    </main>
  );
}
