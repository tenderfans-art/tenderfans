import Link from "next/link";

export default function ClaimSubmittedPage() {
  return (
    <section className="flow-page login-page">
      <div className="shell narrow">
        <div className="flow-card login-card">
          <div className="eyebrow">
            SPOT CLAIM SUBMITTED
          </div>

          <h1>You're all set.</h1>

          <p className="lead-copy">
            Your email has been verified and your Spot ownership
            claim has been sent to TenderFans for verification.
          </p>

          <Link
            className="landing-action"
            href="/account"
          >
            Continue to Account
          </Link>
        </div>
      </div>
    </section>
  );
}
