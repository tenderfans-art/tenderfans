import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

import {
  createCodeHash,
  createPhoneHash,
  normalizeContestPhone,
} from "@/lib/contestVerification";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const phone = normalizeContestPhone(
      body.phone
    );

    if (!phone) {
      return NextResponse.json(
        {
          error:
            "Enter a valid mobile phone number.",
        },
        { status: 400 }
      );
    }

    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL;

    const supabaseSecret =
      process.env.SUPABASE_SECRET_KEY;

    const provider =
      process.env.CONTEST_VERIFICATION_PROVIDER;

    if (
      !supabaseUrl ||
      !supabaseSecret ||
      !provider
    ) {
      return NextResponse.json(
        {
          error:
            "Contest verification is not configured.",
        },
        { status: 500 }
      );
    }

    if (
      provider !== "development" &&
      provider !== "twilio"
    ) {
      return NextResponse.json(
        {
          error:
            "Invalid contest verification provider.",
        },
        { status: 500 }
      );
    }

    /*
     * Until Twilio is connected, development mode is
     * intentionally restricted to explicitly allowed phones.
     */
    if (provider === "development") {
      const allowedPhones = (
        process.env.CONTEST_DEV_TEST_PHONES ?? ""
      )
        .split(",")
        .map((value) =>
          normalizeContestPhone(value)
        )
        .filter(
          (value): value is string =>
            Boolean(value)
        );

      if (!allowedPhones.includes(phone)) {
        return NextResponse.json(
          {
            error:
              "That phone number is not authorized for development verification.",
          },
          { status: 403 }
        );
      }
    }

    if (provider === "twilio") {
      return NextResponse.json(
        {
          error:
            "Twilio contest verification is not connected yet.",
        },
        { status: 501 }
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

    const phoneHash = createPhoneHash(phone);

    /*
     * Development/provider-independent protection:
     * max 5 challenge requests for one phone in 15 minutes.
     */
    const fifteenMinutesAgo =
      new Date(
        Date.now() - 15 * 60 * 1000
      ).toISOString();

    const { count, error: countError } =
      await adminSupabase
        .from("contest_phone_challenges")
        .select("id", {
          count: "exact",
          head: true,
        })
        .eq("phone_hash", phoneHash)
        .gte("created_at", fifteenMinutesAgo);

    if (countError) {
      console.error(
        "Contest challenge rate check failed:",
        countError
      );

      return NextResponse.json(
        {
          error:
            "Contest verification is temporarily unavailable.",
        },
        { status: 500 }
      );
    }

    if ((count ?? 0) >= 5) {
      return NextResponse.json(
        {
          error:
            "Too many verification requests. Please try again later.",
        },
        {
          status: 429,
          headers: {
            "Retry-After": "900",
          },
        }
      );
    }

    const challengeId =
      crypto.randomUUID();

    const code = String(
      crypto.randomInt(0, 1000000)
    ).padStart(6, "0");

    const codeHash = createCodeHash(
      challengeId,
      code
    );

    const expiresAt =
      new Date(
        Date.now() + 10 * 60 * 1000
      ).toISOString();

    const { error: insertError } =
      await adminSupabase
        .from("contest_phone_challenges")
        .insert({
          id: challengeId,
          phone_hash: phoneHash,
          provider: "development",
          provider_reference: null,
          code_hash: codeHash,
          status: "pending",
          attempt_count: 0,
          resend_count: 0,
          expires_at: expiresAt,
        });

    if (insertError) {
      console.error(
        "Contest challenge creation failed:",
        insertError
      );

      return NextResponse.json(
        {
          error:
            "Could not start phone verification.",
        },
        { status: 500 }
      );
    }

    /*
     * Development only:
     * return the generated OTP so we can exercise the
     * complete UI before Twilio is connected.
     *
     * This endpoint only permits allowlisted test phones.
     */
    return NextResponse.json({
      ok: true,
      challengeId,
      expiresInSeconds: 600,
      developmentCode: code,
    });
  } catch (error) {
    console.error(
      "Contest verification send error:",
      error
    );

    return NextResponse.json(
      {
        error:
          "Could not start phone verification.",
      },
      { status: 500 }
    );
  }
}
