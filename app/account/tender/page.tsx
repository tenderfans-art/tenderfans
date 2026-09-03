"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type TenderProfile = {
  id: string;
  slug: string;
  display_name: string;
  bio: string | null;
};

type TenderSpot = {
  name: string;
  slug: string;
};

export default function TenderAccountPage() {
  const [tender, setTender] = useState<TenderProfile | null>(null);
  const [spots, setSpots] = useState<(TenderSpot & { is_primary: boolean })[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  useEffect(() => {
    async function loadTender() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        window.location.href = "/login";
        return;
      }

      const { data: permissions, error: permissionError } = await supabase
        .from("bartender_permissions")
        .select("bartender_id")
        .eq("user_id", user.id);

      if (permissionError) {
        setMessage(permissionError.message);
        setLoading(false);
        return;
      }

      const bartenderId = permissions?.[0]?.bartender_id;

      if (!bartenderId) {
        setLoading(false);
        return;
      }

      const { data: bartender, error: bartenderError } = await supabase
        .from("bartenders")
        .select("id, slug, display_name, bio")
        .eq("id", bartenderId)
        .single();

      if (bartenderError) {
        setMessage(bartenderError.message);
        setLoading(false);
        return;
      }

      setTender(bartender as TenderProfile);

      const { data: relationships, error: relationshipError } =
        await supabase
          .from("bartender_venues")
          .select("venue_id, is_primary")
          .eq("bartender_id", bartenderId)
          .eq("is_current", true)
          .order("is_primary", { ascending: false });

      if (relationshipError) {
        setMessage(relationshipError.message);
        setLoading(false);
        return;
      }

      if (relationships && relationships.length > 0) {
        const venueIds = relationships.map(
          (relationship) => relationship.venue_id
        );

        const { data: venueRows, error: venueError } =
          await supabase
            .from("venues")
            .select("id, name, slug")
            .in("id", venueIds);

        if (venueError) {
          setMessage(venueError.message);
          setLoading(false);
          return;
        }

        const venueMap = new Map(
          (venueRows ?? []).map((venue) => [venue.id, venue])
        );

        setSpots(
          relationships
            .map((relationship) => {
              const venue = venueMap.get(relationship.venue_id);

              if (!venue) return null;

              return {
                ...venue,
                is_primary: relationship.is_primary,
              };
            })
            .filter(Boolean) as (TenderSpot & {
              is_primary: boolean;
            })[]
        );
      }

      setLoading(false);
    }

    loadTender();
  }, []);

  const cardStyle = {
    display: "block",
    padding: "13px 12px",
    border: "1px solid #d7d1c6",
    borderRadius: "14px",
    textDecoration: "none",
    color: "inherit",
    textAlign: "center" as const,
  };

  const descriptionStyle = {
    marginTop: "4px",
    fontSize: "0.78rem",
    color: "#697177",
  };

  return (
    <main className="flow-page">
      <div className="shell">
        <div className="flow-card">
          <div className="eyebrow">Tender Account</div>
          <h1>Manage your Tender profile.</h1>

          <p className="lead-copy">
            Keep your profile current and manage your TenderFans presence.
          </p>

          {loading && <p>Loading your Tender profile...</p>}

          {message && (
            <p style={{ color: "crimson" }}>
              {message}
            </p>
          )}

          {!loading && !message && !tender && (
            <div
              style={{
                marginTop: "22px",
                padding: "18px",
                border: "1px solid #ddd",
                borderRadius: "14px",
              }}
            >
              <strong>No approved Tender profile yet.</strong>
              <p style={{ marginBottom: 0 }}>
                Once your Tender claim is approved, your profile will appear here.
              </p>
            </div>
          )}

          {!loading && !message && tender && (
            <section style={{ marginTop: "26px" }}>
              <div style={{ marginBottom: "16px" }}>
                <h2 style={{ margin: "0 0 4px" }}>
                  {tender.display_name}
                </h2>

                {spots.length > 0 && (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      gap: "6px 10px",
                      color: "#697177",
                    }}
                  >
                    <span>
                      Current Tender at
                    </span>

                    {spots.map((spot, index) => (
                      <span
                        key={spot.slug}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "5px",
                        }}
                      >
                        <strong
                          style={{
                            color: "#172735",
                            fontWeight: 700,
                          }}
                        >
                          {spot.name}
                        </strong>

                        {spot.is_primary && (
                          <span
                            style={{
                              fontSize: "0.68rem",
                              fontWeight: 800,
                              padding: "3px 7px",
                              borderRadius: "999px",
                              background: "#172735",
                              color: "#fff",
                            }}
                          >
                            Primary
                          </span>
                        )}

                        {index < spots.length - 1 && (
                          <span style={{ color: "#a19d94" }}>
                            ·
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(4, minmax(120px, 1fr))",
                  gap: "10px",
                }}
              >
                <Link
                  href={`/account/tender/${tender.id}/profile`}
                  style={cardStyle}
                >
                  <strong>Edit Profile</strong>
                  <div style={descriptionStyle}>
                    Name & bio
                  </div>
                </Link>

                <Link
                  href={`/account/tender/${tender.id}/photo`}
                  style={cardStyle}
                >
                  <strong>Photo</strong>
                  <div style={descriptionStyle}>
                    Profile photo
                  </div>
                </Link>

                <Link
                  href={`/account/tender/${tender.id}/spot`}
                  style={cardStyle}
                >
                  <strong>Manage Spots</strong>
                  <div style={descriptionStyle}>
                    Verified workplaces
                  </div>
                </Link>

                <Link
                  href={`/t/${tender.slug}`}
                  style={cardStyle}
                >
                  <strong>View Profile</strong>
                  <div style={descriptionStyle}>
                    View public Tender page
                  </div>
                </Link>
              </div>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
