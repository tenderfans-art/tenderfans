"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import GooglePlacePicker from "@/components/GooglePlacePicker";
import { supabase } from "@/lib/supabase";

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

export default function AdminSpotsPage() {
  const [loading, setLoading] = useState(true);
  const [selectedPlace, setSelectedPlace] =
    useState<GooglePlace | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [addedSpots, setAddedSpots] = useState<
    { id: string; name: string }[]
  >([]);

  useEffect(() => {
    async function verifyAdmin() {
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

      setLoading(false);
    }

    verifyAdmin();
  }, []);

  async function addSpot() {
    if (!selectedPlace || saving) return;

    setSaving(true);
    setMessage("");

    try {
      const response = await fetch("/api/google/place", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          placeId: selectedPlace.id,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Could not add Spot.");
      }

      setAddedSpots((current) => [
        {
          id: result.venueId,
          name: result.place?.name ?? selectedPlace.name,
        },
        ...current,
      ]);

      setMessage(
        `${result.place?.name ?? selectedPlace.name} is in TenderFans.`
      );
      setSelectedPlace(null);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not add Spot."
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="flow-page">
        <div className="shell">
          <section
            className="flow-card"
            style={{ maxWidth: "900px", margin: "0 auto" }}
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
            maxWidth: "900px",
            margin: "0 auto",
          }}
        >
          <div className="eyebrow">TENDERFANS ADMIN</div>

          <h1 style={{ marginBottom: "8px" }}>
            Manage Spots
          </h1>

          <p
            className="lead-copy"
            style={{
              marginTop: 0,
              marginBottom: "32px",
            }}
          >
            Add verified Google Places to TenderFans.
          </p>

          <div
            style={{
              padding: "22px",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: "16px",
            }}
          >
            <h2
              style={{
                marginTop: 0,
                marginBottom: "8px",
              }}
            >
              Add a Spot
            </h2>

            <p
              style={{
                marginTop: 0,
                marginBottom: "18px",
                opacity: 0.75,
              }}
            >
              Search Google and select the exact establishment.
            </p>

            <GooglePlacePicker
              onSelect={(place) => {
                setSelectedPlace(place);
                setMessage("");
              }}
            />

            {selectedPlace && (
              <div
                style={{
                  marginTop: "22px",
                  paddingTop: "20px",
                  borderTop:
                    "1px solid rgba(255,255,255,0.12)",
                }}
              >
                <div
                  style={{
                    fontWeight: 800,
                    fontSize: "1.1rem",
                    marginBottom: "6px",
                  }}
                >
                  {selectedPlace.name}
                </div>

                <div
                  style={{
                    opacity: 0.75,
                    lineHeight: 1.5,
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

            {message && (
              <p
                style={{
                  marginBottom: 0,
                  marginTop: "18px",
                  fontWeight: 700,
                }}
              >
                {message}
              </p>
            )}
          </div>

          {addedSpots.length > 0 && (
            <div style={{ marginTop: "28px" }}>
              <div className="eyebrow">
                ADDED THIS SESSION
              </div>

              <div
                style={{
                  display: "grid",
                  gap: "10px",
                  marginTop: "12px",
                }}
              >
                {addedSpots.map((spot) => (
                  <div
                    key={`${spot.id}-${spot.name}`}
                    style={{
                      padding: "14px 16px",
                      border:
                        "1px solid rgba(255,255,255,0.12)",
                      borderRadius: "12px",
                    }}
                  >
                    ✓ {spot.name}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ marginTop: "30px" }}>
            <Link href="/admin" className="text-link">
              ← Back to Admin Dashboard
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
