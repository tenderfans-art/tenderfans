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

    const voiceName =
      typeof body.voiceName === "string"
        ? body.voiceName.trim()
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
      !voiceName ||
      traits.length < 1 ||
      traits.length > 5
    ) {
      return NextResponse.json(
        {
          error:
            "Complete your Tender selection, Shout style and badges.",
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
     * Contest identity is resolved server-side.
     * The browser cannot choose which contest receives
     * the Shout.
     */
    const now = new Date().toISOString();

    const {
      data: contest,
      error: contestError,
    } = await adminSupabase
      .from("contests")
      .select("id, ends_at")
      .eq("is_active", true)
      .lte("starts_at", now)
      .gte("ends_at", now)
      .maybeSingle();

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
          error:
            "There is no active TenderFans contest right now.",
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
          p_voice_name: voiceName,
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
