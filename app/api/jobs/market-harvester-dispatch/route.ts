import { POST as dispatchShared } from
  "@/app/api/jobs/shared-market-dispatch/route";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;

  if (
    !secret ||
    request.headers.get("authorization") !== `Bearer ${secret}`
  ) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON" },
      { status: 400 },
    );
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    !("marketId" in payload) ||
    typeof payload.marketId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(payload.marketId)
  ) {
    return Response.json(
      { error: "A valid marketId UUID is required" },
      { status: 400 },
    );
  }

  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");

  return dispatchShared(
    new Request(request.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ marketId: payload.marketId }),
    }),
  );
}
