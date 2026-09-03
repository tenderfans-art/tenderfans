import { notFound } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase";

export default async function TenderPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const { data: bartender } = await supabase
    .from("bartenders")
    .select("id, slug, display_name, bio, status")
    .eq("slug", slug)
    .eq("status", "active")
    .single();

  if (!bartender) notFound();

  const { data: relationship } = await supabase
    .from("bartender_venues")
    .select("venue_id")
    .eq("bartender_id", bartender.id)
    .eq("is_current", true)
    .eq("is_primary", true)
    .maybeSingle();

  let venue = null;

  if (relationship?.venue_id) {
    const { data } = await supabase
      .from("venues")
      .select("name, slug, city")
      .eq("id", relationship.venue_id)
      .single();

    venue = data;
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
    .select("*", { count: "exact", head: true })
    .eq("bartender_id", bartender.id)
    .eq("status", "published");

  const { data: traitRows } = await supabase
    .from("shoutout_traits")
    .select("trait_id, traits(label), shoutouts!inner(bartender_id,status)")
    .eq("shoutouts.bartender_id", bartender.id)
    .eq("shoutouts.status", "published");

  const traitCounts = new Map<string, number>();

  for (const row of traitRows ?? []) {
    const label = (row.traits as any)?.label;
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

          <div className="tender-profile-copy">
            <h1>{bartender.display_name}</h1>

            {venue && (
              <p className="tender-current-spot">
                Current Tender at{" "}
                <Link href={`/s/${venue.slug}`}>{venue.name}</Link>
                {venue.city ? ` · ${venue.city}` : ""}
              </p>
            )}

            <div className="tender-cheers-inline">
              <strong>{cheerCount ?? 0}</strong>
              <span>
                {(cheerCount ?? 0) === 1 ? "Cheer" : "Cheers"}
              </span>
            </div>

            {bartender.bio ? (
              <p className="bio">{bartender.bio}</p>
            ) : (
              <p className="bio muted">
                This profile is community-added and waiting to be claimed.
              </p>
            )}
          </div>
        </div>

        {topTraits.length > 0 && (
          <div className="tender-reputation-strip">
            <span className="tender-reputation-label">Top Shouts</span>

            <div className="tender-traits">
              {topTraits.map(([label, count]) => (
                <span className="chip" key={label}>
                  {label} · {count}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="tender-shout-action">
          <Link className="btn primary" href="/shout">
            Give {bartender.display_name} a Shout
          </Link>
        </div>

      </div>
    </section>
  );
}
