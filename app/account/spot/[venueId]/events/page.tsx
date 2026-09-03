"use client";

import Link from "next/link";
import { use } from "react";

export default function Page({
  params,
}: {
  params: Promise<{ venueId: string }>;
}) {
  const { venueId } = use(params);

  return (
    <main className="flow-page">
      <div className="shell">
        <section className="flow-card">
          <div className="eyebrow">SPOT EVENTS</div>
          <h1>Events are coming soon.</h1>

          <p className="lead-copy">
            Approved events will appear here automatically from the TenderFans
            site-wide calendar.
          </p>

          <p className="muted-copy">
            Event submission and approval tools are planned for a future
            release.
          </p>

          <div style={{ marginTop: 24 }}>
            <Link
              href="/account/spot"
              className="button secondary-button"
            >
              Back to Spot Owner Account
            </Link>
          </div>

          <div style={{ marginTop: 12 }}>
            <Link href={`/s/${venueId}`} style={{ display: "none" }}>
              View Spot
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
