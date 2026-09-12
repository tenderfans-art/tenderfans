import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import twilio from "twilio";

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

    const contestTermsAccepted =
      body.contestTermsAccepted === true;

    const marketingOptIn =
      body.marketingOptIn === true;

    if (!phone) {
      return NextResponse.json(
        {
          error:
            "Enter a valid mobile phone number.",
        },
        { status: 400 }
      );
    }

    if (!contestTermsAccepted) {
      return NextResponse.json(
        {
          error:
            "Please confirm the contest verification notice before continuing.",
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

    let code: string | null = null;
    let codeHash: string | null = null;
    let providerReference: string | null = null;

    if (provider === "development") {
      code = String(
        crypto.randomInt(0, 1000000)
      ).padStart(6, "0");

      codeHash = createCodeHash(
        challengeId,
        code
      );
    } else {
      const accountSid =
        process.env.TWILIO_ACCOUNT_SID;
      const authToken =
        process.env.TWILIO_AUTH_TOKEN;
      const verifyServiceSid =
        process.env.TWILIO_VERIFY_SERVICE_SID;

      if (
        !accountSid ||
        !authToken ||
        !verifyServiceSid
      ) {
        return NextResponse.json(
          {
            error:
              "Twilio verification is not configured.",
          },
          { status: 500 }
        );
      }

      const client = twilio(
        accountSid,
        authToken
      );

      const verification =
        await client.verify.v2
          .services(verifyServiceSid)
          .verifications.create({
            to: phone,
            channel: "sms",
          });

      providerReference =
        verification.sid;
    }

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
          provider,
          provider_reference: providerReference,
          code_hash: codeHash,
          status: "pending",
          attempt_count: 0,
          resend_count: 0,
          expires_at: expiresAt,

          contest_terms_accepted_at:
            new Date().toISOString(),
          contest_terms_version:
            "contest-verification-v1",

          marketing_opt_in:
            marketingOptIn,
          marketing_consent_at:
            marketingOptIn
              ? new Date().toISOString()
              : null,
          marketing_consent_version:
            marketingOptIn
              ? "sms-marketing-v1"
              : null,
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

    if (provider === "development") {
      return NextResponse.json({
        ok: true,
        challengeId,
        expiresInSeconds: 600,
        developmentCode: code,
      });
    }

    return NextResponse.json({
      ok: true,
      challengeId,
      expiresInSeconds: 600,
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
