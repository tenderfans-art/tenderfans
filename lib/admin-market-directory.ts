import { supabase } from "@/lib/supabase";

export type MarketDirectoryInfo = {
  id: string;
  market_key: string;
  display_name: string;
};

async function requestMarketDirectory(
  marketKey: string,
  options: {
    method: "GET" | "POST";
    kind?: "spots" | "tenders";
    body?: Record<string, unknown>;
  }
) {
  const { data: { session } } =
    await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error("Administrator sign-in required.");
  }

  const params = new URLSearchParams({
    market: marketKey,
  });

  if (options.kind) params.set("kind", options.kind);

  const response = await fetch(
    `/api/admin/markets/directory?${params.toString()}`,
    {
      method: options.method,
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        ...(options.method === "POST"
          ? { "Content-Type": "application/json" }
          : {}),
      },
      ...(options.body
        ? { body: JSON.stringify(options.body) }
        : {}),
      cache: "no-store",
    }
  );

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(
      payload.error || "Market request failed."
    );
  }

  return payload;
}

export async function loadMarketDirectory(
  marketKey: string,
  kind: "spots" | "tenders"
) {
  return requestMarketDirectory(marketKey, {
    method: "GET",
    kind,
  });
}

export async function performMarketDirectoryAction(
  marketKey: string,
  body: Record<string, unknown>
) {
  return requestMarketDirectory(marketKey, {
    method: "POST",
    body,
  });
}
