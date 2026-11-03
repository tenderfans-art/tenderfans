import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const authorization = request.headers.get("authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401 },
      );
    }

    const token = authorization.slice(7);
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const secret = process.env.SUPABASE_SECRET_KEY;

    if (!url || !anonKey || !secret) {
      throw new Error("Supabase server configuration is incomplete.");
    }

    const userClient = createClient(url, anonKey, {
      global: {
        headers: { Authorization: `Bearer ${token}` },
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const { data: { user }, error: userError } =
      await userClient.auth.getUser(token);

    if (userError || !user) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401 },
      );
    }

    const admin = createClient(url, secret, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const { data: platformAdmin, error: adminError } = await admin
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (adminError) throw adminError;

    if (!platformAdmin) {
      return NextResponse.json(
        { error: "Admin access required." },
        { status: 403 },
      );
    }

    const { data, error } = await admin.rpc(
      "admin_event_harvest_unaccounted_spots",
    );

    if (error) throw error;

    if (!Array.isArray(data)) {
      throw new Error("Unaccounted Spot query returned invalid data.");
    }

    let visible = data;

    const marketKey =
      request.nextUrl.searchParams.get("market");

    if (marketKey) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(marketKey)) {
        return NextResponse.json(
          { error: "Invalid Market." },
          { status: 400 }
        );
      }

      const { data: market, error: marketError } = await admin
        .from("event_processing_markets")
        .select("id")
        .eq("market_key", marketKey)
        .maybeSingle();

      if (marketError || !market) {
        return NextResponse.json(
          { error: "Market not found." },
          { status: 404 }
        );
      }

      const allowed = new Set<string>();

      for (let offset = 0; ; offset += 1000) {
        const { data: members, error: memberError } = await admin
          .from("event_processing_market_venues")
          .select("venue_id")
          .eq("market_id", market.id)
          .order("venue_id")
          .range(offset, offset + 999);

        if (memberError) throw memberError;

        for (const item of members ?? []) {
          allowed.add(item.venue_id);
        }

        if ((members ?? []).length < 1000) break;
      }

      visible = data.filter(row => allowed.has(row.venue_id));
    }

    return NextResponse.json(visible, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Harvester coverage tally failed:", error);
    return NextResponse.json(
      { error: "Could not retrieve Harvester coverage." },
      { status: 500 },
    );
  }
}
