"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function ConfirmedContent() {
  const searchParams = useSearchParams();
  const isPartner = searchParams.get("partner") === "1";

  return (
    <section className="flow-page">
      <div className="shell narrow">
        <div className="flow-card">
          <div className="eyebrow">EMAIL VERIFIED</div>
          <h1>You’re verified.</h1>

          <p className="lead-copy">
            {isPartner
              ? "Your email has been confirmed. Sign in to continue creating your Partner profile."
              : "Your email has been confirmed. Sign in to continue your saved claim."}
          </p>

          <Link
            className="landing-action"
            href={isPartner ? "/partners/login" : "/login?claim=1"}
          >
            {isPartner
              ? "Continue to Partner Sign In"
              : "Continue to Sign In"}
          </Link>
        </div>
      </div>
    </section>
  );
}

export default function ConfirmedPage() {
  return (
    <Suspense fallback={null}>
      <ConfirmedContent />
    </Suspense>
  );
}
