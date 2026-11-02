import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import {
  getContestVerificationCookieName,
  verifyVerificationToken,
} from "@/lib/contestVerification";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const bartenderId =
      typeof body.bartenderId === "string"
        ? body.bartenderId.trim()
        : "";

    const venueId =
      typeof body.venueId === "string"
        ? body.venueId.trim()
        : "";

    const requestedContestId =
      typeof body.contestId === "string"
        ? body.contestId.trim()
        : "";

    const traits = Array.isArray(body.traits)
      ? body.traits.filter(
          (value: unknown): value is string =>
            typeof value === "string" &&
            value.trim().length > 0
        )
      : [];

    if (
      !bartenderId ||
      !venueId ||
      traits.length < 1 ||
      traits.length > 5
    ) {
      return NextResponse.json(
        {
          error:
            "Complete your Tender selection and badges.",
        },
        { status: 400 }
      );
    }

    const cookieStore = await cookies();

    const verificationCookie =
      cookieStore.get(
        getContestVerificationCookieName()
      )?.value;

    if (!verificationCookie) {
      return NextResponse.json(
        {
          error:
            "Phone verification is required before this Shout can count.",
          needsVerification: true,
        },
        { status: 401 }
      );
    }

    const verification =
      verifyVerificationToken(
        verificationCookie
      );

    if (!verification) {
      return NextResponse.json(
        {
          error:
            "Your phone verification has expired. Please verify again.",
          needsVerification: true,
        },
        { status: 401 }
      );
    }

    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL;

    const supabaseSecret =
      process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseSecret) {
      console.error(
        "Contest server credentials are not configured."
      );

      return NextResponse.json(
        {
          error:
            "Contest Shouts are temporarily unavailable.",
        },
        { status: 500 }
      );
    }

    const adminSupabase = createClient(
      supabaseUrl,
      supabaseSecret,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      }
    );

    /*
     * Confirm the signed cookie still points to the
     * same verified phone identity stored by the server.
     */
    const {
      data: phoneIdentity,
      error: identityError,
    } = await adminSupabase
      .from("contest_phone_identities")
      .select("id, phone_hash")
      .eq("id", verification.identityId)
      .maybeSingle();

    if (
      identityError ||
      !phoneIdentity ||
      phoneIdentity.phone_hash !==
        verification.phoneHash
    ) {
      return NextResponse.json(
        {
          error:
            "Your phone verification could not be confirmed. Please verify again.",
          needsVerification: true,
        },
        { status: 401 }
      );
    }

    /*
     * A contest may be explicitly identified by the browser,
     * but only the server determines whether it is eligible.
     *
     * When no contest ID is provided, retain compatibility
     * only if exactly one contest is currently active.
     *
     * Never infer contest ownership from the selected Spot.
     */
    const now = new Date().toISOString();

    const activeContestQuery = adminSupabase
      .from("contests")
      .select("id, market_id, ends_at")
      .eq("contest_format", "shouts")
      .eq("is_active", true)
      .not("market_id", "is", null)
      .lte("starts_at", now)
      .gte("ends_at", now);

    const {
      data: contestRows,
      error: contestError,
    } = requestedContestId
      ? await activeContestQuery.eq(
          "id",
          requestedContestId
        )
      : await activeContestQuery.limit(2);

    const contest =
      !contestError &&
      contestRows?.length === 1
        ? contestRows[0]
        : null;

    if (contestError) {
      console.error(
        "Active contest lookup failed:",
        contestError
      );

      return NextResponse.json(
        {
          error:
            "Contest information is temporarily unavailable.",
        },
        { status: 500 }
      );
    }

    if (!contest) {
      return NextResponse.json(
        {
          error: requestedContestId
            ? "The selected contest is no longer active."
            : "Select an active Market contest before submitting a contest Shout.",
        },
        { status: 409 }
      );
    }

    const { data: shoutoutId, error: shoutError } =
      await adminSupabase.rpc(
        "create_contest_shoutout",
        {
          p_contest_id: contest.id,
          p_phone_identity_id:
            phoneIdentity.id,
          p_bartender_id: bartenderId,
          p_venue_id: venueId,
          p_traits: traits,
        }
      );

    if (shoutError) {
      const message =
        shoutError.message || "";

      /*
       * PostgreSQL exception from the contest RPC:
       * CONTEST_COOLDOWN:<timestamp>
       */
      if (
        message.includes(
          "CONTEST_COOLDOWN:"
        )
      ) {
        const raw =
          message.split(
            "CONTEST_COOLDOWN:"
          )[1]?.trim() || "";

        const nextEligibleAt =
          raw || null;

        return NextResponse.json(
          {
            error:
              "You already gave this Tender a contest Shout within the last 7 days.",
            cooldown: true,
            nextEligibleAt,
          },
          { status: 409 }
        );
      }

      if (
        message.includes(
          "CONTEST_NOT_ACTIVE"
        )
      ) {
        return NextResponse.json(
          {
            error:
              "This contest is no longer active.",
          },
          { status: 409 }
        );
      }

      if (
        message.includes(
          "PHONE_NOT_VERIFIED"
        )
      ) {
        return NextResponse.json(
          {
            error:
              "Your verified phone could not be confirmed. Please verify again.",
            needsVerification: true,
          },
          { status: 401 }
        );
      }

      if (
        message.includes(
          "CONTEST_MARKET_MISMATCH"
        )
      ) {
        return NextResponse.json(
          {
            error:
              "This Tender is not currently associated with a Spot in the selected contest Market.",
          },
          { status: 409 }
        );
      }

      if (
        message.includes(
          "TENDER_SPOT_MISMATCH"
        ) ||
        message.includes(
          "TENDER_NOT_AVAILABLE"
        ) ||
        message.includes(
          "SPOT_NOT_AVAILABLE"
        )
      ) {
        return NextResponse.json(
          {
            error:
              "That Tender or Spot is no longer available for this Shout.",
          },
          { status: 409 }
        );
      }

      console.error(
        "Contest Shout creation failed:",
        shoutError
      );

      return NextResponse.json(
        {
          error:
            "Could not save your contest Shout.",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      shoutoutId,
      contestId: contest.id,
    });
  } catch (error) {
    console.error(
      "Contest Shout route error:",
      error
    );

    return NextResponse.json(
      {
        error:
          "Could not save your contest Shout.",
      },
      { status: 500 }
    );
  }
}
