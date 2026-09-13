import LandingHero from "@/components/LandingHero";
import TrendingTenders from "@/components/TrendingTenders";
import PopularSpots from "@/components/PopularSpots";
import PartnerHomeBanner from "@/components/PartnerHomeBanner";
import ActiveContestPopup from "@/components/ActiveContestPopup";

export default function Home() {
  return <>
    <ActiveContestPopup />
    <PartnerHomeBanner />

    <LandingHero />

    <TrendingTenders />

    <PopularSpots />

    <section className="manifesto">
      <div className="shell manifesto-inner">
        <img
          src="/cream-icon.png"
          alt=""
          className="manifesto-brand-icon"
          aria-hidden="true"
        />

        <div className="manifesto-copy">
          <span className="eyebrow light">
            The TenderFans rule
          </span>

          <h2>All stars. No Takedowns. Just Props</h2>

          <p>
            Fans contribute structured praise. Tenders and owners control their own bios and imagery.
          </p>
        </div>
      </div>
    </section>
  </>;
}
