"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Props = {
  rpc: string;
  marketVenueIds?: string[];
};

export default function BucketCount({
  rpc,
  marketVenueIds,
}: Props) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let active = true;

    async function refresh() {
      const { data, error } = await supabase.rpc(rpc as never);

      if (active) {
        const allowed = marketVenueIds
          ? new Set(marketVenueIds)
          : null;

        setCount(error ? null : Array.isArray(data)
          ? new Set(
              data
                .map((row: { venue_id: string }) => row.venue_id)
                .filter((id: string) =>
                  Boolean(id) && (!allowed || allowed.has(id))
                )
            ).size
          : null);
      }
    }

    void refresh();
    const timer = setInterval(() => void refresh(), 30000);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [rpc, marketVenueIds]);

  return (
    <span
      style={{
        display: "inline-block",
        marginLeft: 10,
        fontSize: "0.85rem",
        fontWeight: 800,
        opacity: 0.75,
      }}
      title="Active findings (refreshes every 30 seconds)"
    >
      {count === null ? "—" : `(${count})`}
    </span>
  );
}
