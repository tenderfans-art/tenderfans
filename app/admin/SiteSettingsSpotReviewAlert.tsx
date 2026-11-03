"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export default function SiteSettingsSpotReviewAlert() {
  const [count, setCount] = useState<number | null>(null);
  const [missing, setMissing] = useState(0);

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

    void load();

    return () => { active = false; };
  }, []);

  if (count === null) return null;

  return (
    <div
      style={{
        marginTop: 12,
        fontSize: 13,
        fontWeight: 700,
      }}
    >
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
  );
}
