import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Explicitly authorized HM read functions.
const reads = new Set([
  "admin_event_harvest_adapter_error_findings",
  "admin_event_harvest_adapter_error_tier_one_sources",
  "admin_list_harvest_archive",
  "admin_event_harvest_browser_required_findings",
  "admin_event_harvest_calendar_image_findings",
  "admin_event_harvest_challenge_findings",
  "admin_event_harvest_facebook_findings",
  "admin_event_harvest_html_error_findings",
  "admin_event_harvest_no_source_findings",
  "admin_event_harvest_no_source_facebook_markers",
  "admin_event_harvest_transport_findings",
  "admin_event_harvest_source_ownership_findings",
  "admin_pending_event_harvest_venue_matches",
  "admin_list_google_spot_reviews",
  "admin_list_spots",
  "admin_pending_event_harvest_unresolved_venues",
  "admin_list_calendar_event_verifications",
  "admin_list_event_occurrence_reviews",
]);

type WriteRule = {
  arg: string;
  table?: string;
  field?: "venue_id" | "source_id";
  kind?: "google" | "venue";
};

// All mutations have a verified owner before the existing
// Admin RPC executes with the original authenticated identity.
const writes: Record<string, WriteRule> = {
  admin_review_google_spot: {
    arg: "p_place_id",
    kind: "google",
  },
  admin_review_event_harvest_venue_match: {
    arg: "p_match_id",
    table: "event_harvest_venue_matches",
    field: "venue_id",
  },
  admin_review_calendar_image_source: {
    arg: "p_finding_id",
    table: "event_harvest_detector_findings",
    field: "venue_id",
  },
  admin_review_html_source_ownership: {
    arg: "p_finding_id",
    table: "event_harvest_detector_findings",
    field: "venue_id",
  },
  admin_resolve_event_harvest_adapter_error: {
    arg: "p_finding_id",
    table: "event_harvest_detector_findings",
    field: "venue_id",
  },
  admin_restore_harvest_spot: {
    arg: "p_venue_id",
    kind: "venue",
  },
  admin_archive_harvest_spot: {
    arg: "p_venue_id",
    kind: "venue",
  },
  admin_remove_spot: {
    arg: "p_venue_id",
    kind: "venue",
  },
  admin_review_event_harvest_unresolved_venue: {
    arg: "p_unresolved_id",
    table: "event_harvest_unresolved_venues",
    field: "source_id",
  },
  admin_review_calendar_event_verification: {
    arg: "p_candidate_id",
    table: "event_harvest_candidates",
    field: "source_id",
  },
  admin_review_event_occurrence: {
    arg: "p_candidate_id",
    table: "event_harvest_candidates",
    field: "source_id",
  },
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const secret = process.env.SUPABASE_SECRET_KEY;

  if (!url || !anon || !secret) {
    return NextResponse.json(
      { error: "Database configuration unavailable." },
      { status: 503 }
    );
  }

  const key = request.nextUrl.searchParams.get("market") ?? "";

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)) {
    return NextResponse.json(
      { error: "Invalid Market." },
      { status: 400 }
    );
  }

  const authorization =
    request.headers.get("authorization") ?? "";

  if (!authorization.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 }
    );
  }

  const token = authorization.slice(7);

  let body: { name?: string; args?: Record<string, unknown> };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request." },
      { status: 400 }
    );
  }

  const name = body.name ?? "";
  const args = body.args ?? {};
  const rule = writes[name];

  if (!reads.has(name) && !rule) {
    return NextResponse.json(
      { error: "Unsupported Harvester operation." },
      { status: 400 }
    );
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
    return NextResponse.json(
      { error: "Invalid session." },
      { status: 401 }
    );
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
    return NextResponse.json(
      { error: "Administrator access required." },
      { status: 403 }
    );
  }

  const { data: market, error: marketError } = await db
    .from("event_processing_markets")
    .select("id")
    .eq("market_key", key)
    .maybeSingle();

  if (marketError || !market) {
    return NextResponse.json(
      { error: "Market not found." },
      { status: 404 }
    );
  }

  // Page through memberships; never silently truncate a Market.
  const allowed = new Set<string>();

  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db
      .from("event_processing_market_venues")
      .select("venue_id")
      .eq("market_id", market.id)
      .order("venue_id")
      .range(offset, offset + 999);

    if (error) {
      return NextResponse.json(
        { error: "Could not resolve Market membership." },
        { status: 503 }
      );
    }

    for (const item of data ?? []) allowed.add(item.venue_id);
    if ((data ?? []).length < 1000) break;
  }

  async function sourceBelongs(sourceId: string) {
    const { data, error } = await db
      .from("event_harvest_sources")
      .select("venue_id")
      .eq("id", sourceId)
      .maybeSingle();

    if (error) throw error;

    return !!data?.venue_id && allowed.has(data.venue_id);
  }

  // Mutations are denied unless the source record and any
  // explicitly selected destination Spot belong to this Market.
  if (rule) {
    const target = args[rule.arg];

    if (
      typeof target !== "string" ||
      !target ||
      (rule.kind !== "google" && !uuidPattern.test(target))
    ) {
      return NextResponse.json(
        { error: "Invalid Harvester record." },
        { status: 400 }
      );
    }

    let permitted = false;

    try {
      if (rule.kind === "google") {
        const { data, error } = await db
          .from("event_google_spot_market_requests")
          .select("market_id")
          .eq("place_id", target)
          .maybeSingle();

        if (error) throw error;
        permitted = data?.market_id === market.id;
      } else if (rule.kind === "venue") {
        permitted = allowed.has(target);
      } else if (rule.table && rule.field) {
        const { data, error } = await db
          .from(rule.table)
          .select(rule.field)
          .eq("id", target)
          .maybeSingle();

        if (error) throw error;

        const record = data as Record<string, unknown> | null;
        const owner = record?.[rule.field];

        permitted =
          typeof owner === "string" &&
          (rule.field === "source_id"
            ? await sourceBelongs(owner)
            : allowed.has(owner));
      }

      if (
        args.p_venue_id != null &&
        (
          typeof args.p_venue_id !== "string" ||
          !allowed.has(args.p_venue_id)
        )
      ) {
        permitted = false;
      }
    } catch {
      return NextResponse.json(
        { error: "Could not validate Market ownership." },
        { status: 503 }
      );
    }

    if (!permitted) {
      return NextResponse.json(
        { error: "Record does not belong to this Market." },
        { status: 403 }
      );
    }

    const { data, error } = await userClient.rpc(
      name as never,
      args as never
    );

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { data },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  // Existing Admin list functions execute unchanged. Their
  // results are filtered on the server, before reaching the UI.
  const { data, error } = await userClient.rpc(
    name as never,
    args as never
  );

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 503 }
    );
  }

  if (!Array.isArray(data)) {
    return NextResponse.json(
      { error: "Unexpected Harvester data." },
      { status: 503 }
    );
  }

  type Row = Record<string, any>;
  const rows = data as Row[];

  const sourceIds = [...new Set(
    rows.map(r => r.source_id)
      .filter((id): id is string => typeof id === "string")
  )];

  const sourceOwners = new Map<string, string>();

  for (let offset = 0; offset < sourceIds.length; offset += 100) {
    const { data: sources, error: sourceError } = await db
      .from("event_harvest_sources")
      .select("id, venue_id")
      .in("id", sourceIds.slice(offset, offset + 100));

    if (sourceError) {
      return NextResponse.json(
        { error: "Could not resolve source ownership." },
        { status: 503 }
      );
    }

    for (const source of sources ?? []) {
      if (source.venue_id) {
        sourceOwners.set(source.id, source.venue_id);
      }
    }
  }

  const approvedPlaces = new Set<string>();

  if (name === "admin_list_google_spot_reviews") {
    const placeIds = rows.map(r => r.place_id)
      .filter((id): id is string => typeof id === "string");

    for (let offset = 0; offset < placeIds.length; offset += 100) {
      const { data: requests, error: requestError } = await db
        .from("event_google_spot_market_requests")
        .select("place_id")
        .eq("market_id", market.id)
        .in("place_id", placeIds.slice(offset, offset + 100));

      if (requestError) {
        return NextResponse.json(
          { error: "Could not resolve pending Market reviews." },
          { status: 503 }
        );
      }

      for (const item of requests ?? []) {
        approvedPlaces.add(item.place_id);
      }
    }
  }

  const visible = rows.filter(row => {
    if (name === "admin_list_google_spot_reviews") {
      return approvedPlaces.has(row.place_id);
    }

    if (name === "admin_list_spots") {
      return allowed.has(row.id);
    }

    // A publishing source, not a physical event location,
    // determines which Market owns an event review.
    if (typeof row.source_id === "string") {
      const venueId = sourceOwners.get(row.source_id);
      return !!venueId && allowed.has(venueId);
    }

    if (typeof row.venue_id === "string") {
      return allowed.has(row.venue_id);
    }

    // Unknown record shapes never become global fallbacks.
    return false;
  });

  return NextResponse.json(
    { data: visible },
    { headers: { "Cache-Control": "no-store" } }
  );
}
