import { notFound } from "next/navigation";
import Link from "next/link";
import { bartenders } from "@/lib/mock-data";

export default async function TenderPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const b = bartenders.find(x => x.slug === slug);
  if (!b) notFound();
  return <section className="profile-page"><div className="shell profile-shell">
    <div className="profile-card bartender-profile">
      <div className="profile-photo">{b.photo ? <img src={b.photo} alt=""/> : <div className="photo-fallback large">{b.name[0]}</div>}</div>
      <div className="profile-copy"><div className="eyebrow">Tender profile</div><h1>{b.name} {b.claimed && <span className="check">✓</span>}</h1><Link href={`/s/${b.venueSlug}`} className="venue-link">{b.venueName} · {b.city}</Link><div className="cheer-number">{b.cheers.toLocaleString()} <span>Cheers</span></div>{b.bio ? <p className="bio">“{b.bio}”</p> : <p className="bio muted">This profile is community-added and waiting to be claimed.</p>}<div className="chips">{b.tags.map(t => <span className="chip" key={t}>{t}</span>)}</div><div className="profile-actions"><Link className="btn primary" href={`/shout?bartender=${b.slug}`}>Give {b.name} a Shout</Link>{!b.claimed && <Link href="/claim" className="btn outline">Is this you? Claim it</Link>}</div></div>
    </div>
    {b.claimed && <section className="gallery-section"><div className="section-title"><div><span className="eyebrow">Gallery</span><h2>From behind the bar.</h2></div></div><div className="gallery-empty">Claimed bartenders can add and manage their own gallery here. Public users cannot upload images.</div></section>}
  </div></section>;
}
