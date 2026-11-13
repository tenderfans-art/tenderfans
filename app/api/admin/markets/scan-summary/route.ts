import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const noStore = {
  "Cache-Control": "no-store",
};

function failure(message: string, status: number) {
  return NextResponse.json(
    { error: message },
    { status, headers: noStore },
  );
}

export async function GET(request: NextRequest) {
  const marketKey = request.nextUrl.searchParams.get("market");

  if (
    !marketKey ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(marketKey)
  ) {
    return failure("Invalid Market.", 400);
  }

  const token = request.headers.get("authorization") ?? "";

  if (!token.startsWith("Bearer ") || !token.slice(7)) {
    return failure("Administrator sign-in required.", 401);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const secret = process.env.SUPABASE_SECRET_KEY;

  if (!url || !anon || !secret) {
    return failure("Database configuration unavailable.", 503);
  }

  try {
    const userClient = createClient(url, anon, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const { data: identity, error: identityError } =
      await userClient.auth.getUser(token.slice(7));

    if (identityError || !identity.user) {
      return failure("Invalid session.", 401);
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

    if (adminError) {
      return failure("Administrator lookup failed.", 503);
    }

    if (!admin) {
      return failure("Administrator access required.", 403);
    }

    const { data: market, error: marketError } = await db
      .from("event_processing_markets")
      .select("id")
      .eq("market_key", marketKey)
      .maybeSingle();

    if (marketError) {
      return failure("Market lookup failed.", 503);
    }

    if (!market) {
      return failure("Market not found.", 404);
    }

    // Indexed latest-cycle lookup. Avoid aggregating every
    // historical Market cycle just to display one header.
    const { data: latest, error: latestError } = await db
      .from("event_processing_market_cycles")
      .select("id")
      .eq("market_id", market.id)
      .order("scheduled_for", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestError) {
      return failure("Unable to load latest scan.", 503);
    }

    if (!latest) {
      return NextResponse.json(
        { cycle: null },
        { headers: noStore },
      );
    }

    const { data: cycle, error: progressError } = await db
      .from("event_processing_market_cycle_progress")
      .select("*")
      .eq("cycle_id", latest.id)
      .maybeSingle();

    if (progressError || !cycle) {
      return failure("Unable to load scan results.", 503);
    }

    return NextResponse.json(
      { cycle },
      { headers: noStore },
    );
  } catch (error) {
    console.error("Market scan summary failed:", error);
    return failure("Unable to load scan summary.", 503);
  }
}
