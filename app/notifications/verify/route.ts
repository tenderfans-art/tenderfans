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

  if (
    (type !== "follow" && type !== "reminder") ||
    !token
  ) {
    redirectBase.searchParams.set("status", "invalid");
    return NextResponse.redirect(redirectBase);
  }

  redirectBase.searchParams.set("type", type);

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

  const table =
    type === "follow"
      ? "notification_subscriptions"
      : "event_reminders";

  let record: any = null;
  let error: any = null;

  if (type === "follow") {
    const result =
      await adminSupabase
        .from("notification_subscriptions")
        .select(
          "id, email_verified, email_verification_sent_at, entity_kind, bartender_id, venue_id"
        )
        .eq(
          "email_verification_token_hash",
          tokenHash
        )
        .maybeSingle();

    record = result.data;
    error = result.error;
  } else {
    const result =
      await adminSupabase
        .from("event_reminders")
        .select(
          "id, email_verified, email_verification_sent_at, event_id"
        )
        .eq(
          "email_verification_token_hash",
          tokenHash
        )
        .maybeSingle();

    record = result.data;
    error = result.error;
  }

  if (error) {
    console.error(
      `${type} verification lookup failed:`,
      error
    );

    redirectBase.searchParams.set("status", "error");
    return NextResponse.redirect(redirectBase);
  }

  if (!record) {
    redirectBase.searchParams.set("status", "invalid");
    return NextResponse.redirect(redirectBase);
  }

  if (record.email_verified) {
    redirectBase.searchParams.set(
      "status",
      "already-verified"
    );

    return NextResponse.redirect(redirectBase);
  }

  const sentAt =
    record.email_verification_sent_at
      ? new Date(
          record.email_verification_sent_at
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
      .from(table)
      .update({
        email_verified: true,
        email_verified_at: now,
        email_verification_token_hash: null,
        status: "active",
        updated_at: now,
      })
      .eq("id", record.id);

  if (updateError) {
    console.error(
      `${type} verification update failed:`,
      updateError
    );

    redirectBase.searchParams.set("status", "error");
    return NextResponse.redirect(redirectBase);
  }

  /*
   * Add the followed entity name to the success redirect
   * so the confirmation page can say:
   *
   * "You're following Jay!"
   * "You're following The Galley!"
   */
  if (type === "follow") {
    let entityName: string | null = null;

    if (
      record.entity_kind === "bartender" &&
      record.bartender_id
    ) {
      const { data: bartender } =
        await adminSupabase
          .from("bartenders")
          .select("display_name")
          .eq("id", record.bartender_id)
          .maybeSingle();

      entityName =
        bartender?.display_name ?? null;
    }

    if (
      record.entity_kind === "venue" &&
      record.venue_id
    ) {
      const { data: venue } =
        await adminSupabase
          .from("venues")
          .select("name")
          .eq("id", record.venue_id)
          .maybeSingle();

      entityName =
        venue?.name ?? null;
    }

    if (entityName) {
      redirectBase.searchParams.set(
        "name",
        entityName
      );
    }
  }

  redirectBase.searchParams.set("status", "success");

  return NextResponse.redirect(redirectBase);
}
