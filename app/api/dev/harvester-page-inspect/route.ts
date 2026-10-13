import { NextResponse } from "next/server";
import { signedHarvesterFetch } from "@/lib/event-harvester/signed-fetch";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not found", { status: 404 });
  }

  const url = new URL(request.url).searchParams.get("url");

  if (!url) {
    return NextResponse.json(
      { error: "Missing url" },
      { status: 400 },
    );
  }

  try {
    const target = new URL(url);

    if (
      target.protocol !== "https:" ||
      !["clearskyrestaurants.com", "www.clearskyrestaurants.com"]
        .includes(target.hostname.toLowerCase()) ||
      target.port ||
      target.username ||
      target.password
    ) {
      return NextResponse.json(
        { error: "Unsupported diagnostic destination" },
        { status: 400 },
      );
    }

    const proxy = process.env.TENDERFANS_TRANSPORT_PROXY_URL;

    if (!proxy) {
      throw new Error("Transport proxy is not configured");
    }

    const response = await signedHarvesterFetch(
      target.toString(),
      {
        headers: {
          Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": "Mozilla/5.0",
        },
        cache: "no-store",
      },
      proxy,
    );

    const body = await response.text();

    return NextResponse.json({
      status: response.status,
      finalUrl: response.url,
      contentType: response.headers.get("content-type"),
      bytes: body.length,
      body: body.slice(0, 250000),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
