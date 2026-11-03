import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function GET(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const secret = process.env.SUPABASE_SECRET_KEY;

  if (!url || !anon || !secret) {
    return NextResponse.json(
      { error: "Database configuration unavailable." },
      { status: 503 }
    );
  }

  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : "";

  if (!token) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 }
    );
  }

  const marketKey =
    request.nextUrl.searchParams.get("market") ?? "";

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(marketKey)) {
    return NextResponse.json(
      { error: "Invalid Market." },
      { status: 400 }
    );
  }

  const auth = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
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
    auth: { persistSession: false, autoRefreshToken: false },
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

  const { data: market, error: marketError } = await db
    .from("event_processing_markets")
    .select("id, market_key, display_name, is_enabled")
    .eq("market_key", marketKey)
    .maybeSingle();

  if (marketError || !market) {
    return NextResponse.json(
      { error: "Market not found." },
      { status: 404 }
    );
  }

  // Paginate to avoid Supabase's default 1000-row limit.
  const venueIds: string[] = [];

  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db
      .from("event_processing_market_venues")
      .select("venue_id")
      .eq("market_id", market.id)
      .order("venue_id")
      .range(offset, offset + 999);

    if (error) {
      return NextResponse.json(
        { error: "Could not load Market membership." },
        { status: 503 }
      );
    }

    venueIds.push(...(data ?? []).map(row => row.venue_id));

    if ((data ?? []).length < 1000) break;
  }

  return NextResponse.json(
    { market, venueIds },
    { headers: { "Cache-Control": "no-store" } }
  );
}
