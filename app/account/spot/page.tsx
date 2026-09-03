"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type OwnedSpot = {
  id: string;
  name: string;
  slug: string;
  city: string | null;
  state_region: string | null;
  description: string | null;
};

export default function SpotAccountPage() {
  const [spots, setSpots] = useState<OwnedSpot[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  useEffect(() => {
    async function loadOwnedSpots() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        window.location.href = "/login";
        return;
      }

      const { data: permissions, error: permissionError } = await supabase
        .from("venue_permissions")
        .select("venue_id")
        .eq("user_id", user.id);

      if (permissionError) {
        setMessage(permissionError.message);
        setLoading(false);
        return;
      }

      const venueIds = (permissions ?? []).map((row) => row.venue_id);

      if (venueIds.length === 0) {
        setSpots([]);
        setLoading(false);
        return;
      }

      const { data: venues, error: venueError } = await supabase
        .from("venues")
        .select("id, name, slug, city, state_region, description")
        .in("id", venueIds)
        .order("name");

      if (venueError) {
        setMessage(venueError.message);
        setLoading(false);
        return;
      }

      setSpots((venues ?? []) as OwnedSpot[]);
      setLoading(false);
    }

    loadOwnedSpots();
  }, []);

  return (
    <main className="flow-page">
      <div className="shell">
        <div className="flow-card">
          <div className="eyebrow">Spot Owner Account</div>
          <h1>Manage your Spots.</h1>

          <p className="lead-copy">
            Keep your establishments current and manage your TenderFans presence.
          </p>

          {loading && <p>Loading your Spots...</p>}

          {message && (
            <p style={{ color: "crimson" }}>
              {message}
            </p>
          )}

          {!loading && !message && spots.length === 0 && (
            <div
              style={{
                marginTop: "22px",
                padding: "18px",
                border: "1px solid #ddd",
                borderRadius: "14px",
              }}
            >
              <strong>No owned Spots yet.</strong>
              <p style={{ marginBottom: 0 }}>
                Once a Spot claim is approved, the establishment will appear here.
              </p>
            </div>
          )}

          {!loading && spots.length > 0 && (
            <div style={{ marginTop: "26px" }}>
              {spots.map((spot) => (
                <section key={spot.id} style={{ marginBottom: "34px" }}>
                  <div style={{ marginBottom: "16px" }}>
                    <h2 style={{ margin: "0 0 4px" }}>
                      {spot.name}
                    </h2>

                    {(spot.city || spot.state_region) && (
                      <div style={{ color: "#697177" }}>
                        {[spot.city, spot.state_region]
                          .filter(Boolean)
                          .join(", ")}
                      </div>
                    )}
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(5, minmax(120px, 1fr))",
                      gap: "10px",
                    }}
                  >
                    <Link
                      href={`/account/spot/${spot.id}/menu`}
                      style={{
                        display: "block",
                        padding: "13px 12px",
                        border: "1px solid #d7d1c6",
                        borderRadius: "14px",
                        textDecoration: "none",
                        color: "inherit",
                        textAlign: "center",
                      }}
                    >
                      <strong>Menus</strong>
                      <div style={{ marginTop: "4px", fontSize: "0.78rem", color: "#697177" }}>
                        Menu images & PDFs
                      </div>
                    </Link>

                    <Link
                      href={`/account/spot/${spot.id}/specials`}
                      style={{
                        display: "block",
                        padding: "13px 12px",
                        border: "1px solid #d7d1c6",
                        borderRadius: "14px",
                        textDecoration: "none",
                        color: "inherit",
                        textAlign: "center",
                      }}
                    >
                      <strong>Specials</strong>
                      <div style={{ marginTop: "4px", fontSize: "0.78rem", color: "#697177" }}>
                        Specials images & PDFs
                      </div>
                    </Link>

                    <Link
                      href={`/account/spot/${spot.id}/photos`}
                      style={{
                        display: "block",
                        padding: "13px 12px",
                        border: "1px solid #d7d1c6",
                        borderRadius: "14px",
                        textDecoration: "none",
                        color: "inherit",
                        textAlign: "center",
                      }}
                    >
                      <strong>Photos</strong>
                      <div style={{ marginTop: "4px", fontSize: "0.78rem", color: "#697177" }}>
                        Spot photo gallery
                      </div>
                    </Link>

                    <Link
                      href={`/account/spot/${spot.id}/events`}
                      style={{
                        display: "block",
                        padding: "13px 12px",
                        border: "1px solid #d7d1c6",
                        borderRadius: "14px",
                        textDecoration: "none",
                        color: "inherit",
                        textAlign: "center",
                      }}
                    >
                      <strong>Events</strong>
                      <div style={{ marginTop: "4px", fontSize: "0.78rem", color: "#697177" }}>
                        Approved calendar events
                      </div>
                    </Link>

                    <Link
                      href={`/s/${spot.slug}`}
                      style={{
                        display: "block",
                        padding: "13px 12px",
                        border: "1px solid #d7d1c6",
                        borderRadius: "14px",
                        textDecoration: "none",
                        color: "inherit",
                        textAlign: "center",
                      }}
                    >
                      <strong>View Profile</strong>
                      <div style={{ marginTop: "4px", fontSize: "0.78rem", color: "#697177" }}>
                        View public Spot page
                      </div>
                    </Link>
                  </div>
                </section>
              ))}
          </div>
          )}

          <div
            style={{
              marginTop: "10px",
              paddingTop: "20px",
              borderTop: "1px solid #ddd",
            }}
          >
            <Link
              href="/claim?type=venue"
              style={{
                display: "inline-block",
                padding: "14px 18px",
                border: "1px solid #d7d1c6",
                borderRadius: "12px",
                textDecoration: "none",
                color: "inherit",
              }}
            >
              + Add another establishment
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
