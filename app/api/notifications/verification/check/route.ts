import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";

type VerificationType = "follow" | "reminder" | "tender";

function getTable(type: VerificationType) {
  if (type === "follow") {
    return "notification_subscriptions";
  }

  if (type === "reminder") {
    return "event_reminders";
  }

  return "tender_notification_preferences";
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const type: VerificationType | null =
      body.type === "follow" ||
      body.type === "reminder" ||
      body.type === "tender"
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
          wants_sms,
          phone_verified
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
        active: true,
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
    const verificationUpdate =
      type === "tender"
        ? {
            phone_verified: true,
            phone_verified_at: now,
            updated_at: now,
          }
        : {
            phone_verified: true,
            phone_verified_at: now,
            phone_verification_code_hash: null,
            status: "active",
            updated_at: now,
          };

    const { error: updateError } =
      await adminSupabase
        .from(table)
        .update(verificationUpdate)
        .eq("id", id);

    if (updateError) {
      throw updateError;
    }

    if (type === "tender") {
      return NextResponse.json({
        ok: true,
        verified: true,
        active: true,
      });
    }

    const { data: channelRecord } =
      await adminSupabase
        .from(table)
        .select("wants_email, email_verified")
        .eq("id", id)
        .maybeSingle();

    return NextResponse.json({
      ok: true,
      verified: true,
      active: true,
      emailPending:
        channelRecord?.wants_email === true &&
        channelRecord?.email_verified !== true,
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
