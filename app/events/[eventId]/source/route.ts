import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export async function GET(request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId)) {
    return new Response("Event not found.", { status: 404 });
  }

  // Resolve existing provenance on click; private harvest tables remain private.
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await db.from("event_source_links")
    .select("source_url, events!inner(status)")
    .eq("event_id", eventId)
    .eq("events.status", "published")
    .order("last_verified_at", { ascending: false, nullsFirst: false })
    .order("id", { ascending: true })
    .limit(10);

  const destination = new URL("/events", request.url);
  destination.searchParams.set("event", eventId);
  if (error) console.error("Unable to resolve event source:", error.message);
  for (const row of data ?? []) {
    if (!row.source_url) continue;
    try {
      const url = new URL(row.source_url);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) continue;
      return NextResponse.redirect(url, { status: 307, headers: { "Cache-Control": "no-store" } });
    } catch { /* Try the next recorded source URL. */ }
  }
  // Locally submitted events without an external source retain their details.
  return NextResponse.redirect(destination, { status: 307, headers: { "Cache-Control": "no-store" } });
}
