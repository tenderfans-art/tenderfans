import LandingHero from "@/components/LandingHero";
import TrendingTenders from "@/components/TrendingTenders";
import PopularSpots from "@/components/PopularSpots";

export default function Home() {
  return <>
    <LandingHero />

    <TrendingTenders />

    <PopularSpots />

    <section className="manifesto"><div className="shell manifesto-inner"><span className="brand-mark big">T</span><div><span className="eyebrow light">The TenderFans rule</span><h2>All stars. No Takedowns. Just Props</h2><p>Fans contribute structured praise. Bartenders and owners control their own bios and imagery.</p></div></div></section>
  </>;
}
