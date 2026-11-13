"use client";

import { useEffect, useId, useState } from "react";
import { supabase } from "@/lib/supabase";

type Cycle = {
  status: string;
  elapsed_seconds: number | string | null;
  expected_spots: number;
  completed_spots: number;
  failed_spots: number;
  expected_shared_sources: number;
  completed_shared_sources: number;
  failed_shared_sources: number;
  pending_jobs: number;
  retry_jobs: number;
  leased_jobs: number;
};

export function formatMarketCycleDuration(
  elapsed: number | string | null,
): string {
  if (elapsed === null) return "—";

  const seconds = Number(elapsed);

  if (!Number.isFinite(seconds) || seconds < 0) {
    return "—";
  }

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

const count = (value: number | null | undefined) =>
  Number.isFinite(Number(value)) ? Number(value) : 0;

export default function MarketScanStatus({
  marketKey,
}: {
  marketKey: string;
}) {
  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const tooltipId = useId();

  useEffect(() => {
    let active = true;

    async function refresh() {
      try {
        const { data: { session } } =
          await supabase.auth.getSession();

        if (!session?.access_token) {
          throw new Error("Session expired.");
        }

        const response = await fetch(
          `/api/admin/markets/scan-summary?market=${encodeURIComponent(marketKey)}`,
          {
            headers: {
              Authorization: `Bearer ${session.access_token}`,
            },
            cache: "no-store",
          },
        );

        if (!response.ok) {
          throw new Error("Scan summary unavailable.");
        }

        const result = await response.json() as {
          cycle: Cycle | null;
        };

        if (active) {
          setCycle(result.cycle);
          setError(false);
          setLoading(false);
        }
      } catch {
        if (active) {
          setError(true);
          setLoading(false);
        }
      }
    }

    setCycle(null);
    setLoading(true);
    setError(false);
    setOpen(false);

    void refresh();
    const interval = setInterval(() => void refresh(), 30000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [marketKey]);

  if (loading) {
    return (
      <span style={{ fontSize: "0.85rem", opacity: 0.65 }}>
        Checking scan…
      </span>
    );
  }

  if (error) {
    return (
      <span style={{ fontSize: "0.85rem", opacity: 0.65 }}>
        Scan unavailable
      </span>
    );
  }

  if (!cycle) {
    return (
      <span style={{ fontSize: "0.85rem", opacity: 0.65 }}>
        No scan yet
      </span>
    );
  }

  const status =
    cycle.status === "running"
      ? "Running"
      : cycle.status === "cancelled"
        ? "Cancelled"
        : "Completed";

  const scanned = count(cycle.completed_spots) +
    count(cycle.failed_spots);

  return (
    <span
      style={{
        display: "inline-flex",
        position: "relative",
        alignItems: "center",
      }}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label="Show Market scan results"
        aria-expanded={open}
        aria-describedby={open ? tooltipId : undefined}
        onMouseEnter={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((current) => !current)}
        style={{
          background: "transparent",
          border: "none",
          padding: "4px 0",
          cursor: "pointer",
          fontSize: "0.85rem",
          fontWeight: 700,
          color: "inherit",
          whiteSpace: "nowrap",
          textDecoration: "underline dotted",
          textUnderlineOffset: 4,
        }}
      >
        {status} · {formatMarketCycleDuration(cycle.elapsed_seconds)}
      </button>

      {open && (
        <span
          id={tooltipId}
          role="tooltip"
          style={{
            position: "absolute",
            left: 0,
            top: "calc(100% + 8px)",
            zIndex: 30,
            width: 244,
            maxWidth: "85vw",
            padding: "12px 14px",
            background: "#172530",
            color: "#fff",
            borderRadius: 10,
            boxShadow: "0 8px 28px rgba(0,0,0,0.2)",
            fontSize: "0.8rem",
            fontWeight: 400,
            lineHeight: 1.7,
          }}
        >
          <strong style={{ display: "block", marginBottom: 4 }}>
            Last Market scan
          </strong>

          <span style={{ display: "block" }}>
            Spots scanned: {scanned} / {count(cycle.expected_spots)}
          </span>
          <span style={{ display: "block" }}>
            Successful: {count(cycle.completed_spots)}
          </span>
          <span style={{ display: "block" }}>
            Exceptions: {count(cycle.failed_spots)}
          </span>

          {count(cycle.expected_shared_sources) > 0 && (
            <span style={{
              display: "block",
              borderTop: "1px solid rgba(255,255,255,0.2)",
              paddingTop: 5,
              marginTop: 5,
            }}>
              Shared sources: {count(cycle.completed_shared_sources)}
              {" / "}{count(cycle.expected_shared_sources)} completed
              {count(cycle.failed_shared_sources) > 0 &&
                ` · ${count(cycle.failed_shared_sources)} failed`}
            </span>
          )}

          {cycle.status === "running" && (
            <span style={{ display: "block", opacity: 0.8 }}>
              Pending: {count(cycle.pending_jobs)}
              {" · "}Retry: {count(cycle.retry_jobs)}
              {" · "}Active: {count(cycle.leased_jobs)}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
