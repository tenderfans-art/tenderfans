import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

type DB = ReturnType<typeof createClient>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function chunks<T>(items: T[], size = 100): T[][] {
  const result: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }

  return result;
}

async function resolveContext(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const secret = process.env.SUPABASE_SECRET_KEY;

  if (!url || !anon || !secret) {
    throw new Error("Database configuration unavailable.");
  }

  const authorization =
    request.headers.get("authorization") ?? "";

  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  if (!token) {
    return {
      response: NextResponse.json(
        { error: "Authentication required." },
        { status: 401 }
      ),
    };
  }

  const marketKey =
    request.nextUrl.searchParams.get("market") ?? "";

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(marketKey)) {
    return {
      response: NextResponse.json(
        { error: "Invalid Market." },
        { status: 400 }
      ),
    };
  }

  const auth = createClient(url, anon, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data: identity, error: identityError } =
    await auth.auth.getUser(token);

  if (identityError || !identity.user) {
    return {
      response: NextResponse.json(
        { error: "Invalid session." },
        { status: 401 }
      ),
    };
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
    return {
      response: NextResponse.json(
        { error: "Administrator access required." },
        { status: 403 }
      ),
    };
  }

  const { data: market, error: marketError } = await db
    .from("event_processing_markets")
    .select("id, market_key, display_name")
    .eq("market_key", marketKey)
    .maybeSingle();

  if (marketError || !market) {
    return {
      response: NextResponse.json(
        { error: "Market not found." },
        { status: 404 }
      ),
    };
  }

  const venueIds: string[] = [];

  // Preserve full membership even beyond the default row limit.
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db
      .from("event_processing_market_venues")
      .select("venue_id")
      .eq("market_id", market.id)
      .order("venue_id")
      .range(offset, offset + 999);

    if (error) throw error;

    for (const item of data ?? []) {
      venueIds.push(item.venue_id);
    }

    if ((data ?? []).length < 1000) break;
  }

  const userClient = createClient(url, anon, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return {
    context: {
      db,
      userClient,
      market,
      venueIds,
      allowed: new Set(venueIds),
    },
  };
}

type Context = NonNullable<
  Awaited<ReturnType<typeof resolveContext>>["context"]
>;

async function loadSpots(context: Context) {
  const { db, venueIds } = context;

  const spots: {
    id: string;
    name: string;
    slug: string;
    city: string;
    state_region: string;
    status: string;
    manager_name: string | null;
    manager_role: string | null;
    manager_email: string | null;
  }[] = [];

  const managers = new Map<string, {
    claimant_name: string | null;
    claimant_role: string | null;
    business_email: string | null;
  }>();

  for (const batch of chunks(venueIds)) {
    const { data, error } = await db
      .from("venues")
      .select("id, name, slug, city, state_region, status")
      .in("id", batch);

    if (error) throw error;

    for (const spot of data ?? []) {
      spots.push({
        ...spot,
        manager_name: null,
        manager_role: null,
        manager_email: null,
      });
    }

    // Same approved-manager relationship used by admin_list_spots.
    for (let offset = 0; ; offset += 1000) {
      const { data: claims, error: claimsError } = await db
        .from("entity_claims")
        .select(
          "venue_id, claimant_name, claimant_role, business_email, reviewed_at, created_at"
        )
        .eq("entity_kind", "venue")
        .eq("status", "approved")
        .in("venue_id", batch)
        .order("reviewed_at", {
          ascending: false,
          nullsFirst: false,
        })
        .order("created_at", { ascending: false })
        .range(offset, offset + 999);

      if (claimsError) throw claimsError;

      for (const claim of claims ?? []) {
        if (
          claim.venue_id &&
          !managers.has(claim.venue_id)
        ) {
          managers.set(claim.venue_id, claim);
        }
      }

      if ((claims ?? []).length < 1000) break;
    }
  }

  for (const spot of spots) {
    const manager = managers.get(spot.id);

    if (manager) {
      spot.manager_name = manager.claimant_name;
      spot.manager_role = manager.claimant_role;
      spot.manager_email = manager.business_email;
    }
  }

  return spots.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id)
  );
}

async function loadTenders(context: Context) {
  const { db, venueIds } = context;

  const spotNames = new Map<string, string>();

  for (const batch of chunks(venueIds)) {
    const { data, error } = await db
      .from("venues")
      .select("id, name")
      .in("id", batch);

    if (error) throw error;

    for (const spot of data ?? []) {
      spotNames.set(spot.id, spot.name);
    }
  }

  // Current associations determine Market membership.
  const tenderSpots = new Map<string, Set<string>>();

  for (const batch of chunks(venueIds)) {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db
        .from("bartender_venues")
        .select("id, bartender_id, venue_id")
        .eq("is_current", true)
        .in("venue_id", batch)
        .order("id")
        .range(offset, offset + 999);

      if (error) throw error;

      for (const link of data ?? []) {
        if (!tenderSpots.has(link.bartender_id)) {
          tenderSpots.set(link.bartender_id, new Set());
        }

        tenderSpots.get(link.bartender_id)!.add(link.venue_id);
      }

      if ((data ?? []).length < 1000) break;
    }
  }

  const tenderIds = [...tenderSpots.keys()];
  const tenders: {
    id: string;
    display_name: string;
    slug: string;
    tender_type: string;
    status: string;
    current_venue_id: string | null;
    current_venue_name: string | null;
    is_claimed: boolean;
  }[] = [];

  const claimed = new Set<string>();

  for (const batch of chunks(tenderIds)) {
    const { data, error } = await db
      .from("bartenders")
      .select("id, display_name, slug, tender_type, status")
      .in("id", batch);

    if (error) throw error;

    for (const tender of data ?? []) {
      const ids = [...(tenderSpots.get(tender.id) ?? [])];

      const marketSpotNames = ids
        .map(id => spotNames.get(id))
        .filter((name): name is string => Boolean(name))
        .sort((a, b) => a.localeCompare(b));

      tenders.push({
        ...tender,
        current_venue_id: ids[0] ?? null,
        current_venue_name:
          marketSpotNames.join(", ") || null,
        is_claimed: false,
      });
    }

    for (let offset = 0; ; offset += 1000) {
      const { data: permissions, error: permissionError } =
        await db
          .from("bartender_permissions")
          .select("bartender_id")
          .in("bartender_id", batch)
          .order("bartender_id")
          .range(offset, offset + 999);

      if (permissionError) throw permissionError;

      for (const permission of permissions ?? []) {
        claimed.add(permission.bartender_id);
      }

      if ((permissions ?? []).length < 1000) break;
    }
  }

  for (const tender of tenders) {
    tender.is_claimed = claimed.has(tender.id);
  }

  return tenders.sort(
    (a, b) =>
      a.display_name.localeCompare(b.display_name) ||
      a.id.localeCompare(b.id)
  );
}

export async function GET(request: NextRequest) {
  try {
    const result = await resolveContext(request);

    if ("response" in result) return result.response;

    const context = result.context!;
    const kind = request.nextUrl.searchParams.get("kind");

    if (kind === "spots") {
      return NextResponse.json(
        {
          market: context.market,
          spots: await loadSpots(context),
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    if (kind === "tenders") {
      return NextResponse.json(
        {
          market: context.market,
          tenders: await loadTenders(context),
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    return NextResponse.json(
      { error: "Invalid directory type." },
      { status: 400 }
    );
  } catch (error) {
    console.error("Market directory read failed:", error);

    return NextResponse.json(
      { error: "Could not load Market directory." },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const result = await resolveContext(request);

    if ("response" in result) return result.response;

    const context = result.context!;
    const { allowed, db, userClient } = context;

    const body = await request.json();
    const action = body?.action;

    let operation: string;
    let args: Record<string, string>;

    if (action === "remove-spot") {
      const id = body?.venueId;

      if (typeof id !== "string" || !uuidPattern.test(id)) {
        return NextResponse.json(
          { error: "Invalid Spot." },
          { status: 400 }
        );
      }

      if (!allowed.has(id)) {
        return NextResponse.json(
          { error: "Spot does not belong to this Market." },
          { status: 403 }
        );
      }

      operation = "admin_remove_spot";
      args = { p_venue_id: id };
    } else if (action === "add-tender") {
      const id = body?.venueId;
      const name =
        typeof body?.name === "string"
          ? body.name.trim()
          : "";

      if (
        typeof id !== "string" ||
        !uuidPattern.test(id) ||
        name.length < 1 ||
        name.length > 150
      ) {
        return NextResponse.json(
          { error: "Invalid Tender or Spot." },
          { status: 400 }
        );
      }

      if (!allowed.has(id)) {
        return NextResponse.json(
          { error: "Spot does not belong to this Market." },
          { status: 403 }
        );
      }

      operation = "create_bartender_at_venue";
      args = {
        p_display_name: name,
        p_venue_id: id,
      };
    } else if (action === "remove-tender") {
      const id = body?.tenderId;

      if (typeof id !== "string" || !uuidPattern.test(id)) {
        return NextResponse.json(
          { error: "Invalid Tender." },
          { status: 400 }
        );
      }

      // Removing a Tender is global, so don't allow a Market
      // to remove a Tender linked to any other Market or to
      // Spots outside this Market's assigned membership.
      const { data: links, error: linkError } = await db
        .from("bartender_venues")
        .select("venue_id")
        .eq("bartender_id", id)
        .eq("is_current", true);

      if (linkError) throw linkError;

      const venues = (links ?? []).map(link => link.venue_id);

      if (!venues.some(venueId => allowed.has(venueId))) {
        return NextResponse.json(
          { error: "Tender does not belong to this Market." },
          { status: 403 }
        );
      }

      if (venues.some(venueId => !allowed.has(venueId))) {
        return NextResponse.json(
          {
            error:
              "This Tender has current Spot associations outside this Market. Use global Admin for a platform-wide removal.",
          },
          { status: 409 }
        );
      }

      operation = "admin_remove_tender";
      args = { p_bartender_id: id };
    } else {
      return NextResponse.json(
        { error: "Unsupported Market action." },
        { status: 400 }
      );
    }

    // Execute the original RPC as the authenticated Admin.
    const { data, error } = await userClient.rpc(
      operation as never,
      args as never
    );

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { ok: true, data },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Market directory action failed:", error);

    return NextResponse.json(
      { error: "Could not complete Market action." },
      { status: 500 }
    );
  }
}
