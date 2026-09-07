import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import crypto from "crypto";

function getClientIpHash(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for");

  const ip =
    forwardedFor?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown";

  return crypto
    .createHash("sha256")
    .update(ip)
    .digest("hex");
}

function normalizeEmail(value: unknown) {
  if (typeof value !== "string") return null;

  const email = value.trim().toLowerCase();

  if (!email) return null;

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? email
    : null;
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

    const eventId =
      typeof body.eventId === "string"
        ? body.eventId.trim()
        : "";

    const reminderMinutesBefore =
      Number(body.reminderMinutesBefore);

    const allowedReminderTimes = [60, 180, 1440];

    const wantsEmail = body.wantsEmail === true;
    const wantsSms = body.wantsSms === true;

    const email = normalizeEmail(body.email);
    const phone = normalizePhone(body.phone);

    const smsConsent = body.smsConsent === true;

    if (!eventId) {
      return NextResponse.json(
        { error: "A valid event is required." },
        { status: 400 }
      );
    }

    if (!allowedReminderTimes.includes(reminderMinutesBefore)) {
      return NextResponse.json(
        { error: "Choose a valid reminder time." },
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
            "Text reminders require consent before subscribing.",
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
            "Event reminders are not configured.",
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

      const ipHash = getClientIpHash(request);

      const { data: allowed, error: rateLimitError } =
        await adminSupabase.rpc(
          "check_notification_rate_limit",
          {
            p_ip_hash: ipHash,
            p_limit: 5,
            p_window_minutes: 15,
          }
        );

      if (rateLimitError) {
        console.error(
          "Notification rate limit check failed:",
          rateLimitError
        );

        return NextResponse.json(
          {
            error:
              "Notification signup is temporarily unavailable.",
          },
          { status: 500 }
        );
      }

      if (allowed !== true) {
        return NextResponse.json(
          {
            error:
              "Too many notification requests. Please try again later.",
          },
          {
            status: 429,
            headers: {
              "Retry-After": "900",
            },
          }
        );
      }

    const { data: event, error: eventError } =
      await adminSupabase
        .from("events")
        .select("id, starts_at, status")
        .eq("id", eventId)
        .eq("status", "published")
        .maybeSingle();

    if (eventError) {
      console.error(
        "Event reminder event lookup failed:",
        eventError
      );

      return NextResponse.json(
        { error: "Could not verify that event." },
        { status: 500 }
      );
    }

    if (!event) {
      return NextResponse.json(
        { error: "That event is not available." },
        { status: 404 }
      );
    }

    const startsAt = new Date(event.starts_at);

    if (
      Number.isNaN(startsAt.getTime()) ||
      startsAt.getTime() <= Date.now()
    ) {
      return NextResponse.json(
        { error: "That event has already started." },
        { status: 400 }
      );
    }

    const reminderAt =
      startsAt.getTime() -
      reminderMinutesBefore * 60 * 1000;

    if (reminderAt <= Date.now()) {
      return NextResponse.json(
        {
          error:
            "That reminder time has already passed. Choose a later reminder.",
        },
        { status: 400 }
      );
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

    const { data: reminder, error } = await adminSupabase
      .from("event_reminders")
      .insert({
        event_id: eventId,

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

        reminder_minutes_before:
          reminderMinutesBefore,

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
            ? "public_event_reminder_form"
            : null,

        updated_at: now,
      })
      .select("id")
      .single();

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          {
            ok: true,
            status: "existing",
            message:
              "You already have that event reminder set for this email.",
          },
          { status: 200 }
        );
      }

      console.error(
        "Event reminder insert failed:",
        error
      );

      return NextResponse.json(
        {
          error:
            "Could not save your event reminder.",
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
          .from("event_reminders")
          .delete()
          .eq("id", reminder.id);

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
        `/notifications/verify?type=reminder&token=${emailVerificationToken}`;

      const { error: emailError } =
        await resend.emails.send({
          from: resendFromEmail,
          to: email,
          subject:
            "Verify your TenderFans event reminder",
          html: `
            <div style="font-family:Arial,sans-serif;line-height:1.5;color:#222;">
              <h2>Confirm your TenderFans reminder</h2>
              <p>
                Click below to verify your email address and turn on
                this event reminder.
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
          "Resend reminder verification email failed:",
          emailError
        );

        await adminSupabase
          .from("event_reminders")
          .delete()
          .eq("id", reminder.id);

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
          ? "Check your email to verify your event reminder."
          : "Your event reminder was saved.",
    });
  } catch (error) {
    console.error(
      "Event reminder signup failed:",
      error
    );

    return NextResponse.json(
      {
        error:
          "Could not save your event reminder.",
      },
      { status: 500 }
    );
  }
}
