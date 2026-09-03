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
    .slice(0, 5);

  return (
    <section className="profile-page">
      <div className="shell profile-shell">
        <div className="profile-card bartender-profile">
          <div className="profile-photo">
            <div className="photo-fallback large">{bartender.display_name[0]}</div>
          </div>

          <div className="profile-copy">
            <div className="eyebrow">Tender profile</div>
            <h1>{bartender.display_name}</h1>

            {venue && (
              <p>
                Current bartender at{" "}
                <Link href={`/s/${venue.slug}`}>{venue.name}</Link>
                {venue.city ? ` · ${venue.city}` : ""}
              </p>
            )}

            <div className="cheer-summary">
              <strong>
                {cheerCount ?? 0} {(cheerCount ?? 0) === 1 ? "Cheer" : "Cheers"}
              </strong>
            </div>

            {topTraits.length > 0 && (
              <div className="chips">
                {topTraits.map(([label, count]) => (
                  <span className="chip" key={label}>
                    {label} · {count}
                  </span>
                ))}
              </div>
            )}

            {bartender.bio ? (
              <p className="bio">{bartender.bio}</p>
            ) : (
              <p className="bio muted">
                This profile is community-added and waiting to be claimed.
              </p>
            )}

            <div className="profile-actions">
              <Link className="btn primary" href="/shout">
                Give {bartender.display_name} a Shout
              </Link>

              <Link href="/claim" className="btn outline">
                Is this you? Claim it
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
