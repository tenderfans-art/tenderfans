"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type Tender = {
  id: string;
  display_name: string;
  slug: string;
  tender_type: string;
  status: string;
  current_venue_id: string | null;
  current_venue_name: string | null;
  is_claimed: boolean;
};

type Spot = {
  id: string;
  name: string;
  city: string;
  state_region: string;
};

export default function AdminTendersPage() {
  const [loading, setLoading] = useState(true);
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");

  const [addOpen, setAddOpen] = useState(false);
  const [tenderName, setTenderName] = useState("");
  const [spots, setSpots] = useState<Spot[]>([]);
  const [spotSearch, setSpotSearch] = useState("");
  const [selectedSpot, setSelectedSpot] = useState<Spot | null>(null);
  const [saving, setSaving] = useState(false);
  const [addMessage, setAddMessage] = useState("");

  useEffect(() => {
    async function initialize() {
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

      await Promise.all([loadTenders(), loadSpots()]);
      setLoading(false);
    }

    initialize();
  }, []);

  async function loadTenders() {
    const { data, error } = await supabase.rpc("admin_list_tenders");

    if (error) {
      setMessage(error.message);
      return;
    }

    setTenders((data as Tender[]) || []);
  }

  async function loadSpots() {
    const { data, error } = await supabase
      .from("venues")
      .select("id, name, city, state_region")
      .eq("status", "active")
      .order("name");

    if (error) {
      setAddMessage(error.message);
      return;
    }

    setSpots((data as Spot[]) || []);
  }

  const visibleTenders = useMemo(() => {
    const term = search.trim().toLowerCase();

    const filtered = term
      ? tenders.filter((tender) => {
          const name = tender.display_name.toLowerCase();
          const spot = (tender.current_venue_name || "").toLowerCase();

          return name.includes(term) || spot.includes(term);
        })
      : tenders;

    return filtered.slice(0, 5);
  }, [tenders, search]);

  const visibleSpots = useMemo(() => {
    const term = spotSearch.trim().toLowerCase();

    if (!term) return [];

    return spots
      .filter((spot) => {
        const haystack =
          `${spot.name} ${spot.city} ${spot.state_region}`.toLowerCase();

        return haystack.includes(term);
      })
      .slice(0, 5);
  }, [spots, spotSearch]);

  async function removeTender(tender: Tender) {
    if (tender.status === "removed") return;

    const confirmed = window.confirm(
      `Remove ${tender.display_name} from TenderFans?\n\nThis is intended for policy enforcement or other exceptional circumstances. The Tender will no longer be publicly available, but their TenderFans history will be retained.`
    );

    if (!confirmed) return;

    setMessage("");

    const { error } = await supabase.rpc("admin_remove_tender", {
      p_bartender_id: tender.id,
    });

    if (error) {
      setMessage(error.message);
      return;
    }

    setTenders((current) =>
      current.map((item) =>
        item.id === tender.id
          ? { ...item, status: "removed" }
          : item
      )
    );
  }

  async function addTender() {
    const name = tenderName.trim();

    if (!name) {
      setAddMessage("Enter the Tender's name.");
      return;
    }

    if (!selectedSpot) {
      setAddMessage("Select the Tender's current Spot.");
      return;
    }

    setSaving(true);
    setAddMessage("");

    const { error } = await supabase.rpc(
      "create_bartender_at_venue",
      {
        p_display_name: name,
        p_venue_id: selectedSpot.id,
      }
    );

    if (error) {
      setAddMessage(error.message);
      setSaving(false);
      return;
    }

    await loadTenders();

    setTenderName("");
    setSpotSearch("");
    setSelectedSpot(null);
    setSaving(false);
    setAddOpen(false);
  }

  function closeAddModal() {
    if (saving) return;

    setAddOpen(false);
    setTenderName("");
    setSpotSearch("");
    setSelectedSpot(null);
    setAddMessage("");
  }

  if (loading) {
    return (
      <main className="flow-page">
        <div className="shell">
          <section className="flow-card">
            <p>Loading Tenders...</p>
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
          style={{ maxWidth: "1200px", margin: "0 auto" }}
        >
          <Link
            href="/admin"
            style={{
              display: "inline-block",
              marginBottom: "22px",
              color: "inherit",
            }}
          >
            ← Admin Dashboard
          </Link>

          <div className="eyebrow">TENDERFANS ADMIN</div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "14px",
              marginBottom: "8px",
            }}
          >
            <h1 style={{ margin: 0 }}>Manage Tenders</h1>

            <button
              type="button"
              onClick={() => setAddOpen(true)}
              style={{
                border: 0,
                borderRadius: "999px",
                padding: "12px 20px",
                font: "inherit",
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              + Add Tender
            </button>
          </div>

          <p
            className="lead-copy"
            style={{ marginTop: 0, marginBottom: "24px" }}
          >
            Search and manage Tender profiles across TenderFans.
          </p>

          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by Tender name or Spot..."
            aria-label="Search Tenders"
            style={{
              width: "100%",
              padding: "10px 12px",
              marginBottom: "20px",
              font: "inherit",
              borderRadius: "10px",
              border: "1px solid rgba(20,35,45,0.18)",
            }}
          />

          {message && (
            <div
              style={{
                marginBottom: "20px",
                padding: "14px 16px",
                border: "1px solid rgba(20,35,45,0.12)",
                borderRadius: "12px",
              }}
            >
              {message}
            </div>
          )}

          <div className="admin-tender-list">
            <div className="admin-tender-head">
              <span>Tender</span>
              <span>Current Spot</span>
              <span>Type</span>
              <span>Status</span>
              <span style={{ textAlign: "center" }}>Action</span>
            </div>

            {visibleTenders.map((tender) => (
              <div className="admin-tender-row" key={tender.id}>
                <div className="admin-tender-name">
                  <Link
                    href={`/t/${tender.slug}`}
                    title={tender.display_name}
                  >
                    {tender.display_name}
                  </Link>
                  <div className="admin-tender-claim">
                    {tender.is_claimed ? "Claimed" : "Unclaimed"}
                  </div>
                </div>

                <div
                  className="admin-tender-spot"
                  title={tender.current_venue_name || "No current Spot"}
                >
                  {tender.current_venue_name || "No current Spot"}
                </div>

                <div className="admin-tender-type">
                  {tender.tender_type}
                </div>

                <div className="admin-tender-status">
                  {tender.status}
                </div>

                {tender.status === "removed" ? (
                  <div className="admin-tender-removed">
                    Removed
                  </div>
                ) : (
                  <button
                    type="button"
                    className="admin-tender-remove"
                    onClick={() => removeTender(tender)}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}

            {visibleTenders.length === 0 && (
              <div className="admin-tender-empty">
                No Tenders found.
              </div>
            )}
          </div>
        </section>
      </div>
      {addOpen && (
        <div
          onClick={closeAddModal}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: "rgba(0,0,0,0.58)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px",
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: "620px",
              background: "white",
              color: "#12202b",
              borderRadius: "18px",
              padding: "28px",
              boxShadow: "0 24px 70px rgba(0,0,0,0.25)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "20px",
                marginBottom: "24px",
              }}
            >
              <h2 style={{ margin: 0 }}>Add Tender</h2>

              <button
                type="button"
                onClick={closeAddModal}
                disabled={saving}
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

            <label
              style={{
                display: "block",
                fontWeight: 800,
                marginBottom: "7px",
              }}
            >
              Tender Name
            </label>

            <input
              value={tenderName}
              onChange={(event) => setTenderName(event.target.value)}
              placeholder="Tender name"
              style={{
                width: "100%",
                padding: "12px 14px",
                borderRadius: "9px",
                border: "1px solid #d5d5d5",
                font: "inherit",
                marginBottom: "20px",
              }}
            />

            <label
              style={{
                display: "block",
                fontWeight: 800,
                marginBottom: "7px",
              }}
            >
              Current Spot
            </label>

            {selectedSpot ? (
              <div
                style={{
                  border: "1px solid #d5d5d5",
                  borderRadius: "9px",
                  padding: "12px 14px",
                  marginBottom: "20px",
                }}
              >
                <strong>{selectedSpot.name}</strong>
                <div
                  style={{
                    fontSize: "0.82rem",
                    opacity: 0.65,
                    marginTop: "3px",
                  }}
                >
                  {selectedSpot.city}, {selectedSpot.state_region}
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setSelectedSpot(null);
                    setSpotSearch("");
                  }}
                  style={{
                    marginTop: "8px",
                    border: 0,
                    background: "transparent",
                    padding: 0,
                    cursor: "pointer",
                    textDecoration: "underline",
                  }}
                >
                  Change Spot
                </button>
              </div>
            ) : (
              <>
                <input
                  value={spotSearch}
                  onChange={(event) =>
                    setSpotSearch(event.target.value)
                  }
                  placeholder="Search Spots..."
                  style={{
                    width: "100%",
                    padding: "12px 14px",
                    borderRadius: "9px",
                    border: "1px solid #d5d5d5",
                    font: "inherit",
                  }}
                />

                {visibleSpots.length > 0 && (
                  <div
                    style={{
                      border: "1px solid #e0e0e0",
                      borderRadius: "9px",
                      overflow: "hidden",
                      marginTop: "7px",
                      marginBottom: "20px",
                    }}
                  >
                    {visibleSpots.map((spot) => (
                      <button
                        key={spot.id}
                        type="button"
                        onClick={() => {
                          setSelectedSpot(spot);
                          setSpotSearch(spot.name);
                        }}
                        style={{
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          padding: "10px 12px",
                          border: 0,
                          borderBottom: "1px solid #eee",
                          background: "white",
                          cursor: "pointer",
                        }}
                      >
                        <strong>{spot.name}</strong>
                        <span
                          style={{
                            marginLeft: "7px",
                            opacity: 0.6,
                            fontSize: "0.8rem",
                          }}
                        >
                          {spot.city}, {spot.state_region}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {addMessage && (
              <p style={{ margin: "0 0 18px" }}>{addMessage}</p>
            )}

            <button
              type="button"
              onClick={addTender}
              disabled={saving}
              style={{
                border: 0,
                borderRadius: "9px",
                padding: "11px 17px",
                font: "inherit",
                fontWeight: 800,
                cursor: saving ? "default" : "pointer",
              }}
            >
              {saving ? "Adding..." : "Add to TenderFans"}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
