import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function GET(request: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const secret = process.env.SUPABASE_SECRET_KEY;

  if (!url || !anon || !secret) {
    return NextResponse.json(
      { error: "Database configuration unavailable." },
      { status: 500 }
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

  const authClient = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: identity, error: identityError } =
    await authClient.auth.getUser(token);

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

  const { data: markets, error } = await db
    .from("event_processing_markets")
    .select("id, market_key, display_name, is_enabled")
    .order("display_name");

  if (error) {
    return NextResponse.json(
      { error: "Unable to load markets." },
      { status: 500 }
    );
  }

  const { data: memberships, error: membershipError } = await db
    .from("event_processing_market_venues")
    .select("market_id");

  if (membershipError) {
    return NextResponse.json(
      { error: "Unable to load market membership." },
      { status: 500 }
    );
  }

  const counts = new Map<string, number>();
  for (const member of memberships ?? []) {
    counts.set(
      member.market_id,
      (counts.get(member.market_id) ?? 0) + 1
    );
  }

  return NextResponse.json({
    markets: (markets ?? []).map((market) => ({
      ...market,
      spot_count: counts.get(market.id) ?? 0,
    })),
  });
}
