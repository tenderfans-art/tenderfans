"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import GooglePlacePicker from "@/components/GooglePlacePicker";
import { supabase } from "@/lib/supabase";
import {
  loadMarketDirectory,
  performMarketDirectoryAction,
  type MarketDirectoryInfo,
} from "@/lib/admin-market-directory";

type GooglePlace = {
  id: string;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  city: string;
  state: string;
  postalCode: string;
  streetAddress: string;
  publicPhone: string;
  websiteUrl: string;
  regularHours: string[];
};

type Spot = {
  id: string;
  name: string;
  slug: string;
  city: string;
  state_region: string;
  status: string;
  manager_name: string | null;
  manager_role: string | null;
  manager_email: string | null;
};

export default function AdminSpotsPage() {
  const [marketKey, setMarketKey] = useState("");
  const [market, setMarket] =
    useState<MarketDirectoryInfo | null>(null);
  const [displayLimit, setDisplayLimit] = useState(100);
  const [loading, setLoading] = useState(true);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [search, setSearch] = useState("");
  const [listMessage, setListMessage] = useState("");

  const [addOpen, setAddOpen] = useState(false);
  const [selectedPlace, setSelectedPlace] =
    useState<GooglePlace | null>(null);
  const [saving, setSaving] = useState(false);
  const [addMessage, setAddMessage] = useState("");

  async function loadSpots(key = marketKey) {
    if (key) {
      try {
        const payload = await loadMarketDirectory(key, "spots");
        setMarket(payload.market);
        setSpots((payload.spots ?? []) as Spot[]);
        setListMessage("");
      } catch (error) {
        setMarket(null);
        setSpots([]);
        setListMessage(
          error instanceof Error ? error.message : "Could not load Market."
        );
      }
      return;
    }

    const { data, error } = await supabase.rpc("admin_list_spots");

    if (error) {
      setListMessage(error.message);
      return;
    }

    setSpots((data ?? []) as Spot[]);
  }

  useEffect(() => {
    async function initialize() {
      const key =
        new URLSearchParams(window.location.search)
          .get("market") ?? "";
      setMarketKey(key);

      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        window.location.href = "/login";
        return;
      }

      const { data: admin } = await supabase
        .from("platform_admins")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!admin) {
        window.location.href = "/account";
        return;
      }

      await loadSpots(key);
      setLoading(false);
    }

    initialize();
  }, []);

  const visibleSpots = useMemo(() => {
    const term = search.trim().toLowerCase();

    const matches = term
      ? spots.filter((spot) => {
          const haystack = [
            spot.name,
            spot.city,
            spot.state_region,
            spot.manager_name,
            spot.manager_role,
            spot.manager_email,
            spot.status,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();

          return haystack.includes(term);
        })
      : spots;

    return matches.slice(
      0,
      marketKey ? displayLimit : 5
    );
  }, [spots, search, marketKey, displayLimit]);

  async function addSpot() {
    if (!selectedPlace || saving) return;

    setSaving(true);
    setAddMessage("");

    try {
      const session = marketKey
        ? (await supabase.auth.getSession()).data.session
        : null;

      if (marketKey && (!market || !session?.access_token)) {
        throw new Error("Market Admin session unavailable.");
      }

      const response = await fetch("/api/google/place", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(marketKey && session?.access_token
            ? { Authorization: `Bearer ${session.access_token}` }
            : {}),
        },
        body: JSON.stringify({
          placeId: selectedPlace.id,
          ...(marketKey && market
            ? { marketId: market.id }
            : {}),
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Could not add Spot.");
      }

      setAddMessage(
        `${result.place?.name ?? selectedPlace.name} is in TenderFans.`
      );
      setSelectedPlace(null);
      await loadSpots();
    } catch (error) {
      setAddMessage(
        error instanceof Error
          ? error.message
          : "Could not add Spot."
      );
    } finally {
      setSaving(false);
    }
  }

  async function removeSpot(spot: Spot) {
    if (spot.status === "removed") return;

    const confirmed = window.confirm(
      `Remove ${spot.name} from TenderFans?\n\n` +
        `This is intended for policy enforcement or other exceptional circumstances. ` +
        `The Spot will no longer be publicly available, but its historical TenderFans records will be retained.`
    );

    if (!confirmed) return;

    setListMessage("");

    try {
      if (marketKey) {
        await performMarketDirectoryAction(marketKey, {
          action: "remove-spot",
          venueId: spot.id,
        });
      } else {
        const { error } = await supabase.rpc("admin_remove_spot", {
          p_venue_id: spot.id,
        });

        if (error) throw new Error(error.message);
      }
    } catch (error) {
      setListMessage(
        error instanceof Error ? error.message : "Could not remove Spot."
      );
      return;
    }

    setSpots((current) =>
      current.map((item) =>
        item.id === spot.id
          ? { ...item, status: "removed" }
          : item
      )
    );
  }

  function closeAddModal() {
    if (saving) return;

    setAddOpen(false);
    setSelectedPlace(null);
    setAddMessage("");
  }

  if (loading) {
    return (
      <main className="flow-page">
        <div className="shell">
          <section
            className="flow-card"
            style={{ maxWidth: "1100px", margin: "0 auto" }}
          >
            <p style={{ margin: 0 }}>Loading...</p>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="flow-page">
      <div className="shell">
        <section
          className="flow-card"
          style={{
            maxWidth: "1100px",
            margin: "0 auto",
          }}
        >
          {marketKey && (
            <Link
              href={`/admin/markets/${encodeURIComponent(marketKey)}`}
              className="text-link"
            >
              ← Market Dashboard
            </Link>
          )}

          <div className="eyebrow" style={{ marginTop: 18 }}>
            {market ? `TENDERFANS MARKET · ${market.display_name}`
              : "TENDERFANS ADMIN"}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "16px",
              flexWrap: "wrap",
              marginBottom: "24px",
            }}
          >
            <h1 style={{ margin: 0 }}>Manage Spots</h1>

            <button
              type="button"
              className="btn"
              onClick={() => setAddOpen(true)}
            >
              + Add Spot
            </button>
          </div>

          {market && (
            <p>
              <strong>{spots.length}</strong> assigned Spots
              {" · "}Showing {visibleSpots.length}
            </p>
          )}

          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search Spots..."
            aria-label="Search Spots"
            style={{
              width: "100%",
              padding: "12px 14px",
              border: "1px solid #d7d1c6",
              borderRadius: "12px",
              font: "inherit",
              marginBottom: "20px",
            }}
          />

          {listMessage && (
            <p
              style={{
                color: "crimson",
                marginTop: 0,
                marginBottom: "18px",
              }}
            >
              {listMessage}
            </p>
          )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "minmax(220px, 1.5fr) minmax(130px, 1fr) 120px minmax(190px, 1.2fr) 80px 110px",
              gap: "12px",
              padding: "0 8px 9px",
              fontSize: "0.72rem",
              fontWeight: 800,
              letterSpacing: "0.05em",
              opacity: 0.65,
            }}
          >
            <div>SPOT</div>
            <div>MANAGER</div>
            <div>ROLE</div>
            <div>EMAIL</div>
            <div>STATUS</div>
            <div />
          </div>

          {visibleSpots.length === 0 ? (
            <p style={{ opacity: 0.7 }}>
              No Spots match your search.
            </p>
          ) : (
            <div>
              {visibleSpots.map((spot) => (
                <div
                  key={spot.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "minmax(220px, 1.5fr) minmax(130px, 1fr) 120px minmax(190px, 1.2fr) 80px 110px",
                    gap: "12px",
                    alignItems: "center",
                    padding: "13px 8px",
                    borderTop: "1px solid #e3ded4",
                    fontSize: "0.88rem",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <Link
                      href={`/s/${spot.slug}`}
                      style={{
                        display: "block",
                        color: "inherit",
                        fontWeight: 800,
                        textDecoration: "none",
                        lineHeight: 1.25,
                      }}
                    >
                      {spot.name}
                    </Link>

                    <div
                      style={{
                        marginTop: "3px",
                        opacity: 0.55,
                        fontSize: "0.78rem",
                        lineHeight: 1.2,
                      }}
                    >
                      {spot.city}, {spot.state_region}
                    </div>
                  </div>

                  <div>
                    {spot.manager_name ?? "Unclaimed"}
                  </div>

                  <div>
                    {spot.manager_role ?? "—"}
                  </div>

                  <div
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={spot.manager_email ?? undefined}
                  >
                    {spot.manager_email ?? "—"}
                  </div>

                  <div
                    style={{
                      fontWeight: 700,
                      textTransform: "capitalize",
                    }}
                  >
                    {spot.status}
                  </div>

                  <button
                    type="button"
                    disabled={spot.status === "removed"}
                    onClick={() => removeSpot(spot)}
                    style={{
                      padding: "7px 10px",
                      border: "1px solid #d7d1c6",
                      borderRadius: "9px",
                      background: "transparent",
                      cursor:
                        spot.status === "removed"
                          ? "default"
                          : "pointer",
                      opacity:
                        spot.status === "removed"
                          ? 0.45
                          : 1,
                      fontWeight: 700,
                    }}
                  >
                    {spot.status === "removed"
                      ? "Removed"
                      : "Remove"}
                  </button>
                </div>
              ))}
            </div>
          )}

          {marketKey &&
            visibleSpots.length >= displayLimit &&
            displayLimit < spots.length && (
              <button
                type="button"
                className="btn outline"
                onClick={() => setDisplayLimit(current => current + 100)}
                style={{ marginTop: 20 }}
              >
                Show more Spots
              </button>
            )}

          <div style={{ marginTop: "30px" }}>
            <Link
              href={marketKey
                ? `/admin/markets/${encodeURIComponent(marketKey)}`
                : "/admin"}
              className="text-link"
            >
              ← Back to Admin Dashboard
            </Link>
          </div>
        </section>
      </div>

      {addOpen && (
        <div
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeAddModal();
            }
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(10, 20, 28, 0.58)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px",
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-spot-title"
            style={{
              width: "100%",
              maxWidth: "620px",
              background: "#fff",
              borderRadius: "18px",
              padding: "24px",
              boxShadow: "0 24px 70px rgba(0,0,0,0.25)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "20px",
                marginBottom: "8px",
              }}
            >
              <h2
                id="add-spot-title"
                style={{ margin: 0 }}
              >
                Add a Spot
              </h2>

              <button
                type="button"
                onClick={closeAddModal}
                disabled={saving}
                aria-label="Close Add Spot"
                style={{
                  border: 0,
                  background: "transparent",
                  fontSize: "1.5rem",
                  cursor: "pointer",
                }}
              >
                ×
              </button>
            </div>

            <p
              style={{
                marginTop: 0,
                marginBottom: "20px",
                opacity: 0.7,
              }}
            >
              Search Google and select the exact establishment.
            </p>

            <GooglePlacePicker
              onSelect={(place) => {
                setSelectedPlace(place);
                setAddMessage("");
              }}
            />

            {selectedPlace && (
              <div
                style={{
                  marginTop: "22px",
                  paddingTop: "18px",
                  borderTop: "1px solid #e3ded4",
                }}
              >
                <div
                  style={{
                    fontWeight: 800,
                    fontSize: "1.05rem",
                    marginBottom: "5px",
                  }}
                >
                  {selectedPlace.name}
                </div>

                <div
                  style={{
                    opacity: 0.7,
                    marginBottom: "18px",
                  }}
                >
                  {selectedPlace.address}
                </div>

                <button
                  type="button"
                  className="btn primary"
                  disabled={saving}
                  onClick={addSpot}
                >
                  {saving
                    ? "Adding..."
                    : "Add to TenderFans"}
                </button>
              </div>
            )}

            {addMessage && (
              <p
                style={{
                  marginBottom: 0,
                  marginTop: "18px",
                  fontWeight: 700,
                }}
              >
                {addMessage}
              </p>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
