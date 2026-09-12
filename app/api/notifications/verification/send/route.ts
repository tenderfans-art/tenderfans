import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";

type VerificationType = "follow" | "reminder";

function getTable(type: VerificationType) {
  return type === "follow"
    ? "notification_subscriptions"
    : "event_reminders";
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const type: VerificationType | null =
      body.type === "follow" || body.type === "reminder"
        ? body.type
        : null;

    const id =
      typeof body.id === "string"
        ? body.id.trim()
        : "";

    if (!type || !id) {
      return NextResponse.json(
        { error: "Invalid notification verification request." },
        { status: 400 }
      );
    }

    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL;

    const supabaseSecret =
      process.env.SUPABASE_SECRET_KEY;

    const accountSid =
      process.env.TWILIO_ACCOUNT_SID;

    const authToken =
      process.env.TWILIO_AUTH_TOKEN;

    const verifyServiceSid =
      process.env.TWILIO_VERIFY_SERVICE_SID;

    if (
      !supabaseUrl ||
      !supabaseSecret ||
      !accountSid ||
      !authToken ||
      !verifyServiceSid
    ) {
      return NextResponse.json(
        { error: "SMS verification is not configured." },
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

    const table = getTable(type);

    const { data: record, error } =
      await adminSupabase
        .from(table)
        .select(`
          id,
          phone_e164,
          wants_sms,
          phone_verified,
          phone_verification_sent_at,
          status
        `)
        .eq("id", id)
        .maybeSingle();

    if (error || !record) {
      return NextResponse.json(
        { error: "Notification request was not found." },
        { status: 404 }
      );
    }

    if (!record.wants_sms || !record.phone_e164) {
      return NextResponse.json(
        { error: "Text notifications were not requested." },
        { status: 400 }
      );
    }

    if (record.phone_verified) {
      return NextResponse.json({
        ok: true,
        verified: true,
      });
    }

    /*
      Avoid repeated rapid sends against the same record.
    */
    if (record.phone_verification_sent_at) {
      const sentAt =
        new Date(
          record.phone_verification_sent_at
        ).getTime();

      if (
        Number.isFinite(sentAt) &&
        Date.now() - sentAt < 30 * 1000
      ) {
        return NextResponse.json(
          {
            error:
              "A verification code was just sent. Please wait before requesting another.",
          },
          {
            status: 429,
            headers: {
              "Retry-After": "30",
            },
          }
        );
      }
    }

    const client = twilio(
      accountSid,
      authToken
    );

    await client.verify.v2
      .services(verifyServiceSid)
      .verifications.create({
        to: record.phone_e164,
        channel: "sms",
      });

    const now = new Date().toISOString();

    const { error: updateError } =
      await adminSupabase
        .from(table)
        .update({
          phone_verification_sent_at: now,
          updated_at: now,
        })
        .eq("id", id);

    if (updateError) {
      throw updateError;
    }

    return NextResponse.json({
      ok: true,
      sent: true,
    });
  } catch (error) {
    console.error(
      "Notification SMS verification send failed:",
      error
    );

    return NextResponse.json(
      {
        error:
          "Could not send the verification code.",
      },
      { status: 500 }
    );
  }
}
