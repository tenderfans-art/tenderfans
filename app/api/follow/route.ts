import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import crypto from "crypto";

function normalizeEmail(value: unknown) {
  if (typeof value !== "string") return null;

  const email = value.trim().toLowerCase();

  if (!email) return null;

  const valid =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  return valid ? email : null;
}

function normalizePhone(value: unknown) {
  if (typeof value !== "string") return null;

  const raw = value.trim();

  if (!raw) return null;

  if (raw.startsWith("+")) {
    const digits = raw.slice(1).replace(/\D/g, "");

    if (digits.length >= 8 && digits.length <= 15) {
      return `+${digits}`;
    }

    return null;
  }

  const digits = raw.replace(/\D/g, "");

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  return null;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const entityKind =
      body.entityKind === "bartender" || body.entityKind === "venue"
        ? body.entityKind
        : null;

    const entityId =
      typeof body.entityId === "string"
        ? body.entityId.trim()
        : "";

    const wantsEmail = body.wantsEmail === true;
    const wantsSms = body.wantsSms === true;

    const email = normalizeEmail(body.email);
    const phone = normalizePhone(body.phone);

    const smsConsent = body.smsConsent === true;

    if (!entityKind || !entityId) {
      return NextResponse.json(
        { error: "A valid Tender or Spot is required." },
        { status: 400 }
      );
    }

    if (!wantsEmail && !wantsSms) {
      return NextResponse.json(
        { error: "Choose email, text, or both." },
        { status: 400 }
      );
    }

    if (wantsEmail && !email) {
      return NextResponse.json(
        { error: "Enter a valid email address." },
        { status: 400 }
      );
    }

    if (wantsSms && !phone) {
      return NextResponse.json(
        { error: "Enter a valid mobile number." },
        { status: 400 }
      );
    }

    if (wantsSms && !smsConsent) {
      return NextResponse.json(
        {
          error:
            "Text notifications require consent before subscribing.",
        },
        { status: 400 }
      );
    }

    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL;

    const supabaseSecret =
      process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseSecret) {
      console.error(
        "Server Supabase credentials are not configured."
      );

      return NextResponse.json(
        {
          error:
            "Notification signup is not configured.",
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

    if (entityKind === "bartender") {
      const { data: bartender } = await adminSupabase
        .from("bartenders")
        .select("id")
        .eq("id", entityId)
        .eq("status", "active")
        .maybeSingle();

      if (!bartender) {
        return NextResponse.json(
          { error: "That Tender is not available." },
          { status: 404 }
        );
      }
    }

    if (entityKind === "venue") {
      const { data: venue } = await adminSupabase
        .from("venues")
        .select("id")
        .eq("id", entityId)
        .eq("status", "active")
        .maybeSingle();

      if (!venue) {
        return NextResponse.json(
          { error: "That Spot is not available." },
          { status: 404 }
        );
      }
    }

    const now = new Date().toISOString();

    const emailVerificationToken =
      wantsEmail
        ? crypto.randomBytes(32).toString("hex")
        : null;

    const emailVerificationTokenHash =
      emailVerificationToken
        ? crypto
            .createHash("sha256")
            .update(emailVerificationToken)
            .digest("hex")
        : null;

    const { data: subscription, error } = await adminSupabase
      .from("notification_subscriptions")
      .insert({
        entity_kind: entityKind,

        bartender_id:
          entityKind === "bartender"
            ? entityId
            : null,

        venue_id:
          entityKind === "venue"
            ? entityId
            : null,

        email:
          wantsEmail
            ? email
            : null,

        phone_e164:
          wantsSms
            ? phone
            : null,

        wants_email: wantsEmail,
        wants_sms: wantsSms,

        email_verified: false,
        phone_verified: false,
        status: "pending",

        email_verification_token_hash:
          emailVerificationTokenHash,

        email_verification_sent_at:
          wantsEmail
            ? now
            : null,

        sms_consent_at:
          wantsSms
            ? now
            : null,

        sms_consent_source:
          wantsSms
            ? "public_follow_form"
            : null,

        updated_at: now,
      })
      .select("id")
      .single();

    if (error) {
      console.error(
        "Notification subscription insert failed:",
        error
      );

      return NextResponse.json(
        {
          error:
            "Could not save your notification request.",
        },
        { status: 500 }
      );
    }

    if (wantsEmail && email && emailVerificationToken) {
      const resendApiKey =
        process.env.RESEND_API_KEY;

      const resendFromEmail =
        process.env.RESEND_FROM_EMAIL;

      const siteUrl =
        process.env.NEXT_PUBLIC_SITE_URL;

      if (
        !resendApiKey ||
        !resendFromEmail ||
        !siteUrl
      ) {
        console.error(
          "Resend email configuration is incomplete."
        );

        await adminSupabase
          .from("notification_subscriptions")
          .delete()
          .eq("id", subscription.id);

        return NextResponse.json(
          {
            error:
              "Email verification is not configured.",
          },
          { status: 500 }
        );
      }

      const resend = new Resend(resendApiKey);

      const verifyUrl =
        `${siteUrl.replace(/\/$/, "")}` +
        `/notifications/verify?type=follow&token=${emailVerificationToken}`;

      const entityLabel =
        entityKind === "bartender"
          ? "Tender"
          : "Spot";

      const { error: emailError } =
        await resend.emails.send({
          from: resendFromEmail,
          to: email,
          subject:
            `Verify your TenderFans ${entityLabel} follow`,
          html: `
            <div style="font-family:Arial,sans-serif;line-height:1.5;color:#222;">
              <h2>Confirm your TenderFans follow</h2>
              <p>
                Click below to verify your email address and turn on
                notifications for this ${entityLabel}.
              </p>
              <p>
                <a
                  href="${verifyUrl}"
                  style="
                    display:inline-block;
                    padding:10px 16px;
                    background:#222;
                    color:#fff;
                    text-decoration:none;
                    border-radius:8px;
                    font-weight:700;
                  "
                >
                  Verify Email
                </a>
              </p>
              <p style="font-size:12px;color:#666;">
                This is an automated message. This address does not accept replies.
              </p>
            </div>
          `,
        });

      if (emailError) {
        console.error(
          "Resend verification email failed:",
          emailError
        );

        await adminSupabase
          .from("notification_subscriptions")
          .delete()
          .eq("id", subscription.id);

        return NextResponse.json(
          {
            error:
              "Could not send the verification email.",
          },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      ok: true,
      status: "pending",
      message:
        wantsEmail
          ? "Check your email to verify your follow."
          : "Your notification request was saved.",
    });
  } catch (error) {
    console.error(
      "Notification subscription failed:",
      error
    );

    return NextResponse.json(
      {
        error:
          "Could not save your notification request.",
      },
      { status: 500 }
    );
  }
}
