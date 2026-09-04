import Link from "next/link";

export default function FanPage() {
  return (
    <section className="flow-page">
      <div className="shell narrow">
        <div className="flow-card">
          <div className="eyebrow">Fan</div>
          <h1>What would you like to do?</h1>

          <div className="claim-grid">
            <Link className="claim-card" href="/shout">
              <strong>Give a Shout</strong>
              <span>Show some love to a great Tender.</span>
            </Link>

            <Link className="claim-card" href="/discover">
              <strong>Find a Spot</strong>
              <span>Search bars, Tenders, or cities.</span>
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
