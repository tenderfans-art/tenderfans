"use client";

import { supabase } from "@/lib/supabase";
import { useState } from "react";

type Tally = {
  total_spots: number;
  validated_spots: number;
  non_validated_spots: number;
  missing_from_buckets: number;
};

export default function CoverageTally() {
  const [tally, setTally] = useState<Tally | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runTally() {
    setLoading(true);
    setError(null);

    try {
      const { data: { session }, error: sessionError } =
        await supabase.auth.getSession();

      if (sessionError || !session?.access_token) {
        throw new Error("Please sign in as an administrator.");
      }

      const response = await fetch("/api/admin/harvester-coverage", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
        cache: "no-store",
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error ?? "Tally request failed.");
      }

      setTally(result as Tally);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not run tally.",
      );
    } finally {
      setLoading(false);
    }
  }

  const balanced = tally !== null &&
    tally.validated_spots + tally.non_validated_spots ===
      tally.total_spots;

  const items = tally ? [
    ["Validated", tally.validated_spots],
    ["Non-Validated", tally.non_validated_spots],
    ["Total Spots", tally.total_spots],
    ["Missing from Buckets", tally.missing_from_buckets],
  ] as const : [];

  return (
    <section
      style={{
        border: "1px solid rgba(20,35,45,0.12)",
        borderRadius: "18px",
        padding: "22px",
        marginBottom: "28px",
        background: "rgba(255,255,255,0.9)",
      }}
    >
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "14px",
      }}>
        <h2 style={{ margin: 0, fontSize: "1.25rem" }}>
          Harvester Coverage
        </h2>
        <button
          type="button"
          onClick={runTally}
          disabled={loading}
          style={{
            padding: "11px 18px",
            borderRadius: "10px",
            cursor: loading ? "wait" : "pointer",
          }}
        >
          {loading ? "Running..." : "Run Tally"}
        </button>
      </div>

      {error && (
        <p role="alert" style={{ color: "#a33" }}>{error}</p>
      )}

      {tally && (
        <>
          <div style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(auto-fit, minmax(150px, 1fr))",
            gap: "12px",
            marginTop: "20px",
          }}>
            {items.map(([label, value]) => (
              <div key={label} style={{
                padding: "16px",
                borderRadius: "12px",
                background: "#f5f3ec",
              }}>
                <div style={{ fontSize: "0.8rem", opacity: 0.7 }}>
                  {label}
                </div>
                <strong style={{ fontSize: "1.8rem" }}>
                  {value.toLocaleString()}
                </strong>
              </div>
            ))}
          </div>

          <p style={{ marginBottom: 0 }}>
            {balanced
              ? "Validated + Non-Validated = Total Spots ✓"
              : "WARNING: Coverage counts do not reconcile."}
            {" "}
            {tally.missing_from_buckets > 0
              ? `${tally.missing_from_buckets} non-validated Spot(s) have no active exception bucket.`
              : "All non-validated Spots have an active exception bucket."}
          </p>
        </>
      )}
    </section>
  );
}
