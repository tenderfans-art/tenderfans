import { notFound } from "next/navigation";
import Link from "next/link";
import VenueVisual from "@/components/VenueVisual";
import BartenderCard from "@/components/BartenderCard";
import { bartenders, venues } from "@/lib/mock-data";

export default async function SpotPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const v = venues.find(x => x.slug === slug);
  if (!v) notFound();
  const team = bartenders.filter(b => b.venueSlug === v.slug);
  return <section className="profile-page"><div className="shell profile-shell">
    <div className="venue-profile-visual"><VenueVisual venue={v}/></div>
    <div className="venue-profile-copy"><div className="eyebrow">{v.claimed ? "✓ Claimed Spot" : "Community Added"}</div><h1>{v.name}</h1><p className="venue-meta">{v.type} · {v.city}, {v.state}</p><p className="address">{v.address}</p><div className="cheer-number">{v.cheers.toLocaleString()} <span>Cheers</span></div>{v.bio && <p className="bio">{v.bio}</p>}<div className="profile-actions"><Link className="btn primary" href={`/shout?venue=${v.slug}`}>Shout out a Tender here</Link>{!v.claimed && <Link className="btn outline" href="/claim">Own or manage this spot?</Link>}</div></div>
    <section className="subsection full"><div className="section-title"><div><span className="eyebrow">Behind the bar</span><h2>Tenders at {v.name}</h2></div></div>{team.length ? <div className="person-grid">{team.map(b => <BartenderCard bartender={b} key={b.id}/>)}</div> : <div className="gallery-empty">No bartender profiles yet. Be the first to give someone here a shout.</div>}</section>
    {v.claimed && <section className="subsection full"><div className="section-title"><div><span className="eyebrow">Gallery</span><h2>Inside {v.name}</h2></div></div><div className="gallery-empty">Business owners can upload and arrange their own gallery. Public users cannot upload images.</div></section>}
    <section className="future-strip full"><span>Coming later:</span><b>Events</b><b>Menus</b><b>Specials</b><b>Products</b><b>Awards</b></section>
  </div></section>;
}
