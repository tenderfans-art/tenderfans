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


export async function POST(request: Request) {
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


  let body: {
    action?: string;
    name?: string;
    key?: string;
    marketId?: string;
    enabled?: boolean;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 }
    );
  }

  if (body.action === "create") {
    const name = body.name?.trim() ?? "";
    const key = body.key?.trim().toLowerCase() ?? "";

    if (
      name.length < 2 ||
      name.length > 100 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)
    ) {
      return NextResponse.json(
        { error: "Enter a valid market name and URL key." },
        { status: 400 }
      );
    }

    const { data, error } = await db
      .from("event_processing_markets")
      .insert({
        display_name: name,
        market_key: key,
        is_enabled: false,
      })
      .select("id, market_key, display_name, is_enabled")
      .single();

    if (error) {
      return NextResponse.json(
        { error: error.code === "23505"
          ? "That market key already exists."
          : "Unable to create market." },
        { status: 400 }
      );
    }

    return NextResponse.json({ market: data });
  }

  if (
    !body.marketId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      body.marketId
    )
  ) {
    return NextResponse.json(
      { error: "Valid market ID required." },
      { status: 400 }
    );
  }

  const { data: market, error: marketError } = await db
    .from("event_processing_markets")
    .select("id, market_key, is_enabled")
    .eq("id", body.marketId)
    .maybeSingle();

  if (marketError || !market) {
    return NextResponse.json(
      { error: "Market not found." },
      { status: 404 }
    );
  }

  if (body.action === "set-enabled") {
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json(
        { error: "Enabled must be true or false." },
        { status: 400 }
      );
    }

    if (body.enabled) {
      const { count, error } = await db
        .from("event_processing_market_venues")
        .select("venue_id", { count: "exact", head: true })
        .eq("market_id", market.id);

      if (error || !count) {
        return NextResponse.json(
          { error: "Assign Spots before enabling this market." },
          { status: 409 }
        );
      }
    }

    const { error } = await db
      .from("event_processing_markets")
      .update({ is_enabled: body.enabled })
      .eq("id", market.id);

    if (error) {
      return NextResponse.json(
        { error: "Unable to change market status." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      enabled: body.enabled,
    });
  }

  return NextResponse.json(
    { error: "Unsupported market operation." },
    { status: 400 }
  );
}
