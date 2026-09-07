import Link from "next/link";

export default function PartnersPage() {
  return (
    <main className="flow-page">
      <div className="shell narrow">
        <div className="flow-card partner-info-card">
          <div className="eyebrow">TenderFans Partners</div>

          <h1>Promote the night. Support the Spots.</h1>

          <p className="lead-copy">
            Partner profiles are built for event promoters and liquor or
            brand representatives who work with local Spots.
          </p>

          <div className="partner-about-grid">
            <div className="partner-about-item">
              <strong>Event Promoters</strong>
              <span>
                Create a verified Partner profile and submit events taking
                place at participating Spots.
              </span>
            </div>

            <div className="partner-about-item">
              <strong>Liquor &amp; Brand Reps</strong>
              <span>
                Create a professional Partner presence and submit approved
                events connected to the Spots and brands you represent.
              </span>
            </div>
          </div>

          <div className="privacy-note partner-verification-note">
            Partner profiles are verified before access is granted. Events
            submitted by Partners must be confirmed by the hosting Spot and
            approved by TenderFans before appearing on the public calendar.
          </div>

          <div className="partner-page-actions">
            <Link className="landing-action" href="/partners/login?mode=create">
              Create Partner Account
            </Link>

            <Link className="landing-action secondary" href="/partners/login">
              Partner Login
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
