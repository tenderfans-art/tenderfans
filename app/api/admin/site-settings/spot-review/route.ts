import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

type MarketRow = {
  id: string;
  market_key: string;
  display_name: string;
};

type GoogleRow = {
  place_id: string;
  place_data: {
    name?: string;
    formattedAddress?: string;
  } | null;
};

type RedirectRow = {
  id: string;
  venue_id: string;
  provider_venue_name: string;
};

type MarketOverview = MarketRow & {
  googlePending: number;
  redirectPending: number;
  googleExamples: string[];
  redirectExamples: string[];
};

function batches<T>(items: T[], size = 100): T[][] {
  const result: T[][] = [];

  for (let offset = 0; offset < items.length; offset += size) {
    result.push(items.slice(offset, offset + size));
  }

  return result;
}

export async function GET(request: NextRequest) {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const secret = process.env.SUPABASE_SECRET_KEY;

    if (!url || !anon || !secret) {
      return NextResponse.json(
        { error: "Database configuration unavailable." },
        { status: 503 }
      );
    }

    const authorization =
      request.headers.get("authorization") ?? "";

    if (!authorization.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401 }
      );
    }

    const token = authorization.slice(7);

    const auth = createClient(url, anon, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const { data: identity, error: identityError } =
      await auth.auth.getUser(token);

    if (identityError || !identity.user) {
      return NextResponse.json(
        { error: "Invalid session." },
        { status: 401 }
      );
    }

    const db = createClient(url, secret, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const { data: admin, error: adminError } = await db
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", identity.user.id)
      .maybeSingle();

    if (adminError || !admin) {
      return NextResponse.json(
        { error: "Administrator access required." },
        { status: 403 }
      );
    }

    // Load every Market, not just the first 1,000 rows.
    const markets: MarketRow[] = [];

    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db
        .from("event_processing_markets")
        .select("id, market_key, display_name")
        .order("id")
        .range(offset, offset + 999);

      if (error) throw error;

      markets.push(...(data ?? []));

      if ((data ?? []).length < 1000) break;
    }

    // Use the existing Google Places review decisions.
    // Do not create another review queue.
    const google: GoogleRow[] = [];

    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db
        .from("event_harvest_google_spot_reviews")
        .select("place_id, place_data")
        .eq("status", "pending")
        .order("place_id")
        .range(offset, offset + 999);

      if (error) throw error;

      google.push(
        ...((data ?? []) as unknown as GoogleRow[])
      );

      if ((data ?? []).length < 1000) break;
    }

    // Pending Google identities are assigned to Markets by
    // the durable onboarding request, not by geographic guesses.
    const googleMarkets = new Map<string, string>();

    for (const ids of batches(
      google.map(item => item.place_id)
    )) {
      const { data, error } = await db
        .from("event_google_spot_market_requests")
        .select("place_id, market_id")
        .in("place_id", ids);

      if (error) throw error;

      for (const row of data ?? []) {
        googleMarkets.set(row.place_id, row.market_id);
      }
    }

    // Existing Spot Review also includes website redirects.
    const redirects: RedirectRow[] = [];

    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db
        .from("event_harvest_venue_matches")
        .select("id, venue_id, provider_venue_name")
        .eq("status", "pending")
        .eq("provider", "website_redirect")
        .order("id")
        .range(offset, offset + 999);

      if (error) throw error;

      redirects.push(
        ...((data ?? []) as RedirectRow[])
      );

      if ((data ?? []).length < 1000) break;
    }

    // Redirects belong to the Market of the existing Spot.
    const redirectMarkets = new Map<string, string>();

    const venueIds = [
      ...new Set(redirects.map(item => item.venue_id)),
    ];

    for (const ids of batches(venueIds)) {
      const { data, error } = await db
        .from("event_processing_market_venues")
        .select("venue_id, market_id")
        .in("venue_id", ids);

      if (error) throw error;

      for (const row of data ?? []) {
        redirectMarkets.set(row.venue_id, row.market_id);
      }
    }

    const overview = new Map<string, MarketOverview>();

    for (const market of markets) {
      overview.set(market.id, {
        ...market,
        googlePending: 0,
        redirectPending: 0,
        googleExamples: [],
        redirectExamples: [],
      });
    }

    let missingMarket = 0;

    for (const item of google) {
      const marketId = googleMarkets.get(item.place_id);
      const market = marketId
        ? overview.get(marketId)
        : undefined;

      if (!market) {
        missingMarket += 1;
        continue;
      }

      market.googlePending += 1;

      if (market.googleExamples.length < 5) {
        market.googleExamples.push(
          item.place_data?.name || item.place_id
        );
      }
    }

    for (const item of redirects) {
      const marketId = redirectMarkets.get(item.venue_id);
      const market = marketId
        ? overview.get(marketId)
        : undefined;

      if (!market) {
        missingMarket += 1;
        continue;
      }

      market.redirectPending += 1;

      if (market.redirectExamples.length < 5) {
        market.redirectExamples.push(
          item.provider_venue_name || item.venue_id
        );
      }
    }

    return NextResponse.json(
      {
        totals: {
          google: google.length,
          redirects: redirects.length,
          missingMarket,
        },
        markets: [...overview.values()].sort(
          (a, b) =>
            a.display_name.localeCompare(b.display_name)
        ),
      },
      {
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (error) {
    console.error("Global Spot Review overview failed:", error);

    return NextResponse.json(
      { error: "Could not load global Spot Review." },
      { status: 500 }
    );
  }
}
