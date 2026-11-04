"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import GooglePlacePicker from "@/components/GooglePlacePicker";

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
  const [stateRegion, setStateRegion] = useState("");
  const [countyName, setCountyName] = useState("");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [selectedMarket, setSelectedMarket] = useState("");
  const [selectedPlace, setSelectedPlace] = useState<{
    id: string;
    name: string;
    address: string;
  } | null>(null);
  const [savingSpot, setSavingSpot] = useState(false);
  const [bulkCsv, setBulkCsv] = useState("");
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkResults, setBulkResults] = useState<Array<{
    line: number;
    name: string;
    status: string;
    detail: string;
  }>>([]);


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
          stateRegion,
          countyName,
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
      setStateRegion("");
      setCountyName("");
      setCreateOpen(false);
      setNotice("Market created. Automated processing is disabled.");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Creation failed."
      );
    } finally {
      setCreating(false);
    }
  }

  const [bulkOffset, setBulkOffset] = useState(0);

  async function importBulk() {
    if (!selectedMarket || !bulkCsv.trim() || bulkSaving) return;

    setBulkSaving(true);
    setError("");
    setNotice("");

    let offset = bulkOffset;

    try {
      const { data: { session } } =
        await supabase.auth.getSession();

      if (!session) throw new Error("Session expired.");

      while (true) {
        const response = await fetch("/api/admin/markets/bulk", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            marketId: selectedMarket,
            csv: bulkCsv,
            offset,
          }),
        });

        const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload.error || "Bulk import failed.");
        }

        if (
          !Array.isArray(payload.results) ||
          !Number.isInteger(payload.nextOffset) ||
          !Number.isInteger(payload.total) ||
          payload.nextOffset <= offset
        ) {
          throw new Error("Invalid bulk import response.");
        }

        setBulkResults((current) => [
          ...current,
          ...payload.results,
        ]);

        offset = payload.nextOffset;
        setBulkOffset(offset);

        if (offset >= payload.total) {
          setNotice(
            `CSV import finished: ${payload.total} rows processed.`
          );
          break;
        }
      }

      const refreshed = await fetch("/api/admin/markets", {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
        cache: "no-store",
      });

      if (refreshed.ok) {
        const data = await refreshed.json();
        setMarkets(data.markets ?? []);
      }
    } catch (error) {
      setError(
        (error instanceof Error ? error.message : "Import failed.") +
        ` Completed through row offset ${offset}; retry to resume.`
      );
    } finally {
      setBulkSaving(false);
    }
  }

  async function addSpot() {
    if (!selectedPlace || !selectedMarket || savingSpot) return;

    setSavingSpot(true);
    setError("");
    setNotice("");

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Session expired.");

      const response = await fetch("/api/google/place", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          placeId: selectedPlace.id,
          marketId: selectedMarket,
        }),
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Could not add Spot.");
      }

      setNotice(`${selectedPlace.name} saved to market.`);
      setSelectedPlace(null);
      setAddOpen(false);

      const refreshed = await fetch("/api/admin/markets", {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
        cache: "no-store",
      });

      if (refreshed.ok) {
        const data = await refreshed.json();
        setMarkets(data.markets ?? []);
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not add Spot."
      );
    } finally {
      setSavingSpot(false);
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
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 12,
          }}>
            <h1 style={{ margin: 0 }}>Market Management</h1>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                className="btn primary"
                type="button"
                onClick={() => setCreateOpen(true)}
              >
                + Create Market
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setSelectedMarket(
                    markets.length === 1 ? markets[0].id : ""
                  );
                  setBulkCsv("");
                  setBulkOffset(0);
                  setBulkResults([]);
                  setBulkOpen(true);
                }}
              >
                Bulk Spot Add
              </button>
            </div>
          </div>
          <p className="lead-copy">
            Onboard, test and manage each TenderFans market.
            Market activation controls automated processing,
            not public Spot visibility.
          </p>

          {createOpen && (
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Create Market"
              style={{
                position: "fixed",
                inset: 0,
                zIndex: 1000,
                background: "rgba(10,20,28,.58)",
                display: "grid",
                placeItems: "center",
                padding: 20,
              }}
            >
              <div style={{
                background: "#fff",
                borderRadius: 18,
                padding: 24,
                width: "100%",
                maxWidth: 620,
              }}>
                <button
                  type="button"
                  disabled={creating}
                  onClick={() => setCreateOpen(false)}
                  style={{ float: "right" }}
                >
                  Close
                </button>
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
                readOnly
                title="Automatically generated from the Market name"
                style={{ padding: 12, flex: "1 1 180px" }}
              />
              <input
                aria-label="State abbreviation"
                placeholder="State (e.g. FL)"
                value={stateRegion}
                maxLength={2}
                onChange={(event) =>
                  setStateRegion(event.target.value.toUpperCase())
                }
                style={{ padding: 12, width: 130 }}
              />
              <input
                aria-label="County name"
                placeholder="County (e.g. Pinellas County)"
                value={countyName}
                onChange={(event) =>
                  setCountyName(event.target.value)
                }
                style={{ padding: 12, flex: "1 1 220px" }}
              />
              <button
                className="btn primary"
                type="button"
                disabled={
                  creating ||
                  !name.trim() ||
                  !key.trim() ||
                  !/^[A-Z]{2}$/.test(stateRegion) ||
                  !countyName.trim()
                }
                onClick={createMarket}
              >
                {creating ? "Creating..." : "+ Create Market"}
              </button>
            </div>
            <p style={{ opacity: 0.7, marginBottom: 0 }}>
              New markets always begin with automated processing disabled.
            </p>
          </div>

              </div>
            </div>
          )}

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
              <article
                key={market.id}
                style={{
                  padding: 24,
                  border: "1px solid #ddd7cc",
                  borderRadius: 18,
                  background: "#fff",
                }}
              >
                <div style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: 12,
                }}>
                  <Link
                    href={`/admin/markets/${encodeURIComponent(market.market_key)}`}
                    style={{
                      color: "inherit",
                      textDecoration: "none",
                    }}
                  >
                    <h2 style={{ margin: 0 }}>
                      {market.display_name}
                    </h2>
                  </Link>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setSelectedMarket(market.id);
                      setSelectedPlace(null);
                      setAddOpen(true);
                    }}
                  >
                    + Add Spot
                  </button>
                </div>
                <p style={{ marginBottom: 0, opacity: 0.7 }}>
                  {market.spot_count} assigned Spots ·{" "}
                  {market.is_enabled ? "ENABLED" : "DISABLED"}
                </p>
              </article>
            ))}
          </div>
          {!loading && !error && markets.length === 0 && (
            <p>No markets configured.</p>
          )}
          {(addOpen || bulkOpen) && (
            <div
              role="dialog"
              aria-modal="true"
              aria-label={addOpen ? "Add Spot" : "Bulk Spot Add"}
              style={{
                position: "fixed",
                inset: 0,
                zIndex: 1000,
                background: "rgba(10,20,28,.58)",
                display: "grid",
                placeItems: "center",
                padding: 20,
              }}
            >
              <div style={{
                background: "#fff",
                borderRadius: 18,
                padding: 24,
                width: "100%",
                maxWidth: 620,
              }}>
                <button
                  type="button"
                  disabled={savingSpot || bulkSaving}
                  onClick={() => {
                    setAddOpen(false);
                    setBulkOpen(false);
                    setSelectedPlace(null);
                  }}
                  style={{ float: "right" }}
                >
                  Close
                </button>

                <h2>{addOpen ? "Add a Spot" : "Bulk Spot Add"}</h2>

                <label htmlFor="market-assignment">Market</label>
                <select
                  id="market-assignment"
                  value={selectedMarket}
                  onChange={(event) => {
                    setSelectedMarket(event.target.value);
                    setBulkOffset(0);
                    setBulkResults([]);
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: 12,
                    margin: "10px 0 20px",
                  }}
                >
                  <option value="">Select a market</option>
                  {markets.map((market) => (
                    <option key={market.id} value={market.id}>
                      {market.display_name}
                    </option>
                  ))}
                </select>

                {addOpen ? (
                  <>
                    <GooglePlacePicker
                      onSelect={(place) => setSelectedPlace(place)}
                    />
                    {selectedPlace && (
                      <div style={{ marginTop: 20 }}>
                        <strong>{selectedPlace.name}</strong>
                        <p>{selectedPlace.address}</p>
                        <button
                          type="button"
                          className="btn primary"
                          disabled={savingSpot || !selectedMarket}
                          onClick={addSpot}
                        >
                          {savingSpot ? "Adding..." : "Add to Market"}
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ display: "grid", gap: 12 }}>
                    <p>
                      Upload up to 1,000 Spots per CSV.
                      Required columns: <code>name,address</code>.
                      Quote addresses containing commas.
                      Confident Google matches are automatically
                      onboarded; discrepancies go to Spot Review.
                    </p>
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      aria-label="Spot CSV file"
                      disabled={bulkSaving}
                      onChange={async (event) => {
                        const file = event.target.files?.[0];
                        if (!file) return;
                        if (file.size > 250000) {
                          setError("CSV must be 250 KB or smaller.");
                          return;
                        }
                        setError("");
                        setBulkCsv(await file.text());
                        setBulkOffset(0);
                        setBulkResults([]);
                      }}
                    />
                    <button
                      type="button"
                      className="btn primary"
                      disabled={
                        bulkSaving || !selectedMarket || !bulkCsv.trim()
                      }
                      onClick={importBulk}
                    >
                      {bulkSaving
                        ? "Processing..."
                        : bulkOffset > 0
                          ? "Resume Import"
                          : "Import CSV"}
                    </button>
                    {bulkResults.length > 0 && (
                      <div style={{
                        maxHeight: 300,
                        overflowY: "auto",
                        borderTop: "1px solid #ddd",
                      }}>
                        {bulkResults.map((item) => (
                          <p key={item.line}>
                            <strong>
                              Row {item.line}: {item.name}
                            </strong>
                            {" — "}{item.status}
                            <span style={{ display: "block" }}>
                              {item.detail}
                            </span>
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
