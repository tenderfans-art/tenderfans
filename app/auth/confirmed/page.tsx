"use client";

import Link from "next/link";

export default function ConfirmedPage() {
  return (
    <section className="flow-page">
      <div className="shell narrow">
        <div className="flow-card">
          <div className="eyebrow">EMAIL VERIFIED</div>
          <h1>You’re verified.</h1>
          <p className="lead-copy">
            Your email has been confirmed. Sign in to continue your saved claim.
          </p>
          <Link className="landing-action" href="/login?claim=1">
            Continue to Sign In
          </Link>
        </div>
      </div>
    </section>
  );
}
