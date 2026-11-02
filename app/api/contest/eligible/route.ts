import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function GET(request: NextRequest) {
  const bartenderId = request.nextUrl.searchParams.get("bartenderId");

  if (!bartenderId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bartenderId)) {
    return NextResponse.json({ error: "Invalid Tender." }, { status: 400 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    return NextResponse.json({ error: "Unavailable." }, { status: 503 });
  }

  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: tender, error: tenderError } = await db
    .from("bartenders")
    .select("id")
    .eq("id", bartenderId)
    .eq("status", "active")
    .maybeSingle();

  if (tenderError) {
    return NextResponse.json({ error: "Eligibility unavailable." }, { status: 503 });
  }
  if (!tender) {
    return NextResponse.json({ contestId: null });
  }

  const { data: relationships, error: relationshipError } = await db
    .from("bartender_venues")
    .select("venue_id")
    .eq("bartender_id", bartenderId)
    .eq("is_current", true);

  if (relationshipError) {
    return NextResponse.json({ error: "Eligibility unavailable." }, { status: 503 });
  }

  const venueIds = [...new Set((relationships ?? []).map((row) => row.venue_id))];
  if (!venueIds.length) {
    return NextResponse.json({ contestId: null });
  }

  const { data: venues, error: venueError } = await db
    .from("venues")
    .select("id")
    .in("id", venueIds)
    .eq("status", "active");

  if (venueError) {
    return NextResponse.json({ error: "Eligibility unavailable." }, { status: 503 });
  }

  const activeVenueIds = (venues ?? []).map((venue) => venue.id);
  if (!activeVenueIds.length) {
    return NextResponse.json({ contestId: null });
  }

  const { data: memberships, error: membershipError } = await db
    .from("event_processing_market_venues")
    .select("market_id")
    .in("venue_id", activeVenueIds);

  if (membershipError) {
    return NextResponse.json({ error: "Eligibility unavailable." }, { status: 503 });
  }

  const marketIds = [...new Set((memberships ?? []).map((row) => row.market_id))];
  if (!marketIds.length) {
    return NextResponse.json({ contestId: null });
  }

  const now = new Date().toISOString();
  const { data: contests, error: contestError } = await db
    .from("contests")
    .select("id")
    .in("market_id", marketIds)
    .eq("contest_format", "shouts")
    .eq("is_active", true)
    .lte("starts_at", now)
    .gte("ends_at", now)
    .order("id")
    .limit(1);

  if (contestError) {
    return NextResponse.json({ error: "Eligibility unavailable." }, { status: 503 });
  }

  return NextResponse.json(
    { contestId: contests?.[0]?.id ?? null },
    { headers: { "Cache-Control": "no-store" } }
  );
}
