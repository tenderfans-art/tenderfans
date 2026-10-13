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
      "admin_event_harvest_coverage_tally",
    );

    if (error) throw error;

    const tally = Array.isArray(data) ? data[0] : data;

    if (!tally) {
      throw new Error("Coverage tally returned no data.");
    }

    const { data: activeErrors, error: errorsError } = await admin.rpc(
      "admin_event_harvest_active_errors"
    );

    if (errorsError) throw errorsError;

    return NextResponse.json(
      { ...tally, active_errors: activeErrors?.length ?? 0 },
      {
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
