"use client";

import { useEffect, useState } from "react";

const DISMISS_KEY = "tf_partner_banner_hidden_v1";

export default function PartnerHomeBanner() {
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    const dismissed = localStorage.getItem(DISMISS_KEY) === "1";
    setHidden(dismissed);
  }, []);

  function dismissBanner() {
    localStorage.setItem(DISMISS_KEY, "1");
    setHidden(true);
  }

  if (hidden) return null;

  return (
    <section className="partner-home-banner">
      <div className="shell partner-home-banner-inner">
        <span>
          Promoters &amp; Brand Reps — bring your events to TenderFans.
        </span>

        <div className="partner-home-banner-links">
          <a href="/partners/login">Partner Login</a>
          <a href="/partners">About Partners</a>
        </div>

        <button
          type="button"
          className="partner-banner-close"
          aria-label="Hide partner banner"
          onClick={dismissBanner}
        >
          ×
        </button>
      </div>
    </section>
  );
}
