"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase";

type Market = {
  id: string;
  market_key: string;
  display_name: string;
  is_enabled: boolean;
  spot_count: number;
};

const tools = [
  ["Verification Requests", "Review claims and ownership requests."],
  ["Harvester Management", "Detector, Harvester and review operations."],
  ["Manage Spots", "Manage market Spot profiles."],
  ["Manage Tenders", "Manage Tenders associated with market Spots."],
  ["Events", "Manage market events."],
  ["Contests", "Manage market contests."],
];

export default function MarketDashboard() {
  const params = useParams();
  const key = String(params.marketKey ?? "");
  const [market, setMarket] = useState<Market | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  async function operate(
    action: "set-enabled",
    enabled?: boolean
  ) {
    if (!market || busy) return;

    const question = enabled
      ? `Enable automated Workflow processing for ${market.display_name}?`
      : `Disable automated Workflow processing for ${market.display_name}?`;

    if (!window.confirm(question)) return;

    setBusy(true);
    setError("");
    setNotice("");

    try {
      const { data: { session } } =
        await supabase.auth.getSession();

      if (!session) throw new Error("Session expired.");

      const response = await fetch("/api/admin/markets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          action,
          marketId: market.id,
          enabled,
        }),
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.error);

      setMarket((current) =>
        current ? { ...current, is_enabled: Boolean(enabled) } : current
      );
      setNotice(
        enabled ? "Automated processing enabled." :
          "Automated processing disabled."
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Operation failed."
      );
    } finally {
      setBusy(false);
    }
  }

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
          throw new Error(result.error ?? "Unable to load market.");
        }

        const found = (result.markets as Market[]).find(
          (item) => item.market_key === key
        );

        if (!found) throw new Error("Market not found.");
        if (active) setMarket(found);
      } catch (cause) {
        if (active) setError(
          cause instanceof Error ? cause.message : "Unable to load."
        );
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => { active = false; };
  }, [key]);

  return (
    <main className="flow-page">
      <div className="shell">
        <section className="flow-card"
          style={{ maxWidth: 1200, margin: "0 auto" }}>
          <Link href="/admin/markets" className="text-link">
            ← Market Management
          </Link>
          {loading && <p>Loading market...</p>}
          {error && <p role="alert" style={{ color: "crimson" }}>{error}</p>}
          {market && (
            <>
              <div className="eyebrow" style={{ marginTop: 24 }}>
                TENDERFANS MARKET
              </div>
              <div style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 16,
              }}>
                <h1 style={{ margin: 0 }}>{market.display_name}</h1>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy}
                  onClick={() =>
                    operate("set-enabled", !market.is_enabled)
                  }
                >
                  {market.is_enabled ? "Disable" : "Enable"}
                </button>
              </div>
              <p style={{ marginTop: 18 }}>
                <strong>
                  {market.is_enabled ? "Enabled" : "Disabled"}
                </strong>
                {" · "}{market.spot_count} assigned Spots
              </p>
              {notice && <p role="status">{notice}</p>}
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                gap: 18,
                marginTop: 24,
              }}>
                {tools.map(([title, description]) => (
                  <div key={title} style={{
                    padding: 22,
                    border: "1px solid #ddd7cc",
                    borderRadius: 18,
                    background: "#f5f3ec",
                  }}>
                    <h2 style={{ fontSize: 20, marginTop: 0 }}>{title}</h2>
                    <p>{description}</p>
                    {title === "Verification Requests" ? (
                      <Link
                        className="btn outline"
                        href={`/admin/claims?market=${encodeURIComponent(market.market_key)}`}
                      >
                        Verification Requests
                      </Link>
                    ) : title === "Harvester Management" ? (
                      <Link
                        className="btn outline"
                        href={`/admin/harvester?market=${encodeURIComponent(market.market_key)}`}
                      >
                        Harvester Management
                      </Link>
                    ) : title === "Manage Spots" ? (
                      <Link
                        className="btn outline"
                        href={`/admin/spots?market=${encodeURIComponent(market.market_key)}`}
                      >
                        Manage Spots
                      </Link>
                    ) : title === "Manage Tenders" ? (
                      <Link
                        className="btn outline"
                        href={`/admin/tenders?market=${encodeURIComponent(market.market_key)}`}
                      >
                        Manage Tenders
                      </Link>
                    ) : title === "Events" ? (
                      <Link
                        className="btn outline"
                        href={`/admin/events?market=${encodeURIComponent(market.market_key)}`}
                      >
                        Manage Events
                      </Link>
                    ) : title === "Contests" ? (
                      <Link
                        className="btn outline"
                        href={`/admin/contests?market=${encodeURIComponent(market.market_key)}`}
                      >
                        Manage Contests
                      </Link>
                    ) : (
                      <small>
                        Market-scoped operations being connected
                      </small>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
