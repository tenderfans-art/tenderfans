import Link from "next/link";

export default function HowItWorksPage() {
  return (
    <main className="flow-page">
      <div className="shell how-it-works-page">

        <section className="how-hero">
          <span className="eyebrow">How TenderFans Works</span>
          <h1>Great hospitality deserves a shout.</h1>
          <p>
            TenderFans is built around a simple idea: recognize the people
            and places that make going out memorable — without turning it
            into another review site.
          </p>
        </section>

        <section className="how-steps">

          <div className="how-step">
            <span className="how-number">01</span>
            <div>
              <h2>Find your spot.</h2>
              <p>
                Search for the bar, brewery, restaurant or other hospitality
                spot where somebody made your experience better.
              </p>
            </div>
          </div>

          <div className="how-step">
            <span className="how-number">02</span>
            <div>
              <h2>Find your Tender.</h2>
              <p>
                Choose the bartender who deserves the recognition. If they're
                new to TenderFans, you can help get their profile started.
              </p>
            </div>
          </div>

          <div className="how-step">
            <span className="how-number">03</span>
            <div>
              <h2>Give them a Shout.</h2>
              <p>
                Tell the community what they do well using positive traits
                and a shout style. No anonymous rants. No comment section.
                Just recognition for great hospitality.
              </p>
            </div>
          </div>

          <div className="how-step">
            <span className="how-number">04</span>
            <div>
              <h2>Build a reputation.</h2>
              <p>
                Shouts add up. Over time, they show what each Tender is known
                for and help people discover the personalities behind their
                favorite spots.
              </p>
            </div>
          </div>

        </section>

        <section className="how-why">
          <span className="eyebrow">Why TenderFans?</span>
          <h2>People are more than a star rating.</h2>
          <p>
            Traditional review sites usually rate the business. TenderFans
            puts the spotlight on the people creating the experience.
          </p>
          <p>
            Bartenders can claim their profiles, add their own bio and
            imagery, and build a presence around the reputation their guests
            are already creating.
          </p>
          <p>
            Establishments benefit too. Great people help great spots get
            discovered.
          </p>
        </section>

        <section className="how-rule">
          <span className="eyebrow light">The TenderFans Rule</span>
          <h2>ALL stars. No takedowns. Just props.</h2>
          <p>
            TenderFans is for celebrating great hospitality — not tearing
            people down.
          </p>
        </section>

        <section className="how-actions">
          <h2>Someone deserve a Shout?</h2>
          <p>Give them their props.</p>

          <div className="how-buttons">
            <Link href="/shout" className="btn primary">
              Give a Shout
            </Link>

            <Link href="/discover" className="btn outline">
              Discover TenderFans
            </Link>
          </div>
        </section>

      </div>
    </main>
  );
}
