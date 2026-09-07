import LandingHero from "@/components/LandingHero";
import TrendingTenders from "@/components/TrendingTenders";
import PopularSpots from "@/components/PopularSpots";

export default function Home() {
  return <>
    <LandingHero />

    <section className="partner-home-banner">
      <div className="shell partner-home-banner-inner">
        <span>
          Promoters &amp; Brand Reps — bring your events to TenderFans.
        </span>

        <div className="partner-home-banner-links">
          <a href="/partners/login">Partner Login</a>
          <a href="/partners">About Partners</a>
        </div>
      </div>
    </section>

    <TrendingTenders />

    <PopularSpots />

    <section className="manifesto"><div className="shell manifesto-inner"><span className="brand-mark big">T</span><div><span className="eyebrow light">The TenderFans rule</span><h2>All stars. No Takedowns. Just Props</h2><p>Fans contribute structured praise. Bartenders and owners control their own bios and imagery.</p></div></div></section>
  </>;
}
