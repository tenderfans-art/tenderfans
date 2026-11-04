import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

type Finding = {
  id: string;
  venue_id: string;
  source_type: string | null;
  error: string | null;
  source_url: string | null;
  last_seen_at: string;
};

type Market = {
  id: string;
  market_key: string;
  display_name: string;
};

type VisibleFinding = Finding & {
  venue_name: string;
};

type MarketSummary = Market & {
  affectedSpots: number;
  failures: number;
  facebookAffectedSpots: number;
  facebookFailures: number;
  findings: VisibleFinding[];
};

function batches<T>(items: T[], size = 100): T[][] {
  const result: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
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

    // Use the same active Adapter Error category as the
    // existing HM RPC. Tier One excludes Facebook errors.
    //
    // Order by unique ID for stable pagination across
    // Supabase's default result-size limit.
    const findings: Finding[] = [];

    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db
        .from("event_harvest_detector_findings")
        .select(
          "id, venue_id, source_type, error, source_url, last_seen_at"
        )
        .eq("category", "adapter_error")
        .eq("status", "active")
        .order("id")
        .range(offset, offset + 999);

      if (error) throw error;

      for (const row of data ?? []) {
        findings.push(row as Finding);
      }

      if ((data ?? []).length < 1000) break;
    }

    // The existing HM Tier One tab excludes Facebook.
    // Maintain that distinction in global totals.
    const tierOneFindings = findings.filter(
      finding =>
        finding.source_type !== "facebook" &&
        finding.source_type !== "facebook_events"
    );

    const markets: Market[] = [];

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

    const venueIds = [
      ...new Set(findings.map(row => row.venue_id)),
    ];

    const venueMarkets = new Map<string, string>();
    const venueNames = new Map<string, string>();

    for (const batch of batches(venueIds)) {
      const [memberships, venues] = await Promise.all([
        db
          .from("event_processing_market_venues")
          .select("venue_id, market_id")
          .in("venue_id", batch),

        db
          .from("venues")
          .select("id, name")
          .in("id", batch),
      ]);

      if (memberships.error) throw memberships.error;
      if (venues.error) throw venues.error;

      for (const item of memberships.data ?? []) {
        venueMarkets.set(item.venue_id, item.market_id);
      }

      for (const venue of venues.data ?? []) {
        venueNames.set(venue.id, venue.name);
      }
    }

    const overview = new Map<string, MarketSummary>();

    for (const market of markets) {
      overview.set(market.id, {
        ...market,
        affectedSpots: 0,
        failures: 0,
        facebookAffectedSpots: 0,
        facebookFailures: 0,
        findings: [],
      });
    }

    const unmatchedVenues = new Set<string>();
    const unmatchedFacebookVenues = new Set<string>();

    const facebookSpotsByMarket =
      new Map<string, Set<string>>();

    let unmatchedFailures = 0;
    let unmatchedFacebookFailures = 0;

    for (const finding of findings) {
      const isFacebook =
        finding.source_type === "facebook" ||
        finding.source_type === "facebook_events";

      const marketId = venueMarkets.get(finding.venue_id);

      const market = marketId
        ? overview.get(marketId)
        : undefined;

      if (!market) {
        if (isFacebook) {
          unmatchedFacebookVenues.add(finding.venue_id);
          unmatchedFacebookFailures += 1;
        } else {
          unmatchedVenues.add(finding.venue_id);
          unmatchedFailures += 1;
        }
        continue;
      }

      if (isFacebook) {
        market.facebookFailures += 1;

        const spots =
          facebookSpotsByMarket.get(market.id) ??
          new Set<string>();

        spots.add(finding.venue_id);
        facebookSpotsByMarket.set(market.id, spots);
        continue;
      }

      market.findings.push({
        ...finding,
        venue_name:
          venueNames.get(finding.venue_id) ??
          "Unknown Spot",
      });

      market.failures += 1;
    }

    let totalAffectedSpots = 0;
    let totalFacebookSpots = 0;

    for (const market of overview.values()) {
      market.affectedSpots = new Set(
        market.findings.map(row => row.venue_id)
      ).size;

      market.facebookAffectedSpots =
        facebookSpotsByMarket.get(market.id)?.size ?? 0;

      totalAffectedSpots += market.affectedSpots;
      totalFacebookSpots += market.facebookAffectedSpots;

      market.findings.sort((a, b) =>
        a.venue_name.localeCompare(b.venue_name) ||
        (a.source_type ?? "").localeCompare(
          b.source_type ?? ""
        ) ||
        b.last_seen_at.localeCompare(a.last_seen_at)
      );
    }

    return NextResponse.json(
      {
        totals: {
          // Original fields retain Tier One-only meaning.
          failures: tierOneFindings.length,
          affectedSpots:
            totalAffectedSpots + unmatchedVenues.size,
          missingMarketFailures: unmatchedFailures,
          missingMarketSpots: unmatchedVenues.size,

          // Facebook is independent, matching the HM tab.
          facebookFailures:
            findings.length - tierOneFindings.length,
          facebookAffectedSpots:
            totalFacebookSpots + unmatchedFacebookVenues.size,
          missingMarketFacebookFailures:
            unmatchedFacebookFailures,
          missingMarketFacebookSpots:
            unmatchedFacebookVenues.size,
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
    console.error(
      "Global Adapter Errors overview failed:",
      error
    );

    return NextResponse.json(
      { error: "Could not load Global Adapter Errors." },
      { status: 500 }
    );
  }
}
