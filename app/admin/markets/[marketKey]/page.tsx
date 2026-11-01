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
    action: "assign-unassigned" | "set-enabled",
    enabled?: boolean
  ) {
    if (!market || busy) return;

    const question = action === "assign-unassigned"
      ? `Assign all currently unassigned Spots to ${market.display_name}? Existing market memberships will be preserved.`
      : enabled
        ? `Enable automated Workflow processing for ${market.display_name}? Only do this after completing market testing.`
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

      if (action === "set-enabled") {
        setMarket((current) =>
          current ? { ...current, is_enabled: Boolean(enabled) } : current
        );
        setNotice(
          enabled ? "Automated processing enabled." :
            "Automated processing disabled."
        );
      } else {
        setMarket((current) =>
          current ? {
            ...current,
            spot_count: current.spot_count + result.added,
          } : current
        );
        setNotice(result.message);
      }
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
              <h1>{market.display_name}</h1>
              <p>
                <strong>
                  {market.is_enabled ? "Enabled" : "Disabled"}
                </strong>
                {" · "}{market.spot_count} assigned Spots
              </p>
              <p style={{ opacity: 0.75 }}>
                Automated processing is controlled separately from
                manual Admin testing and review.
              </p>
              <section style={{
                border: "1px solid #ddd7cc",
                borderRadius: 18,
                padding: 20,
                marginTop: 24,
                marginBottom: 24,
              }}>
                <h2 style={{ marginTop: 0 }}>Market Controls</h2>
                <div style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 12,
                }}>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || market.is_enabled}
                    onClick={() => operate("assign-unassigned")}
                  >
                    Assign Unassigned Spots
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={busy}
                    onClick={() =>
                      operate("set-enabled", !market.is_enabled)
                    }
                  >
                    {market.is_enabled
                      ? "Disable Automated Processing"
                      : "Enable Automated Processing"}
                  </button>
                </div>
                <p style={{ opacity: 0.7, marginBottom: 0 }}>
                  Bulk assignment never transfers Spots already assigned
                  to another market. Manual review and testing remain
                  separate from automated processing.
                </p>
                {notice && <p role="status">{notice}</p>}
              </section>
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
                    <small>
                      Market-scoped operations being connected
                    </small>
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
