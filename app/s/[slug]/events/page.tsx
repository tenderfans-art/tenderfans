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
            <p>Upcoming events at {venue.name}.</p>
          </div>
        </div>

        <EventsCalendar
          venueId={venue.id}
          upcomingOnly
        />

        <div style={{ marginTop: 24 }}>
          <Link
            href={`/s/${venue.slug}`}
            className="button secondary-button"
          >
            Back to Spot Profile
          </Link>
        </div>
      </div>
    </main>
  );
}
