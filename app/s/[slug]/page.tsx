import { notFound } from "next/navigation";
import Link from "next/link";
import VenueVisual from "@/components/VenueVisual";
import { supabase } from "@/lib/supabase";
import SpotTenderList from "@/components/SpotTenderList";
import PublicSpotMedia from "@/components/spot/PublicSpotMedia";

export default async function SpotPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const { data: venue, error: venueError } = await supabase
    .from("venues")
    .select(`
      id,
      slug,
      name,
      venue_type,
      description,
      street_address,
      city,
      state_region,
      postal_code,
      status,
      public_phone,
      website_url,
      latitude,
      longitude,
      regular_hours
    `)
    .eq("slug", slug)
    .eq("status", "active")
    .single();

  if (venueError || !venue) {
    notFound();
  }

  const { data: relationships, error: relationshipError } = await supabase
    .from("bartender_venues")
    .select(`
      bartender_id,
      bartenders!inner(
        id,
        slug,
        display_name,
        bio,
        status
      )
    `)
    .eq("venue_id", venue.id)
    .eq("is_current", true)
    .eq("bartenders.status", "active");

  if (relationshipError) {
    console.error("TenderFans spot tenders:", relationshipError);
  }

  const tenders = (relationships ?? [])
    .map((row: any) => {
      const bartenderData = row.bartenders;
      return Array.isArray(bartenderData)
        ? bartenderData[0]
        : bartenderData;
    })
    .filter(Boolean);

  return (
    <section className="profile-page">
      <div className="shell profile-shell">
        <div className="venue-profile-visual">
          <VenueVisual venue={venue as any} />
        </div>

        <div className="venue-profile-copy">
          <div className="eyebrow">Spot profile</div>

          <h1>{venue.name}</h1>

          <p className="venue-meta">
            {venue.venue_type.charAt(0).toUpperCase() + venue.venue_type.slice(1)} · {venue.city}
            {venue.state_region ? `, ${venue.state_region}` : ""}
          </p>

          {venue.description && (
            <p className="bio">{venue.description}</p>
          )}

          <div className="venue-contact">
            <div className="venue-contact-main">
              <div>
                <strong>Address</strong>
                <span>
                  {venue.street_address}
                  <br />
                  {venue.city}, {venue.state_region} {venue.postal_code}
                </span>
              </div>

              {venue.public_phone && (
                <div>
                  <strong>Phone</strong>
                  <a href={`tel:${venue.public_phone}`}>
                    {venue.public_phone}
                  </a>
                </div>
              )}

              {venue.website_url && (
                <div>
                  <strong>Website</strong>
                  <a
                    href={venue.website_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Visit website
                  </a>
                </div>
              )}
            </div>

            <div className="venue-hours">
              <strong>Hours</strong>
              <span>
                {Array.isArray(venue.regular_hours) &&
                venue.regular_hours.length
                  ? venue.regular_hours.map((day: string) => (
                      <span key={day} style={{ display: "block" }}>
                        {day}
                      </span>
                    ))
                  : "Hours coming soon"}
              </span>
            </div>
          </div>
        </div>

        <PublicSpotMedia venueId={venue.id} />

        <section className="subsection full">
          <div className="section-title spot-tender-heading">
            <div>
              <span className="eyebrow">Behind the bar</span>
              <h2>Tenders at {venue.name}</h2>
            </div>
          </div>

          <SpotTenderList tenders={tenders} />
        </section>
      </div>
    </section>
  );
}
