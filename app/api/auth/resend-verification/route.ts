import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const COOLDOWN_MS = 5 * 60 * 1000;
const MAX_RESENDS = 3;

function normalizeEmail(value: unknown) {
  if (typeof value !== "string") return null;

  const email = value.trim().toLowerCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return null;
  }

  return email;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const email = normalizeEmail(body.email);
    const action = body.action === "start" ? "start" : "resend";

    if (!email) {
      return NextResponse.json(
        { error: "Enter a valid email address." },
        { status: 400 }
      );
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseSecret = process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseSecret) {
      console.error("Server Supabase credentials are not configured.");

      return NextResponse.json(
        { error: "Email verification is temporarily unavailable." },
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

    const { data: existing, error: lookupError } = await adminSupabase
      .from("auth_verification_resends")
      .select("resend_count, last_sent_at")
      .eq("email", email)
      .maybeSingle();

    if (lookupError) {
      console.error("Verification resend lookup failed:", lookupError);

      return NextResponse.json(
        { error: "Could not process the verification request." },
        { status: 500 }
      );
    }

    const resendCount = existing?.resend_count ?? 0;

    /*
     * "start" is called when somebody tries to sign in before verifying.
     * It starts the initial five-minute cooldown WITHOUT sending another email.
     */
    if (action === "start") {
      if (resendCount >= MAX_RESENDS) {
        return NextResponse.json({
          locked: true,
          resendCount,
          remaining: 0,
          retryAfterSeconds: 0,
        });
      }

      if (existing?.last_sent_at) {
        const elapsed =
          Date.now() - new Date(existing.last_sent_at).getTime();

        if (elapsed < COOLDOWN_MS) {
          return NextResponse.json({
            locked: false,
            resendCount,
            remaining: MAX_RESENDS - resendCount,
            retryAfterSeconds: Math.ceil(
              (COOLDOWN_MS - elapsed) / 1000
            ),
          });
        }

        return NextResponse.json({
          locked: false,
          resendCount,
          remaining: MAX_RESENDS - resendCount,
          retryAfterSeconds: 0,
        });
      }

      const now = new Date().toISOString();

      const { error: startError } = await adminSupabase
        .from("auth_verification_resends")
        .insert({
          email,
          resend_count: 0,
          last_sent_at: now,
          updated_at: now,
        });

      if (startError) {
        console.error(
          "Verification cooldown initialization failed:",
          startError
        );

        return NextResponse.json(
          { error: "Could not initialize email verification." },
          { status: 500 }
        );
      }

      return NextResponse.json({
        locked: false,
        resendCount: 0,
        remaining: MAX_RESENDS,
        retryAfterSeconds: 300,
      });
    }

    if (resendCount >= MAX_RESENDS) {
      return NextResponse.json(
        {
          error:
            "You've reached the verification email limit. Please contact TenderFans support for help.",
          locked: true,
          resendCount,
          remaining: 0,
        },
        { status: 429 }
      );
    }

    if (existing?.last_sent_at) {
      const elapsed =
        Date.now() - new Date(existing.last_sent_at).getTime();

      if (elapsed < COOLDOWN_MS) {
        const retryAfterSeconds = Math.ceil(
          (COOLDOWN_MS - elapsed) / 1000
        );

        return NextResponse.json(
          {
            error:
              "Your verification email was recently sent. Please check your inbox before requesting another.",
            locked: false,
            resendCount,
            remaining: MAX_RESENDS - resendCount,
            retryAfterSeconds,
          },
          {
            status: 429,
            headers: {
              "Retry-After": String(retryAfterSeconds),
            },
          }
        );
      }
    }

    const redirectBase =
      request.headers.get("origin") ||
      process.env.NEXT_PUBLIC_SITE_URL ||
      "https://tenderfans.com";

    const { error: resendError } =
      await adminSupabase.auth.resend({
        type: "signup",
        email,
        options: {
          emailRedirectTo: `${redirectBase}/auth/confirmed`,
        },
      });

    if (resendError) {
      console.error("Supabase verification resend failed:", resendError);

      return NextResponse.json(
        {
          error:
            "We couldn't send another verification email right now. Please try again later.",
        },
        { status: 500 }
      );
    }

    const now = new Date().toISOString();
    const newCount = resendCount + 1;

    const { error: saveError } = await adminSupabase
      .from("auth_verification_resends")
      .upsert(
        {
          email,
          resend_count: newCount,
          last_sent_at: now,
          updated_at: now,
        },
        {
          onConflict: "email",
        }
      );

    if (saveError) {
      console.error(
        "Verification resend tracking update failed:",
        saveError
      );
    }

    return NextResponse.json({
      success: true,
      locked: newCount >= MAX_RESENDS,
      resendCount: newCount,
      remaining: MAX_RESENDS - newCount,
      retryAfterSeconds: 300,
    });
  } catch (error) {
    console.error("Verification resend request failed:", error);

    return NextResponse.json(
      { error: "Could not process the verification request." },
      { status: 500 }
    );
  }
}
