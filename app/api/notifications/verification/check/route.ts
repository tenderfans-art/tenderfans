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

    const code =
      typeof body.code === "string"
        ? body.code.trim()
        : "";

    if (
      !type ||
      !id ||
      !/^\d{6}$/.test(code)
    ) {
      return NextResponse.json(
        { error: "Enter the 6-digit verification code." },
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
          wants_email,
          wants_sms,
          email_verified,
          phone_verified,
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
        active: record.status === "active",
      });
    }

    const client = twilio(
      accountSid,
      authToken
    );

    const verification =
      await client.verify.v2
        .services(verifyServiceSid)
        .verificationChecks.create({
          to: record.phone_e164,
          code,
        });

    if (verification.status !== "approved") {
      return NextResponse.json(
        { error: "That verification code is incorrect." },
        { status: 400 }
      );
    }

    const now = new Date().toISOString();

    /*
      Email and SMS are independent channels.
      Successful phone verification activates SMS immediately.
      Email may still be verified separately.
    */
    const { error: updateError } =
      await adminSupabase
        .from(table)
        .update({
          phone_verified: true,
          phone_verified_at: now,
          phone_verification_code_hash: null,
          status: "active",
          updated_at: now,
        })
        .eq("id", id);

    if (updateError) {
      throw updateError;
    }

    return NextResponse.json({
      ok: true,
      verified: true,
      active: true,
      emailPending:
        record.wants_email === true &&
        record.email_verified !== true,
    });
  } catch (error) {
    console.error(
      "Notification SMS verification check failed:",
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
