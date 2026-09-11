import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import VenueVisual from "@/components/VenueVisual";
import { supabase } from "@/lib/supabase";
import SpotTenderList from "@/components/SpotTenderList";
import PublicSpotMedia from "@/components/spot/PublicSpotMedia";
import NotificationSignup from "@/components/NotificationSignup";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;

  const { data: venue } = await supabase
    .from("venues")
    .select(`
      slug,
      name,
      venue_type,
      description,
      city,
      state_region
    `)
    .eq("slug", slug)
    .eq("status", "active")
    .maybeSingle();

  if (!venue) {
    return {
      title: "Spot Profile | TenderFans",
      robots: {
        index: false,
        follow: false,
      },
    };
  }

  const location = [
    venue.city,
    venue.state_region,
  ]
    .filter(Boolean)
    .join(", ");

  const title = location
    ? `${venue.name} — Tenders & Shouts in ${location} | TenderFans`
    : `${venue.name} — Tenders & Shouts | TenderFans`;

  const description = venue.description
    ? `${venue.description.slice(0, 150)}${venue.description.length > 150 ? "…" : ""}`
    : `Discover the Tenders at ${venue.name}${location ? ` in ${location}` : ""}. Find hospitality professionals, view profiles and give them a Shout on TenderFans.`;

  const canonical = `/s/${venue.slug}`;

  return {
    title,
    description,
    alternates: {
      canonical,
    },
    openGraph: {
      title,
      description,
      url: canonical,
      type: "website",
      siteName: "TenderFans",
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
  };
}

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

  const spotJsonLd = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: venue.name,
    url: `https://tenderfans.com/s/${venue.slug}`,
    ...(venue.description
      ? { description: venue.description }
      : {}),
    ...(venue.public_phone
      ? { telephone: venue.public_phone }
      : {}),
    ...(venue.website_url
      ? { sameAs: [venue.website_url] }
      : {}),
    address: {
      "@type": "PostalAddress",
      ...(venue.street_address
        ? { streetAddress: venue.street_address }
        : {}),
      ...(venue.city
        ? { addressLocality: venue.city }
        : {}),
      ...(venue.state_region
        ? { addressRegion: venue.state_region }
        : {}),
      ...(venue.postal_code
        ? { postalCode: venue.postal_code }
        : {}),
      addressCountry: "US",
    },
    ...(venue.latitude != null && venue.longitude != null
      ? {
          geo: {
            "@type": "GeoCoordinates",
            latitude: venue.latitude,
            longitude: venue.longitude,
          },
        }
      : {}),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(spotJsonLd),
        }}
      />

      <section className="profile-page">
      <div className="shell profile-shell">
        <div className="venue-profile-visual">
          <VenueVisual venue={venue as any} />
        </div>

        <div className="venue-profile-copy">
          <div className="eyebrow">Spot profile</div>

          <div className="profile-title-actions">
            <h1>{venue.name}</h1>

            <NotificationSignup
              mode="follow"
              entityKind="venue"
              entityId={venue.id}
              entityName={venue.name}
            />
          </div>

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
    </>
  );
}
