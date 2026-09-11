import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import NotificationSignup from "@/components/NotificationSignup";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;

  const { data: bartender } = await supabase
    .from("bartenders")
    .select("id, slug, display_name, bio, tender_type")
    .eq("slug", slug)
    .eq("status", "active")
    .maybeSingle();

  if (!bartender) {
    return {
      title: "Tender Profile | TenderFans",
      robots: {
        index: false,
        follow: false,
      },
    };
  }

  const tenderTypeLabel = bartender.tender_type
    ? bartender.tender_type
        .replaceAll("_", " ")
        .replace(/\b\w/g, (c: string) => c.toUpperCase())
    : "Bartender";

  const { data: relationships } = await supabase
    .from("bartender_venues")
    .select("venue_id, is_primary")
    .eq("bartender_id", bartender.id)
    .eq("is_current", true)
    .order("is_primary", { ascending: false })
    .limit(1);

  let spotName = "";
  let city = "";
  let state = "";

  const primaryRelationship = relationships?.[0];

  if (primaryRelationship?.venue_id) {
    const { data: venue } = await supabase
      .from("venues")
      .select("name, city, state_region")
      .eq("id", primaryRelationship.venue_id)
      .eq("status", "active")
      .maybeSingle();

    if (venue) {
      spotName = venue.name ?? "";
      city = venue.city ?? "";
      state = venue.state_region ?? "";
    }
  }

  const title = spotName
    ? `${bartender.display_name} — ${tenderTypeLabel} at ${spotName} | TenderFans`
    : `${bartender.display_name} — ${tenderTypeLabel} | TenderFans`;

  const location = [city, state].filter(Boolean).join(", ");

  const description = bartender.bio
    ? `${bartender.bio.slice(0, 150)}${bartender.bio.length > 150 ? "…" : ""}`
    : spotName
      ? `Discover ${bartender.display_name}, a ${tenderTypeLabel.toLowerCase()} at ${spotName}${location ? ` in ${location}` : ""}. See Shouts, badges and profile details on TenderFans.`
      : `Discover ${bartender.display_name}, a ${tenderTypeLabel.toLowerCase()} on TenderFans. See Shouts, badges and profile details.`;

  const canonical = `/t/${bartender.slug}`;

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
      type: "profile",
      siteName: "TenderFans",
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
  };
}

export default async function TenderPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const { data: bartender } = await supabase
    .from("bartenders")
    .select("id, slug, display_name, bio, status, tender_type")
    .eq("slug", slug)
    .eq("status", "active")
    .single();

  if (!bartender) notFound();

  const { data: approvedClaims } = await supabase.rpc(
    "public_approved_claimed_entities"
  );

  const isClaimed = (approvedClaims ?? []).some(
    (claim: { entity_kind: string; entity_id: string }) =>
      claim.entity_kind === "bartender" &&
      claim.entity_id === bartender.id
  );

  const tenderTypeLabel =
    bartender.tender_type
      ? bartender.tender_type
          .replaceAll("_", " ")
          .replace(/\b\w/g, (c: string) => c.toUpperCase())
      : "Bartender";

  const contestNow = new Date().toISOString();

  const { data: activeContest } = await supabase
    .from("contests")
    .select("id")
    .eq("is_active", true)
    .lte("starts_at", contestNow)
    .gte("ends_at", contestNow)
    .maybeSingle();

  const { data: relationships } = await supabase
    .from("bartender_venues")
    .select("venue_id, is_primary")
    .eq("bartender_id", bartender.id)
    .eq("is_current", true);

  const venueIds = [
    ...new Set(
      (relationships ?? [])
        .map((relationship) => relationship.venue_id)
        .filter(Boolean)
    ),
  ];

  let currentSpots: {
    id: string;
    name: string;
    slug: string;
    city: string | null;
    is_primary: boolean;
  }[] = [];

  if (venueIds.length > 0) {
    const { data: venues } = await supabase
      .from("venues")
      .select("id, name, slug, city")
      .in("id", venueIds);

    const primaryByVenue = new Map(
      (relationships ?? []).map((relationship) => [
        relationship.venue_id,
        relationship.is_primary === true,
      ])
    );

    currentSpots = (venues ?? [])
      .map((venue) => ({
        ...venue,
        is_primary: primaryByVenue.get(venue.id) === true,
      }))
      .sort(
        (a, b) =>
          Number(b.is_primary) - Number(a.is_primary) ||
          a.name.localeCompare(b.name)
      );
  }
  
  const { data: heroPhoto } = await supabase
    .from("media_assets")
    .select("storage_path")
    .eq("entity_kind", "bartender")
    .eq("bartender_id", bartender.id)
    .eq("media_type", "photo")
    .eq("is_hero", true)
    .eq("status", "published")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const heroPhotoUrl = heroPhoto?.storage_path
    ? supabase.storage
        .from("spot-media")
        .getPublicUrl(heroPhoto.storage_path).data.publicUrl
    : null;

  const { count: cheerCount } = await supabase
    .from("shoutouts")
    .select("id", { count: "exact", head: true })
    .eq("bartender_id", bartender.id)
    .eq("status", "published");

  const { data: traitRows } = await supabase
    .from("shoutout_traits")
    .select("trait_id, traits(label), shoutouts!inner(bartender_id,status)")
    .eq("shoutouts.bartender_id", bartender.id)
    .eq("shoutouts.status", "published");

  const traitCounts = new Map<string, number>();

  for (const row of traitRows ?? []) {
    const trait = (row as any).traits;
    const label = Array.isArray(trait)
      ? trait[0]?.label
      : trait?.label;

    if (!label) continue;
    traitCounts.set(label, (traitCounts.get(label) ?? 0) + 1);
  }

  const topTraits = [...traitCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  return (
    <section className="profile-page tender-profile-page">
      <div className="shell tender-profile-shell">

        <div className="tender-profile-main">
          <div className="tender-profile-media-column">
            <div className="tender-profile-visual">
              {heroPhotoUrl ? (
                <img
                  src={heroPhotoUrl}
                  alt={bartender.display_name}
                  className="tender-profile-photo"
                />
              ) : (
                <div className="photo-fallback tender-profile-fallback">
                  {bartender.display_name[0]}
                </div>
              )}
            </div>

            <div className="tender-shout-action">
              <Link
                className="btn primary"
                href={
                  activeContest
                    ? `/contest/t/${bartender.slug}`
                    : "/shout"
                }
              >
                Give {bartender.display_name} a Shout
              </Link>
            </div>
          </div>

          <div className="tender-profile-copy">
            <div className="tender-profile-heading-row">
              <div className="profile-title-actions">
                <h1>{bartender.display_name}</h1>

                <NotificationSignup
                  mode="follow"
                  entityKind="bartender"
                  entityId={bartender.id}
                  entityName={bartender.display_name}
                />
              </div>

              <div className="tender-cheers-inline">
                <strong>{cheerCount ?? 0}</strong>
                <span>
                  {(cheerCount ?? 0) === 1 ? "Cheer" : "Cheers"}
                </span>
              </div>
            </div>

            {currentSpots.length > 0 && (
              <div className="tender-current-spots">
                <div className="tender-detail-label">
                  Current {currentSpots.length === 1 ? "Spot" : "Spots"}
                </div>

                <div className="tender-current-spot-list">
                  {currentSpots.map((spot) => (
                    <div className="tender-current-spot-row" key={spot.id}>
                      <span>{tenderTypeLabel}</span>

                      <span>·</span>

                      <Link href={`/s/${spot.slug}`}>{spot.name}</Link>

                      {spot.city && (
                        <span className="tender-spot-city">· {spot.city}</span>
                      )}

                      {spot.is_primary && (
                        <span className="tender-primary-label">Primary</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="tender-about">
              <div className="tender-detail-label">About</div>

              {bartender.bio ? (
                <p className="bio">{bartender.bio}</p>
              ) : isClaimed ? (
                <p className="bio muted">
                  This Tender hasn&apos;t added a bio yet.
                </p>
              ) : (
                <p className="bio muted">
                  This profile is community-added and waiting to be claimed.
                </p>
              )}
            </div>

            {topTraits.length > 0 && (
              <div className="tender-badges">
                <div className="tender-detail-label">Top Badges</div>

                <div className="tender-badge-grid">
                  {topTraits.map(([label, count], index) => (
                    <div
                      className={`tender-badge tender-badge-${index + 1}`}
                      key={label}
                    >
                      <div className="tender-badge-medallion">
                        <span className="tender-badge-rank">#{index + 1}</span>
                        <span className="tender-badge-star">★</span>
                      </div>

                      <div className="tender-badge-copy">
                        <strong>{label}</strong>
                        <span>
                          {count} {count === 1 ? "shout" : "shouts"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

      </div>
    </section>
  );
}
