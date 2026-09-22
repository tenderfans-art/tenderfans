import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendNotificationEmail } from "@/lib/notificationDelivery";

export async function POST(request: NextRequest) {
  try {
    const authorization = request.headers.get("authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401 }
      );
    }

    const accessToken = authorization.slice(7);

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const secret = process.env.SUPABASE_SECRET_KEY;

    if (!url || !anonKey || !secret) {
      throw new Error("Supabase server configuration is incomplete.");
    }

    const userClient = createClient(url, anonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser(accessToken);

    if (userError || !user) {
      return NextResponse.json(
        { error: "Authentication required." },
        { status: 401 }
      );
    }

    const admin = createClient(url, secret, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const { data: platformAdmin, error: adminError } = await admin
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (adminError || !platformAdmin) {
      return NextResponse.json(
        { error: "Admin access required." },
        { status: 403 }
      );
    }

    const body = await request.json();

    const email =
      typeof body.email === "string"
        ? body.email.trim().toLowerCase()
        : "";

    const tenderName =
      typeof body.tenderName === "string"
        ? body.tenderName.trim()
        : "";

    if (!email || !tenderName) {
      return NextResponse.json(
        { error: "Tender email and name are required." },
        { status: 400 }
      );
    }

    await sendNotificationEmail({
      to: email,
      subject: "Your Tender profile is verified",
      text:
        `Your TenderFans profile for ${tenderName} has been verified. ` +
        "You can now manage your profile, photos, Spots, Messages and Tender account.",
      url: "/account/tender",
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Tender claim approval email failed:", error);

    return NextResponse.json(
      { error: "Could not send Tender approval email." },
      { status: 500 }
    );
  }
}
