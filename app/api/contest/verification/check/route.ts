import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";

import {
  createCodeHash,
  createPhoneHash,
  createVerificationToken,
  getContestVerificationCookieMaxAge,
  getContestVerificationCookieName,
  normalizeContestPhone,
  timingSafeMatch,
} from "@/lib/contestVerification";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const phone =
      normalizeContestPhone(body.phone);

    const challengeId =
      typeof body.challengeId === "string"
        ? body.challengeId.trim()
        : "";

    const code =
      typeof body.code === "string"
        ? body.code.trim()
        : "";

    if (
      !phone ||
      !challengeId ||
      !/^\d{6}$/.test(code)
    ) {
      return NextResponse.json(
        {
          error:
            "Enter the 6-digit verification code.",
        },
        { status: 400 }
      );
    }

    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL;

    const supabaseSecret =
      process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseSecret) {
      return NextResponse.json(
        {
          error:
            "Contest verification is not configured.",
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

    const phoneHash =
      createPhoneHash(phone);

    const {
      data: challenge,
      error: challengeError,
    } = await adminSupabase
      .from("contest_phone_challenges")
      .select(`
        id,
        phone_hash,
        provider,
        code_hash,
        status,
        attempt_count,
        expires_at,
        contest_terms_accepted_at,
        contest_terms_version,
        marketing_opt_in,
        marketing_consent_at,
        marketing_consent_version
      `)
      .eq("id", challengeId)
      .maybeSingle();

    if (
      challengeError ||
      !challenge ||
      challenge.phone_hash !== phoneHash
    ) {
      return NextResponse.json(
        {
          error:
            "That verification request is not valid.",
        },
        { status: 400 }
      );
    }

    if (!challenge.contest_terms_accepted_at) {
      return NextResponse.json(
        {
          error:
            "Contest verification acknowledgment is required.",
        },
        { status: 400 }
      );
    }

    if (challenge.status !== "pending") {
      return NextResponse.json(
        {
          error:
            "That verification request is no longer active.",
        },
        { status: 400 }
      );
    }

    if (
      new Date(challenge.expires_at).getTime() <
      Date.now()
    ) {
      await adminSupabase
        .from("contest_phone_challenges")
        .update({
          status: "expired",
        })
        .eq("id", challengeId);

      return NextResponse.json(
        {
          error:
            "That verification code has expired.",
        },
        { status: 400 }
      );
    }

    if (challenge.attempt_count >= 5) {
      await adminSupabase
        .from("contest_phone_challenges")
        .update({
          status: "failed",
        })
        .eq("id", challengeId);

      return NextResponse.json(
        {
          error:
            "Too many incorrect attempts. Request a new code.",
        },
        { status: 429 }
      );
    }

    let codeApproved = false;

    if (challenge.provider === "development") {
      if (!challenge.code_hash) {
        return NextResponse.json(
          {
            error:
              "Verification code is unavailable.",
          },
          { status: 500 }
        );
      }

      const suppliedHash =
        createCodeHash(
          challengeId,
          code
        );

      codeApproved = timingSafeMatch(
        suppliedHash,
        challenge.code_hash
      );
    } else if (challenge.provider === "twilio") {
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

      const verificationCheck =
        await client.verify.v2
          .services(verifyServiceSid)
          .verificationChecks.create({
            to: phone,
            code,
          });

      codeApproved =
        verificationCheck.status === "approved";
    } else {
      return NextResponse.json(
        {
          error:
            "This verification provider is not available.",
        },
        { status: 501 }
      );
    }

    if (!codeApproved) {
      const nextAttempts =
        challenge.attempt_count + 1;

      await adminSupabase
        .from("contest_phone_challenges")
        .update({
          attempt_count: nextAttempts,
          status:
            nextAttempts >= 5
              ? "failed"
              : "pending",
        })
        .eq("id", challengeId);

      return NextResponse.json(
        {
          error:
            nextAttempts >= 5
              ? "Too many incorrect attempts. Request a new code."
              : "That verification code is incorrect.",
        },
        {
          status:
            nextAttempts >= 5
              ? 429
              : 400,
        }
      );
    }

    const verifiedAt =
      new Date().toISOString();

    let identityId = "";

    const { data: existingIdentity } =
      await adminSupabase
        .from("contest_phone_identities")
        .select("id")
        .eq("phone_hash", phoneHash)
        .maybeSingle();

    if (existingIdentity) {
      identityId =
        existingIdentity.id;

      const { error: identityUpdateError } =
        await adminSupabase
          .from("contest_phone_identities")
          .update({
            last_verified_at: verifiedAt,
          })
          .eq("id", identityId);

      if (identityUpdateError) {
        throw identityUpdateError;
      }
    } else {
      const {
        data: createdIdentity,
        error: identityInsertError,
      } = await adminSupabase
        .from("contest_phone_identities")
        .insert({
          phone_hash: phoneHash,
          first_verified_at: verifiedAt,
          last_verified_at: verifiedAt,
        })
        .select("id")
        .single();

      if (
        identityInsertError ||
        !createdIdentity
      ) {
        throw (
          identityInsertError ??
          new Error(
            "Could not create verified phone identity."
          )
        );
      }

      identityId =
        createdIdentity.id;
    }

    const { error: verifyError } =
      await adminSupabase
        .from("contest_phone_challenges")
        .update({
          status: "verified",
          verified_at: verifiedAt,
        })
        .eq("id", challengeId);

    if (verifyError) {
      throw verifyError;
    }

    /*
     * Store the RAW phone number only after:
     *   1. explicit optional marketing consent, and
     *   2. successful phone verification.
     *
     * Contest anti-cheat identity remains hashed separately.
     */
    if (challenge.marketing_opt_in === true) {
      const consentedAt =
        challenge.marketing_consent_at ||
        verifiedAt;

      const { error: marketingError } =
        await adminSupabase
          .from("marketing_sms_subscribers")
          .upsert(
            {
              phone_e164: phone,
              status: "active",
              consented_at: consentedAt,
              consent_source:
                "contest_verification",
              consent_version:
                challenge.marketing_consent_version ||
                "sms-marketing-v1",
              verified_at: verifiedAt,
              updated_at: verifiedAt,
            },
            {
              onConflict: "phone_e164",
            }
          );

      if (marketingError) {
        console.error(
          "SMS marketing consent storage failed:",
          marketingError
        );

        /*
         * Verification itself still succeeded.
         * Marketing storage failure must never invalidate
         * someone's contest participation.
         */
      }
    }

    const token =
      createVerificationToken(
        identityId,
        phoneHash
      );

    const response =
      NextResponse.json({
        ok: true,
        verified: true,
      });

    response.cookies.set(
      getContestVerificationCookieName(),
      token,
      {
        httpOnly: true,
        sameSite: "lax",
        secure:
          process.env.NODE_ENV ===
          "production",
        path: "/",
        maxAge:
          getContestVerificationCookieMaxAge(),
      }
    );

    return response;
  } catch (error) {
    console.error(
      "Contest verification check error:",
      error
    );

    return NextResponse.json(
      {
        error:
          "Could not verify that phone number.",
      },
      { status: 500 }
    );
  }
}
