import { NextResponse } from "next/server";
import { fetchWooCommerceEvents } from "@/lib/event-harvester/first-party/woocommerce-events";
import { recoveryFetch } from "@/lib/event-harvester/recovery-fetch";
import { runWithTransportRecovery } from "@/lib/event-harvester/transport-recovery-context";

export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not found", { status: 404 });
  }

  const proxy = process.env.TENDERFANS_TRANSPORT_PROXY_URL;

  if (!proxy) {
    return NextResponse.json(
      { error: "Transport proxy not configured" },
      { status: 500 },
    );
  }

  try {
    const events = await runWithTransportRecovery(
      proxy,
      () => fetchWooCommerceEvents(
        "https://clearskyrestaurants.com/wp-json/wc/store/v1/products",
        { timeZone: "America/New_York", fetcher: (input, init) => recoveryFetch(String(input), init) },
      ),
    );

    return NextResponse.json({
      eventCount: events.length,
      events: events.map((event) => ({
        id: event.externalEventId,
        title: event.title,
        startsAt: event.startsAt,
        venueName: event.venueName,
        venueAddress: event.venueAddress,
        sourceUrl: event.sourceUrl,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
