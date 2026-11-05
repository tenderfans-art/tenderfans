import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

type DB = NonNullable<Awaited<ReturnType<typeof context>>["db"]>;

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string, status: number) {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

async function context(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const secret = process.env.SUPABASE_SECRET_KEY;

  if (!url || !anon || !secret)
    return { response: fail("Database unavailable.", 503) };

  const key = request.nextUrl.searchParams.get("market") ?? "";

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key))
    return { response: fail("Invalid Market.", 400) };

  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7) : "";

  if (!token)
    return { response: fail("Sign-in required.", 401) };

  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: identity, error: identityError } =
    await userClient.auth.getUser(token);

  if (identityError || !identity.user)
    return { response: fail("Invalid session.", 401) };

  const db = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: admin, error: adminError } = await db
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", identity.user.id)
    .maybeSingle();

  if (adminError || !admin)
    return { response: fail("Admin required.", 403) };

  const { data: market, error: marketError } = await db
    .from("event_processing_markets")
    .select("id,market_key,display_name")
    .eq("market_key", key)
    .maybeSingle();

  if (marketError || !market)
    return { response: fail("Market not found.", 404) };

  return { db, userClient, market };
}

async function listMarketEvents(
  db: DB,
  marketId: string
) {
  const venueIds: string[] = [];

  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db
      .from("event_processing_market_venues")
      .select("venue_id")
      .eq("market_id", marketId)
      .order("venue_id")
      .range(offset, offset + 999);

    if (error) throw error;

    venueIds.push(...((data ?? []) as Array<{ venue_id: string }>).map(v => v.venue_id));

    if ((data ?? []).length < 1000) break;
  }

  const events: Array<Record<string, unknown>> = [];
  const names = new Map<string, string>();

  for (let i = 0; i < venueIds.length; i += 75) {
    const batch = venueIds.slice(i, i + 75);

    const { data: venues, error: venueError } = await db
      .from("venues")
      .select("id,name")
      .in("id", batch);

    if (venueError) throw venueError;

    for (const venue of (venues ?? []) as Array<{ id: string; name: string }>)
      names.set(venue.id, venue.name);

    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db
        .from("events")
        .select(
          "id,venue_id,title,starts_at,ends_at,status,venue_approval_status,admin_approval_status,flyer_storage_path"
        )
        .in("venue_id", batch)
        .order("starts_at", { ascending: false })
        .order("id")
        .range(offset, offset + 999);

      if (error) throw error;

      for (const event of (data ?? []) as Array<{ id: string; venue_id: string; starts_at: string }>) {
        events.push({
          ...event,
          venue_name: names.get(event.venue_id) ?? "Unknown Spot",
        });
      }

      if ((data ?? []).length < 1000) break;
    }
  }

  return events.sort((a, b) =>
    String(b.starts_at).localeCompare(String(a.starts_at)) ||
    String(a.id).localeCompare(String(b.id))
  );
}

export async function GET(request: NextRequest) {
  try {
    const result = await context(request);
    if (result.response) return result.response;

    const events = await listMarketEvents(
      result.db!,
      result.market!.id
    );

    return NextResponse.json(
      { market: result.market, events },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Market event list failed:", error);
    return fail("Could not load Market events.", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const result = await context(request);
    if (result.response) return result.response;

    let body: { action?: string; eventId?: string };

    try {
      body = await request.json();
    } catch {
      return fail("Invalid request.", 400);
    }

    if (
      body?.action !== "delete" ||
      typeof body.eventId !== "string" ||
      !uuid.test(body.eventId)
    ) {
      return fail("Invalid event operation.", 400);
    }

    // Authenticated Admin context, never service-role writes.
    // Database function atomically validates Market ownership.
    const { data, error } = await result.userClient!.rpc(
      "admin_delete_market_event" as never,
      {
        p_event_id: body.eventId,
        p_market_id: result.market!.id,
      } as never
    );

    if (error) return fail(error.message, 403);

    return NextResponse.json({
      success: true,
      flyerPath: (data as string | null) ?? null,
    });
  } catch (error) {
    console.error("Market event deletion failed:", error);
    return fail("Could not delete Market event.", 500);
  }
}
