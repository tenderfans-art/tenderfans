import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function POST(request: Request) {
  try {
    const { placeId, marketId } = await request.json();

    if (marketId !== undefined && (
      typeof marketId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(marketId)
    )) {
      return NextResponse.json(
        { error: "Invalid market ID." },
        { status: 400 }
      );
    }

    if (!placeId || typeof placeId !== "string") {
      return NextResponse.json(
        { error: "A Google Place ID is required." },
        { status: 400 }
      );
    }

    const apiKey = process.env.GOOGLE_PLACES_API_KEY;

    if (!apiKey) {
      console.error("GOOGLE_PLACES_API_KEY is not configured.");
      return NextResponse.json(
        { error: "Google Places is not configured." },
        { status: 500 }
      );
    }

    const response = await fetch(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
      {
        headers: {
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": [
            "id",
            "displayName",
            "formattedAddress",
            "location",
            "addressComponents",
            "nationalPhoneNumber",
            "websiteUri",
            "regularOpeningHours.weekdayDescriptions",
          ].join(","),
        },
        cache: "no-store",
      }
    );

    if (!response.ok) {
      const detail = await response.text();
      console.error("Google Place Details error:", response.status, detail);

      return NextResponse.json(
        { error: "Could not verify Google Place." },
        { status: 502 }
      );
    }

    const place = await response.json();

    const components = Array.isArray(place.addressComponents)
      ? place.addressComponents
      : [];

    const component = (type: string) =>
      components.find((item: any) => item.types?.includes(type));

    const streetNumber = component("street_number")?.longText ?? "";
    const route = component("route")?.longText ?? "";

    const verifiedPlace = {
      id: place.id,
      name: place.displayName?.text ?? "Unknown place",
      address: place.formattedAddress ?? "",
      latitude: place.location?.latitude ?? null,
      longitude: place.location?.longitude ?? null,
      city: component("locality")?.longText ?? "",
      state:
        component("administrative_area_level_1")?.shortText ?? "",
      postalCode: component("postal_code")?.longText ?? "",
      streetAddress: [streetNumber, route].filter(Boolean).join(" "),
      publicPhone: place.nationalPhoneNumber ?? "",
      websiteUrl: place.websiteUri ?? "",
      regularHours:
        place.regularOpeningHours?.weekdayDescriptions ?? [],
    };

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseSecret = process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseSecret) {
      console.error("Server Supabase credentials are not configured.");
      return NextResponse.json(
        { error: "Server database access is not configured." },
        { status: 500 }
      );
    }

    const adminSupabase = createClient(supabaseUrl, supabaseSecret, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    if (marketId) {
      const authorization = request.headers.get("authorization") ?? "";
      const token = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";

      const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (!token || !anonKey) {
        return NextResponse.json(
          { error: "Admin session required for market assignment." },
          { status: 401 }
        );
      }

      const authClient = createClient(supabaseUrl, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const { data: identity, error: identityError } =
        await authClient.auth.getUser(token);

      if (identityError || !identity.user) {
        return NextResponse.json(
          { error: "Invalid session." },
          { status: 401 }
        );
      }

      const { data: admin } = await adminSupabase
        .from("platform_admins")
        .select("user_id")
        .eq("user_id", identity.user.id)
        .maybeSingle();

      if (!admin) {
        return NextResponse.json(
          { error: "Admin access required." },
          { status: 403 }
        );
      }

      const { data: market } = await adminSupabase
        .from("event_processing_markets")
        .select("id")
        .eq("id", marketId)
        .maybeSingle();

      if (!market) {
        return NextResponse.json(
          { error: "Market not found." },
          { status: 404 }
        );
      }
    }

    const { data: venueId, error: venueError } = await adminSupabase.rpc(
      "upsert_google_venue",
      {
        p_place_id: verifiedPlace.id,
        p_name: verifiedPlace.name,
        p_street_address: verifiedPlace.streetAddress,
        p_city: verifiedPlace.city,
        p_state_region: verifiedPlace.state,
        p_postal_code: verifiedPlace.postalCode,
        p_latitude: verifiedPlace.latitude,
        p_longitude: verifiedPlace.longitude,
        p_public_phone: verifiedPlace.publicPhone,
        p_website_url: verifiedPlace.websiteUrl,
        p_regular_hours: verifiedPlace.regularHours,
      }
    );

    if (venueError) {
      console.error("Supabase venue upsert failed:", venueError);
      return NextResponse.json(
        { error: "Could not save verified Google Place." },
        { status: 500 }
      );
    }

    if (marketId) {
      const { data: existing, error: existingError } =
        await adminSupabase
          .from("event_processing_market_venues")
          .select("market_id")
          .eq("venue_id", venueId)
          .maybeSingle();

      if (existingError) {
        return NextResponse.json(
          { error: "Could not check Spot market assignment.", venueId },
          { status: 500 }
        );
      }

      if (existing && existing.market_id !== marketId) {
        return NextResponse.json(
          {
            error: "This Spot already belongs to another market.",
            venueId,
          },
          { status: 409 }
        );
      }

      if (!existing) {
        const { error: assignmentError } = await adminSupabase
          .from("event_processing_market_venues")
          .insert({ venue_id: venueId, market_id: marketId });

        if (assignmentError) {
          return NextResponse.json(
            {
              error: assignmentError.code === "23505"
                ? "Spot market assignment changed concurrently. Refresh and retry."
                : "Could not assign Spot to market.",
              venueId,
            },
            { status: 409 }
          );
        }
      }
    }

    return NextResponse.json({
      venueId,
      place: verifiedPlace,
      marketId: marketId ?? null,
    });
  } catch (error) {
    console.error("Google Place verification failed:", error);

    return NextResponse.json(
      { error: "Could not verify Google Place." },
      { status: 500 }
    );
  }
}
