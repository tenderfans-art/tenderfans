import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

type DB = ReturnType<typeof createClient>;

type MarketContext = {
  db: DB;
  userClient: DB;
  market: {
    id: string;
    market_key: string;
    display_name: string;
  };
  allowed: Set<string>;
};

type Claim = {
  id: string;
  entity_kind: string;
  venue_id: string | null;
  bartender_id: string | null;
  requested_venue_id: string | null;
};

type VenueRequest = {
  id: string;
  venue_id: string;
};

type EventRequest = {
  id: string;
  venue_id: string;
};

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failure(message: string, status: number) {
  return NextResponse.json(
    { error: message },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    }
  );
}

function chunks<T>(items: T[], size = 100): T[][] {
  const batches: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }

  return batches;
}

async function resolveContext(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const secret = process.env.SUPABASE_SECRET_KEY;

  if (!url || !anon || !secret) {
    return {
      response: failure(
        "Database configuration unavailable.",
        503
      ),
    };
  }

  const marketKey =
    request.nextUrl.searchParams.get("market") ?? "";

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(marketKey)) {
    return {
      response: failure("Invalid Market.", 400),
    };
  }

  const authorization =
    request.headers.get("authorization") ?? "";

  if (!authorization.startsWith("Bearer ")) {
    return {
      response: failure(
        "Administrator sign-in required.",
        401
      ),
    };
  }

  const token = authorization.slice(7);

  if (!token) {
    return {
      response: failure("Invalid session.", 401),
    };
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

  const { data: identity, error: identityError } =
    await userClient.auth.getUser(token);

  if (identityError || !identity.user) {
    return {
      response: failure("Invalid session.", 401),
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
      response: failure(
        "Administrator access required.",
        403
      ),
    };
  }

  const { data: market, error: marketError } = await db
    .from("event_processing_markets")
    .select("id,market_key,display_name")
    .eq("market_key", marketKey)
    .maybeSingle();

  if (marketError || !market) {
    return {
      response: failure("Market not found.", 404),
    };
  }

  const allowed = new Set<string>();

  // Read every assigned Spot, including Markets with
  // more than the default Supabase row limit.
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db
      .from("event_processing_market_venues")
      .select("venue_id")
      .eq("market_id", market.id)
      .order("venue_id")
      .range(offset, offset + 999);

    if (error) throw error;

    for (const row of data ?? []) {
      allowed.add(row.venue_id);
    }

    if ((data ?? []).length < 1000) break;
  }

  return {
    context: {
      db,
      userClient,
      market,
      allowed,
    } as MarketContext,
  };
}

async function loadScopedQueue(context: MarketContext) {
  const { db, userClient, allowed } = context;

  const [
    claimResult,
    affiliationResult,
    eventResult,
  ] = await Promise.all([
    userClient.rpc("admin_pending_claim_details"),
    userClient.rpc("admin_pending_bartender_venue_requests"),
    userClient.rpc("admin_pending_events"),
  ]);

  if (claimResult.error) {
    throw new Error(claimResult.error.message);
  }

  if (affiliationResult.error) {
    throw new Error(affiliationResult.error.message);
  }

  if (eventResult.error) {
    throw new Error(eventResult.error.message);
  }

  const allClaims = (claimResult.data ?? []) as Claim[];
  const affiliations =
    (affiliationResult.data ?? []) as VenueRequest[];
  const events = (eventResult.data ?? []) as EventRequest[];

  /*
   * The existing claims RPC returns the verification
   * Spot name, not its ID.
   *
   * Read the actual verification Spot ID before deciding
   * which Market owns a claim.
   */
  const verifyingSpots = new Map<string, string | null>();

  for (const batch of chunks(allClaims.map(c => c.id))) {
    const { data, error } = await db
      .from("entity_claims")
      .select("id,verifying_venue_id")
      .in("id", batch);

    if (error) throw error;

    for (const row of (data ?? []) as Array<{
      id: string;
      verifying_venue_id: string | null;
    }>) {
      verifyingSpots.set(row.id, row.verifying_venue_id);
    }
  }

  /*
   * Existing Tender claims without an explicitly selected
   * verification Spot may have current relationships with
   * multiple Spots.
   *
   * Use verified relationship records, never inferred
   * location or Tender name.
   */
  const tenderIds = [
    ...new Set(
      allClaims
        .filter(claim =>
          claim.entity_kind === "bartender" &&
          claim.bartender_id &&
          !claim.requested_venue_id &&
          !verifyingSpots.get(claim.id)
        )
        .map(claim => claim.bartender_id as string)
    ),
  ];

  const tenderSpots = new Map<string, Set<string>>();

  for (const batch of chunks(tenderIds)) {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db
        .from("bartender_venues")
        .select("bartender_id,venue_id")
        .in("bartender_id", batch)
        .eq("is_current", true)
        .order("bartender_id")
        .order("venue_id")
        .range(offset, offset + 999);

      if (error) throw error;

      for (const relationship of (data ?? []) as Array<{
        bartender_id: string;
        venue_id: string;
      }>) {
        const spots =
          tenderSpots.get(relationship.bartender_id) ??
          new Set<string>();

        spots.add(relationship.venue_id);
        tenderSpots.set(relationship.bartender_id, spots);
      }

      if ((data ?? []).length < 1000) break;
    }
  }

  const claims = allClaims.filter(claim => {
    if (claim.entity_kind === "venue") {
      return Boolean(
        claim.venue_id &&
        allowed.has(claim.venue_id)
      );
    }

    if (claim.entity_kind !== "bartender") {
      return false;
    }

    // A new Tender is verified at the requested Spot.
    if (claim.requested_venue_id) {
      return allowed.has(claim.requested_venue_id);
    }

    // Explicit verification Spot takes precedence.
    const verifying = verifyingSpots.get(claim.id);

    if (verifying) {
      return allowed.has(verifying);
    }

    if (!claim.bartender_id) {
      return false;
    }

    // Existing Tender associated with this Market.
    const spots = tenderSpots.get(claim.bartender_id);

    return spots
      ? [...spots].some(id => allowed.has(id))
      : false;
  });

  return {
    market: context.market,
    claims,
    spotRequests: affiliations.filter(
      request => allowed.has(request.venue_id)
    ),
    eventRequests: events.filter(
      event => allowed.has(event.venue_id)
    ),
  };
}

export async function GET(request: NextRequest) {
  try {
    const resolved = await resolveContext(request);

    if (resolved.response) return resolved.response;

    const queue = await loadScopedQueue(
      resolved.context!
    );

    return NextResponse.json(queue, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error(
      "Market Verification Requests load failed:",
      error
    );

    return failure(
      "Could not load Market Verification Requests.",
      500
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const resolved = await resolveContext(request);

    if (resolved.response) return resolved.response;

    let body: {
      kind?: string;
      id?: string;
      approve?: boolean;
    };

    try {
      body = await request.json();
    } catch {
      return failure("Invalid request.", 400);
    }

    const kind = body?.kind;
    const id = body?.id;
    const approve = body?.approve;

    if (
      !["claim", "spot_request", "event"].includes(
        kind ?? ""
      ) ||
      typeof id !== "string" ||
      !uuid.test(id) ||
      typeof approve !== "boolean"
    ) {
      return failure(
        "Invalid verification operation.",
        400
      );
    }

    /*
     * Rebuild Market membership and pending requests
     * on every mutation. Never trust the browser's
     * displayed request ID as authorization.
     */
    const queue = await loadScopedQueue(
      resolved.context!
    );

    const candidates =
      kind === "claim"
        ? queue.claims
        : kind === "spot_request"
          ? queue.spotRequests
          : queue.eventRequests;

    if (!candidates.some(item => item.id === id)) {
      return failure(
        "Request does not belong to this Market " +
        "or is no longer pending.",
        403
      );
    }

    const operation =
      kind === "claim"
        ? "admin_review_claim"
        : kind === "spot_request"
          ? "review_bartender_venue_request"
          : "admin_review_event";

    const args =
      kind === "claim"
        ? { p_claim_id: id, p_approve: approve }
        : kind === "spot_request"
          ? { p_request_id: id, p_approve: approve }
          : { p_event_id: id, p_approve: approve };

    /*
     * Preserve the existing Admin RPC and the original
     * authenticated user identity.
     */
    const { error } =
      await resolved.context!.userClient.rpc(
        operation as never,
        args as never
      );

    if (error) {
      return failure(error.message, 409);
    }

    return NextResponse.json(
      { success: true },
      {
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (error) {
    console.error(
      "Market Verification Requests review failed:",
      error
    );

    return failure(
      "Could not review Market verification request.",
      500
    );
  }
}
