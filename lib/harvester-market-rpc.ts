"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

function currentMarketKey() {
  if (typeof window === "undefined") return "";

  return new URLSearchParams(
    window.location.search
  ).get("market") ?? "";
}

export function useHarvesterBackHref() {
  const [href, setHref] = useState("/admin/harvester");

  useEffect(() => {
    const key = currentMarketKey();

    if (key) {
      setHref(
        `/admin/harvester?market=${encodeURIComponent(key)}`
      );
    }
  }, []);

  return href;
}

export async function scopedHarvesterRpc(
  name: string,
  args: Record<string, unknown> = {}
): Promise<{
  data: any;
  error: { message: string } | null;
}> {
  const marketKey = currentMarketKey();

  if (!marketKey) {
    return supabase.rpc(name as never, args as never) as any;
  }

  try {
    const { data: { session } } =
      await supabase.auth.getSession();

    if (!session?.access_token) {
      throw new Error("Administrator sign-in required.");
    }

    const response = await fetch(
      `/api/admin/markets/harvester-rpc?market=${encodeURIComponent(marketKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ name, args }),
        cache: "no-store",
      }
    );

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(
        payload.error || "Harvester operation failed."
      );
    }

    return { data: payload.data ?? null, error: null };
  } catch (cause) {
    return {
      data: null,
      error: {
        message: cause instanceof Error
          ? cause.message
          : "Harvester operation failed.",
      },
    };
  }
}

export async function registerHarvesterGooglePlace(
  placeId: string
): Promise<Response> {
  const marketKey = currentMarketKey();

  if (!marketKey) {
    return fetch("/api/google/place", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ placeId }),
    });
  }

  const { data: { session } } =
    await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error("Administrator sign-in required.");
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.access_token}`,
  };

  const scopeResponse = await fetch(
    `/api/admin/markets/harvester-scope?market=${encodeURIComponent(marketKey)}`,
    {
      headers: { Authorization: headers.Authorization },
      cache: "no-store",
    }
  );

  const scope = await scopeResponse.json();

  if (!scopeResponse.ok || !scope.market?.id) {
    throw new Error(
      scope.error || "Could not resolve selected Market."
    );
  }

  return fetch("/api/google/place", {
    method: "POST",
    headers,
    body: JSON.stringify({
      placeId,
      marketId: scope.market.id,
    }),
  });
}
