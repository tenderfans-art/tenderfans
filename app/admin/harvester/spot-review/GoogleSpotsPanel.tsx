"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Review = {
  place_id: string;
  place_data: {
    name?: string;
    formattedAddress?: string;
    websiteUrl?: string;
  };
  confidence_score: number | null;
  evidence: Record<string, unknown>;
};

type Spot = {
  id: string;
  name: string;
  city: string;
  status: string;
};

export default function GoogleSpotsPanel() {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const [reviewResult, spotResult] = await Promise.all([
      supabase.rpc("admin_list_google_spot_reviews"),
      supabase.rpc("admin_list_spots"),
    ]);

    if (reviewResult.error || spotResult.error) {
      setMessage(
        reviewResult.error?.message ||
        spotResult.error?.message ||
        "Could not load reviews",
      );
    } else {
      setReviews((reviewResult.data as Review[]) || []);
      setSpots(
        ((spotResult.data as Spot[]) || []).filter(
          (spot) => spot.status === "active",
        ),
      );
    }
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  async function review(placeId: string, approve: boolean) {
    setBusy(placeId);
    setMessage("");

    const { error } = await supabase.rpc(
      "admin_review_google_spot",
      {
        p_place_id: placeId,
        p_approve: approve,
        p_venue_id: approve ? selected[placeId] || null : null,
      },
    );

    if (error) {
      setMessage(error.message);
    } else {
      setMessage(approve ? "Google Spot approved." : "Google Spot rejected.");
      await load();
    }

    setBusy(null);
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <p>
        Review Google Places identities before approving new Spots
        or matching existing Spots.
      </p>

      {message && <p role="status">{message}</p>}
      {loading && <p>Loading Google Spots...</p>}
      {!loading && reviews.length === 0 && (
        <p>No Google Spots need review.</p>
      )}

      {reviews.map((item) => (
        <article
          key={item.place_id}
          style={{
            padding: 16,
            border: "1px solid rgba(20,35,45,.15)",
            borderRadius: 12,
          }}
        >
          <strong>{item.place_data.name || item.place_id}</strong>
          <p>{item.place_data.formattedAddress || "Address unavailable"}</p>
          <p>
            Confidence: {item.confidence_score == null
              ? "Unknown"
              : `${Math.round(item.confidence_score * 100)}%`}
          </p>

          <select
            value={selected[item.place_id] || ""}
            onChange={(event) =>
              setSelected((previous) => ({
                ...previous,
                [item.place_id]: event.target.value,
              }))
            }
          >
            <option value="">Create new Spot</option>
            {spots.map((spot) => (
              <option key={spot.id} value={spot.id}>
                {spot.name} — {spot.city}
              </option>
            ))}
          </select>

          <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => review(item.place_id, true)}
            >
              {busy === item.place_id ? "Working..." : "Approve"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => review(item.place_id, false)}
            >
              Reject
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
