import { supabase } from "@/lib/supabase";

export type ContestMarket = {
  id: string;
  market_key: string;
  display_name: string;
};

export async function loadContestMarkets(): Promise<ContestMarket[]> {
  const { data: { session } } =
    await supabase.auth.getSession();

  if (!session) {
    throw new Error("Admin session expired.");
  }

  const response = await fetch("/api/admin/markets", {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
    cache: "no-store",
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(
      payload.error ?? "Unable to load Markets."
    );
  }

  return payload.markets as ContestMarket[];
}
