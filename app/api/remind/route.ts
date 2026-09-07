import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

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

    const { error } = await adminSupabase
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

        sms_consent_at:
          wantsSms
            ? now
            : null,

        sms_consent_source:
          wantsSms
            ? "public_event_reminder_form"
            : null,

        updated_at: now,
      });

    if (error) {
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

    return NextResponse.json({
      ok: true,
      status: "pending",
      message:
        "Your event reminder was saved.",
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
