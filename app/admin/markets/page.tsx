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
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState("");

  async function createMarket() {
    if (creating) return;
    setCreating(true);
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
          action: "create",
          name,
          key,
        }),
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.error);

      setMarkets((current) =>
        [...current, { ...result.market, spot_count: 0 }]
          .sort((a, b) =>
            a.display_name.localeCompare(b.display_name)
          )
      );
      setName("");
      setKey("");
      setNotice("Market created. Automated processing is disabled.");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Creation failed."
      );
    } finally {
      setCreating(false);
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

          <div style={{
            marginTop: 24,
            padding: 22,
            border: "1px solid #ddd7cc",
            borderRadius: 18,
          }}>
            <h2 style={{ marginTop: 0 }}>Create Market</h2>
            <div style={{
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              alignItems: "center",
            }}>
              <input
                aria-label="Market name"
                placeholder="Market name"
                value={name}
                onChange={(event) => {
                  const value = event.target.value;
                  setName(value);
                  setKey(value.toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-|-$/g, ""));
                }}
                style={{ padding: 12, flex: "1 1 220px" }}
              />
              <input
                aria-label="Market URL key"
                placeholder="market-url-key"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                style={{ padding: 12, flex: "1 1 180px" }}
              />
              <button
                className="btn primary"
                type="button"
                disabled={creating || !name.trim() || !key.trim()}
                onClick={createMarket}
              >
                {creating ? "Creating..." : "+ Create Market"}
              </button>
            </div>
            <p style={{ opacity: 0.7, marginBottom: 0 }}>
              New markets always begin with automated processing disabled.
            </p>
          </div>

          {notice && <p role="status">{notice}</p>}
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
