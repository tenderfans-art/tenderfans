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
      <main style={{ padding: "40px 24px" }}>
        <p>Loading Tenders...</p>
      </main>
    );
  }

  return (
    <main
      style={{
        maxWidth: "1100px",
        margin: "0 auto",
        padding: "42px 24px 70px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "20px",
          marginBottom: "26px",
        }}
      >
        <div>
          <div
            style={{
              fontSize: "0.76rem",
              fontWeight: 800,
              letterSpacing: "0.12em",
              opacity: 0.55,
              marginBottom: "5px",
            }}
          >
            TENDERFANS ADMIN
          </div>

          <h1 style={{ margin: 0 }}>Manage Tenders</h1>
        </div>

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

      <input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search by Tender name or Spot..."
        style={{
          width: "100%",
          padding: "13px 15px",
          borderRadius: "10px",
          border: "1px solid rgba(0,0,0,0.15)",
          background: "transparent",
          color: "inherit",
          font: "inherit",
          marginBottom: "24px",
        }}
      />

      {message && (
        <p style={{ margin: "0 0 18px", opacity: 0.8 }}>
          {message}
        </p>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "minmax(230px, 1.5fr) minmax(210px, 1.3fr) 120px 100px 110px",
          gap: "18px",
          padding: "0 10px 10px",
          fontSize: "0.72rem",
          fontWeight: 800,
          letterSpacing: "0.08em",
          opacity: 0.55,
        }}
      >
        <div>TENDER</div>
        <div>CURRENT SPOT</div>
        <div>TYPE</div>
        <div>STATUS</div>
        <div />
      </div>

      <div style={{ borderTop: "1px solid rgba(0,0,0,0.12)" }}>
        {visibleTenders.map((tender) => (
          <div
            key={tender.id}
            style={{
              display: "grid",
              gridTemplateColumns:
                "minmax(230px, 1.5fr) minmax(210px, 1.3fr) 120px 100px 110px",
              gap: "18px",
              alignItems: "center",
              padding: "15px 10px",
              borderBottom: "1px solid rgba(0,0,0,0.12)",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <Link
                href={`/t/${tender.slug}`}
                style={{
                  display: "block",
                  color: "inherit",
                  fontWeight: 800,
                  textDecoration: "none",
                  lineHeight: 1.25,
                }}
              >
                {tender.display_name}
              </Link>

              <div
                style={{
                  marginTop: "3px",
                  opacity: 0.55,
                  fontSize: "0.78rem",
                }}
              >
                {tender.is_claimed ? "Claimed" : "Unclaimed"}
              </div>
            </div>

            <div style={{ minWidth: 0 }}>
              {tender.current_venue_name || "No current Spot"}
            </div>

            <div
              style={{
                fontSize: "0.82rem",
                textTransform: "capitalize",
              }}
            >
              {tender.tender_type}
            </div>

            <div
              style={{
                fontSize: "0.82rem",
                fontWeight: 800,
                textTransform: "capitalize",
              }}
            >
              {tender.status}
            </div>

            {tender.status === "removed" ? (
              <div
                style={{
                  justifySelf: "end",
                  fontSize: "0.82rem",
                  opacity: 0.55,
                }}
              >
                Removed
              </div>
            ) : (
              <button
                type="button"
                onClick={() => removeTender(tender)}
                style={{
                  justifySelf: "end",
                  padding: "8px 15px",
                  borderRadius: "8px",
                  border: "1px solid rgba(0,0,0,0.18)",
                  background: "transparent",
                  color: "inherit",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                Remove
              </button>
            )}
          </div>
        ))}

        {visibleTenders.length === 0 && (
          <div style={{ padding: "28px 10px", opacity: 0.65 }}>
            No Tenders found.
          </div>
        )}
      </div>

      <div style={{ marginTop: "30px" }}>
        <Link href="/admin">← Back to Admin Dashboard</Link>
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
