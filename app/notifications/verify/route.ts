import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

export async function GET(request: Request) {
  const url = new URL(request.url);

  const type = url.searchParams.get("type");
  const token = url.searchParams.get("token");

  const redirectBase = new URL(
    "/notifications/verified",
    url.origin
  );

  if (type !== "follow" || !token) {
    redirectBase.searchParams.set("status", "invalid");
    return NextResponse.redirect(redirectBase);
  }

  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const supabaseSecret =
    process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseSecret) {
    console.error(
      "Server Supabase credentials are not configured."
    );

    redirectBase.searchParams.set("status", "error");
    return NextResponse.redirect(redirectBase);
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

  const tokenHash = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  const { data: subscription, error } =
    await adminSupabase
      .from("notification_subscriptions")
      .select(
        "id, email_verified, email_verification_sent_at"
      )
      .eq(
        "email_verification_token_hash",
        tokenHash
      )
      .maybeSingle();

  if (error) {
    console.error(
      "Follow verification lookup failed:",
      error
    );

    redirectBase.searchParams.set("status", "error");
    return NextResponse.redirect(redirectBase);
  }

  if (!subscription) {
    redirectBase.searchParams.set("status", "invalid");
    return NextResponse.redirect(redirectBase);
  }

  if (subscription.email_verified) {
    redirectBase.searchParams.set(
      "status",
      "already-verified"
    );

    return NextResponse.redirect(redirectBase);
  }

  const sentAt =
    subscription.email_verification_sent_at
      ? new Date(
          subscription.email_verification_sent_at
        ).getTime()
      : 0;

  const twentyFourHours =
    24 * 60 * 60 * 1000;

  if (
    !sentAt ||
    Date.now() - sentAt > twentyFourHours
  ) {
    redirectBase.searchParams.set("status", "expired");
    return NextResponse.redirect(redirectBase);
  }

  const now = new Date().toISOString();

  const { error: updateError } =
    await adminSupabase
      .from("notification_subscriptions")
      .update({
        email_verified: true,
        email_verified_at: now,
        email_verification_token_hash: null,
        status: "active",
        updated_at: now,
      })
      .eq("id", subscription.id);

  if (updateError) {
    console.error(
      "Follow verification update failed:",
      updateError
    );

    redirectBase.searchParams.set("status", "error");
    return NextResponse.redirect(redirectBase);
  }

  redirectBase.searchParams.set("status", "success");

  return NextResponse.redirect(redirectBase);
}
