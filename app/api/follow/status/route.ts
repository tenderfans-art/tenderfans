import {
  NextRequest,
  NextResponse,
} from "next/server";

import {
  createClient,
} from "@supabase/supabase-js";

import {
  getNotificationIdentityCookieName,
  verifyNotificationIdentityToken,
} from "@/lib/notificationIdentity";

export async function GET(
  request: NextRequest
) {
  try {
    const url =
      new URL(request.url);

    const entityKind =
      url.searchParams.get(
        "entityKind"
      );

    const entityId =
      url.searchParams.get(
        "entityId"
      )?.trim() ?? "";

    if (
      (
        entityKind !== "bartender" &&
        entityKind !== "venue"
      ) ||
      !entityId
    ) {
      return NextResponse.json(
        {
          error:
            "A valid Tender or Spot is required.",
        },
        { status: 400 }
      );
    }

    const cookie =
      request.cookies.get(
        getNotificationIdentityCookieName()
      )?.value;

    if (!cookie) {
      return NextResponse.json({
        state: "none",
        emailActive: false,
        smsActive: false,
      });
    }

    const identity =
      verifyNotificationIdentityToken(
        cookie
      );

    if (
      !identity ||
      !identity.subscriptionIds.length
    ) {
      return NextResponse.json({
        state: "none",
        emailActive: false,
        smsActive: false,
      });
    }

    const supabaseUrl =
      process.env
        .NEXT_PUBLIC_SUPABASE_URL;

    const supabaseSecret =
      process.env
        .SUPABASE_SECRET_KEY;

    if (
      !supabaseUrl ||
      !supabaseSecret
    ) {
      throw new Error(
        "Server Supabase credentials are not configured."
      );
    }

    const adminSupabase =
      createClient(
        supabaseUrl,
        supabaseSecret,
        {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
          },
        }
      );

    let query =
      adminSupabase
        .from(
          "notification_subscriptions"
        )
        .select(`
          id,
          wants_email,
          wants_sms,
          email_verified,
          phone_verified,
          status
        `)
        .in(
          "id",
          identity.subscriptionIds
        )
        .eq(
          "entity_kind",
          entityKind
        );

    query =
      entityKind === "bartender"
        ? query.eq(
            "bartender_id",
            entityId
          )
        : query.eq(
            "venue_id",
            entityId
          );

    const {
      data,
      error,
    } = await query;

    if (error) {
      throw error;
    }

    let emailActive = false;
    let smsActive = false;

    for (const row of data ?? []) {
      if (
        row.status !== "active"
      ) {
        continue;
      }

      if (
        row.wants_email === true &&
        row.email_verified === true
      ) {
        emailActive = true;
      }

      if (
        row.wants_sms === true &&
        row.phone_verified === true
      ) {
        smsActive = true;
      }
    }

    const activeChannelCount =
      Number(emailActive) +
      Number(smsActive);

    const state =
      activeChannelCount === 2
        ? "full"
        : activeChannelCount === 1
          ? "partial"
          : "none";

    return NextResponse.json(
      {
        state,
        emailActive,
        smsActive,
      },
      {
        headers: {
          "Cache-Control":
            "private, no-store, max-age=0",
        },
      }
    );
  } catch (error) {
    console.error(
      "Follow status lookup failed:",
      error
    );

    return NextResponse.json(
      {
        error:
          "Could not load follow status.",
      },
      { status: 500 }
    );
  }
}
