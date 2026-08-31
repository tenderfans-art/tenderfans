import Link from "next/link";
import LandingHero from "@/components/LandingHero";
import HomeSearch from "@/components/HomeSearch";
import BartenderCard from "@/components/BartenderCard";
import VenueVisual from "@/components/VenueVisual";
import { bartenders, venues } from "@/lib/mock-data";

export default function Home() {
  return <>
    <LandingHero />

    <section className="home-search-section">
      <div className="shell home-search-inner">
        <div>
          <span className="eyebrow">Search TenderFans</span>
          <h2>Find a tender, spot or city.</h2>
        </div>
        <HomeSearch />
      </div>
    </section>

    <section className="section">
      <div className="shell">
        <div className="section-title"><div><span className="eyebrow">Trending Tenders</span><h2>People worth knowing behind the bar.</h2></div><Link href="/shout" className="text-link">Shout someone out →</Link></div>
        <div className="person-grid">{bartenders.map(b => <BartenderCard bartender={b} key={b.id}/>)}</div>
      </div>
    </section>

    <section className="section soft">
      <div className="shell">
        <div className="section-title"><div><span className="eyebrow">Popular Spots</span><h2>Where people keep finding great hospitality.</h2></div></div>
        <div className="spot-grid">{venues.map(v => <Link href={`/s/${v.slug}`} className="spot-card" key={v.id}><VenueVisual venue={v}/><div className="spot-copy"><div className="card-row"><h3>{v.name}</h3><strong>{v.cheers.toLocaleString()} Cheers</strong></div><p>{v.type} · {v.city}</p><span className="status-pill">{v.claimed ? "✓ Claimed Spot" : "Community Added"}</span></div></Link>)}</div>
      </div>
    </section>

    <section className="manifesto"><div className="shell manifesto-inner"><span className="brand-mark big">T</span><div><span className="eyebrow light">The TenderFans rule</span><h2>No stars. No takedowns. Just props.</h2><p>Fans contribute structured praise. Bartenders and owners control their own bios and imagery.</p></div></div></section>
  </>;
}
