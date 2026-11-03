"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export default function SiteSettingsSpotReviewAlert() {
  const [count, setCount] = useState<number | null>(null);
  const [missing, setMissing] = useState(0);
  const [adapterFailures, setAdapterFailures] =
    useState<number | null>(null);
  const [adapterSpots, setAdapterSpots] = useState(0);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const { data: { session } } =
          await supabase.auth.getSession();

        if (!session?.access_token) return;

        const response = await fetch(
          "/api/admin/site-settings/spot-review",
          {
            headers: {
              Authorization:
                `Bearer ${session.access_token}`,
            },
            cache: "no-store",
          }
        );

        if (!response.ok) return;

        const data = await response.json();

        if (!active) return;

        setCount(
          Number(data.totals.google) +
          Number(data.totals.redirects)
        );
        setMissing(Number(data.totals.missingMarket));
      } catch {
        // Do not interrupt the Admin dashboard when
        // the overview is unavailable.
      }
    }

    async function loadAdapters() {
      try {
        const { data: { session } } =
          await supabase.auth.getSession();

        if (!session?.access_token) return;

        const response = await fetch(
          "/api/admin/site-settings/adapter-errors",
          {
            headers: {
              Authorization:
                `Bearer ${session.access_token}`,
            },
            cache: "no-store",
          }
        );

        if (!response.ok) return;

        const data = await response.json();

        if (!active) return;

        setAdapterFailures(
          Number(data.totals.failures)
        );
        setAdapterSpots(
          Number(data.totals.affectedSpots)
        );
      } catch {
        // An overview failure must not block Admin navigation.
      }
    }

    void load();
    void loadAdapters();

    return () => { active = false; };
  }, []);

  if (count === null && adapterFailures === null) {
    return null;
  }

  return (
    <div
      style={{
        marginTop: 12,
        fontSize: 13,
        fontWeight: 700,
      }}
    >
      {count !== null && (
        <div>
          {count === 0
            ? "No pending Spot Reviews"
            : `${count} pending Spot Review ${
                count === 1 ? "item" : "items"
              }`}
          {missing > 0 && (
            <div
              style={{
                marginTop: 5,
                color: "#a03c29",
              }}
            >
              {missing} require Market attribution
            </div>
          )}
        </div>
      )}

      {adapterFailures !== null && (
        <div style={{ marginTop: 6 }}>
          {adapterFailures === 0
            ? "No active Tier One Adapter Errors"
            : `${adapterFailures} Tier One failures across ${
                adapterSpots
              } Spots`}
        </div>
      )}
    </div>
  );
}
