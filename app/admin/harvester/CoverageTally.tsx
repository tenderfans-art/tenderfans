"use client";

import Link from "next/link";
import { useState } from "react";
import { supabase } from "@/lib/supabase";

type Tally = {
  total_spots: number;
  validated_spots: number;
  non_validated_spots: number;
  missing_from_buckets: number;
  active_errors: number;
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
        throw new Error("Administrator sign-in required.");
      }

      const response = await fetch("/api/admin/harvester-coverage", {
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

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: "10px",
        flexWrap: "wrap",
        fontSize: "0.82rem",
      }}
    >
      {tally && (
        <>
          <span>
            Validated: <strong>{tally.validated_spots}</strong>
          </span>
          <span>
            Non-Validated: <strong>{tally.non_validated_spots}</strong>
          </span>
          <span>
            Total: <strong>{tally.total_spots}</strong>
          </span>
          <span>
            Missing:{" "}
            <Link
              href="/admin/harvester/unaccounted"
              style={{
                fontWeight: 800,
                textDecoration: "underline",
              }}
              title="View non-validated Spots missing from exception buckets"
            >
              {tally.missing_from_buckets}
            </Link>
          </span>
          <span>
            Errors:{" "}
            <Link
              href="/admin/harvester/adapter-errors"
              style={{
                fontWeight: 800,
                textDecoration: "underline",
              }}
              title="Review Spots with active adapter errors"
            >
              {tally.active_errors}
            </Link>
          </span>
        </>
      )}

      <button
        type="button"
        onClick={runTally}
        disabled={loading}
        style={{
          padding: "7px 12px",
          borderRadius: "8px",
          cursor: loading ? "wait" : "pointer",
          fontSize: "0.82rem",
        }}
      >
        {loading ? "Running..." : "Tally"}
      </button>

      {tally &&
        tally.validated_spots + tally.non_validated_spots !==
          tally.total_spots && (
          <span role="alert" style={{ color: "#a33" }}>
            Counts do not reconcile
          </span>
        )}

      {error && (
        <span role="alert" style={{ color: "#a33" }}>
          {error}
        </span>
      )}
    </div>
  );
}
