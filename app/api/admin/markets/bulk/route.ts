import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  searchGoogleVenue,
  recordGoogleSpotDiscovery,
  registerHarvestGoogleSpot,
} from "@/lib/event-harvester/google-places";
import { venueIdentityMatch } from "@/lib/event-harvester/venue-identity";

export const maxDuration = 60;

type ImportRow = {
  line: number;
  name: string;
  address: string;
};

type Result = {
  line: number;
  name: string;
  status: string;
  detail: string;
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let afterQuote = false;

  const input = text.replace(/^\\uFEFF/, "").replace(/\\r\\n?/g, "\\n");

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
        afterQuote = true;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === ",") {
      row.push(cell.trim());
      cell = "";
      afterQuote = false;
    } else if (ch === "\\n") {
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
      afterQuote = false;
    } else if (afterQuote && ch.trim() !== "") {
      throw new Error("Invalid characters after a quoted CSV field.");
    } else if (ch === '"' && !cell.trim()) {
      quoted = true;
    } else if (ch === '"') {
      throw new Error("Unexpected quotation mark in CSV.");
    } else if (!afterQuote) {
      cell += ch;
    }
  }

  if (quoted) throw new Error("Unclosed CSV quotation mark.");

  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);

  return rows;
}

function readRows(csv: string): ImportRow[] {
  const parsed = parseCsv(csv);
  const headers = (parsed.shift() ?? []).map((value) =>
    value.toLowerCase().trim()
  );

  const nameColumn = headers.indexOf("name");
  const addressColumn = headers.indexOf("address");

  if (nameColumn < 0 || addressColumn < 0) {
    throw new Error("CSV requires name and address columns.");
  }

  if (parsed.length < 1 || parsed.length > 1000) {
    throw new Error("CSV must contain 1–1000 Spot rows.");
  }

  return parsed.map((cells, index) => ({
    line: index + 2,
    name: cells[nameColumn] ?? "",
    address: cells[addressColumn] ?? "",
  }));
}

function parseAddress(value: string) {
  const match = value.match(
    /^(.+?),\\s*([^,]+),\\s*([A-Za-z]{2})\\s+(\\d{5})(?:-\\d{4})?$/
  );

  if (!match) return null;

  return {
    streetAddress: match[1].trim(),
    city: match[2].trim(),
    stateRegion: match[3].toUpperCase(),
    postalCode: match[4],
  };
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

  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  if (!token) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 }
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
      { error: "Admin access required." },
      { status: 403 }
    );
  }

  let marketId: string;
  let rows: ImportRow[];
  let offset: number;

  try {
    const body = await request.json();
    marketId = body.marketId;
    offset = body.offset;

    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 999
    ) {
      throw new Error("Invalid import offset.");
    }

    if (
      typeof marketId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(marketId) ||
      typeof body.csv !== "string" ||
      body.csv.length > 250000
    ) {
      throw new Error("Invalid market or CSV payload.");
    }

    rows = readRows(body.csv);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error
          ? error.message
          : "Invalid CSV.",
      },
      { status: 400 }
    );
  }

  const { data: market, error: marketError } = await db
    .from("event_processing_markets")
    .select("id")
    .eq("id", marketId)
    .maybeSingle();

  if (marketError || !market) {
    return NextResponse.json(
      { error: "Market not found." },
      { status: 404 }
    );
  }

  const results: Result[] = [];
  const seen = new Set<string>();

  for (const row of rows.slice(offset, offset + 5)) {
    const report = (status: string, detail: string) => {
      results.push({
        line: row.line,
        name: row.name,
        status,
        detail,
      });
    };

    if (!row.name.trim() || !row.address.trim()) {
      report("invalid", "Spot name and address are required.");
      continue;
    }

    const address = parseAddress(row.address);

    if (!address) {
      report(
        "invalid",
        "Expected address: street, city, ST ZIP."
      );
      continue;
    }

    const fingerprint = `${row.name}|${row.address}`
      .toLowerCase()
      .replace(/\\s+/g, " ")
      .trim();

    if (seen.has(fingerprint)) {
      report("duplicate_row", "Duplicate CSV entry.");
      continue;
    }

    seen.add(fingerprint);

    try {
      const identity = {
        name: row.name.trim(),
        ...address,
      };

      const candidate = await searchGoogleVenue(
        identity,
        { allowReviewCandidate: true }
      );

      if (!candidate) {
        report("no_match", "No credible Google Places match.");
        continue;
      }

      const match = venueIdentityMatch({
        spot: identity,
        candidate: candidate.place,
      });

      const nameAgrees =
        match.evidence.nameExact ||
        (
          match.evidence.nameSimilarity >= 0.75 &&
          match.evidence.addressExact
        );

      const qualified =
        candidate.evidence.googleQualified === true &&
        nameAgrees &&
        match.evidence.addressExact &&
        match.evidence.cityExact &&
        match.evidence.stateExact &&
        match.evidence.postalExact;

      const discovery = {
        ...candidate,
        evidence: {
          ...candidate.evidence,
          reviewOnly: !qualified,
          marketBulkOnboarding: true,
          importedName: row.name,
          importedAddress: row.address,
          csvIdentityScore: match.score,
        },
      };

      const status = await recordGoogleSpotDiscovery(db, discovery);

      if (status === "rejected") {
        report(
          "rejected",
          "Existing Google Spot rejection preserved."
        );
        continue;
      }

      // Persist the market request BEFORE approval.
      // The existing approval trigger then assigns membership
      // in the same database transaction.
      const { data: requested, error: requestError } =
        await db.rpc("request_google_spot_market", {
          p_place_id: candidate.place.id,
          p_market_id: marketId,
        });

      if (requestError) {
        report("conflict", requestError.message);
        continue;
      }

      if (requested === "assigned") {
        report(
          "assigned",
          `Existing approved Spot: ${candidate.place.name}`
        );
        continue;
      }

      if (!qualified || status === "pending" && !qualified) {
        report(
          "pending_review",
          `${candidate.place.name} — ${candidate.place.formattedAddress}`
        );
        continue;
      }

      // The existing registration RPC checks durable review
      // decisions, including pending reviewOnly and rejection.
      // It must never be bypassed with a direct venue upsert.
      const venueId = await registerHarvestGoogleSpot(db, discovery);

      if (!venueId) {
        report(
          "pending_review",
          "Existing review decision requires Admin approval."
        );
        continue;
      }

      report(
        "assigned",
        `${candidate.place.name} — ${candidate.place.formattedAddress}`
      );
    } catch (error) {
      report(
        "error",
        error instanceof Error ? error.message : "Import failed."
      );
    }
  }

  return NextResponse.json({
    results,
    nextOffset: Math.min(offset + 5, rows.length),
    total: rows.length,
  });
}
