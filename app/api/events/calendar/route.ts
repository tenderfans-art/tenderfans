import { createClient } from "@supabase/supabase-js";
import { CALENDAR_EVENT_SELECT, publicCalendarEvent } from "@/lib/event-search-metadata";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const venueId = params.get("venue_id");
  const offset = Number(params.get("offset") ?? "0");
  const limit = Number(params.get("limit") ?? "500");
  const from = params.get("from");
  const to = params.get("to");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const instant = (value: string | null) => value !== null && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 500 ||
      (venueId !== null ? !uuid.test(venueId) :
        !instant(from) || !instant(to) || Date.parse(to!) < Date.parse(from!) ||
        Date.parse(to!) - Date.parse(from!) > 62 * 86400000)) {
    return Response.json({ error: "Invalid calendar range." }, { status: 400 });
  }

  // Private provenance is projected into public categories on the server.
  // The root published-event page keeps pagination independent of source count.
  try {
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    let query = db.from("events").select(CALENDAR_EVENT_SELECT)
      .eq("status", "published")
      .eq("venues.status", "active")
      .order("starts_at", { ascending: true }).order("id", { ascending: true });
    if (venueId) query = query.eq("venue_id", venueId);
    else query = query.gte("starts_at", from!).lte("starts_at", to!);
    // PostgREST supports JSON keys such as @type; the SDK type parser does not.
    const { data, error } = await query.range(offset, offset + limit - 1)
      .returns<Record<string, unknown>[]>().abortSignal(request.signal);
    if (error) throw error;
    return Response.json({ data: (data ?? []).map(publicCalendarEvent) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ error: "Unable to load events." }, { status: 500 });
  }
}
