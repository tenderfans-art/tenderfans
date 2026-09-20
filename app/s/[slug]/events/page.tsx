import Link from "next/link";
import { notFound } from "next/navigation";
import EventsCalendar from "@/components/EventsCalendar";
import { supabase } from "@/lib/supabase";

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const { data: venue, error } = await supabase
    .from("venues")
    .select("id, slug, name")
    .or(`slug.eq.${slug},id.eq.${slug}`)
    .eq("status", "active")
    .maybeSingle();

  if (error || !venue) {
    notFound();
  }

  return (
    <main className="events-page">
      <div className="shell">
        <div className="events-heading">
          <div>
            <div className="eyebrow">SPOT EVENTS</div>
            <h1>{venue.name}</h1>

            <div
              style={{
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                gap: "14px",
                flexWrap: "wrap",
              }}
            >
              <p style={{ margin: 0 }}>
                Upcoming events at {venue.name}.
              </p>

              <Link
                href={`/s/${venue.slug}`}
                style={{
                  fontWeight: 700,
                  textDecoration: "underline",
                }}
              >
                Back to Spot Profile
              </Link>
            </div>
          </div>
        </div>

        <EventsCalendar
          venueId={venue.id}
          upcomingOnly
        />
      </div>
    </main>
  );
}
