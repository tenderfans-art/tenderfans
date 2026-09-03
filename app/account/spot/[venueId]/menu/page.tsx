"use client";

import Link from "next/link";
import { use } from "react";
import SpotMediaGallery from "@/components/spot/SpotMediaGallery";

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
          <div className="eyebrow">SPOT MEDIA</div>
          <h1>Menus</h1>

          <p className="lead-copy">
            Upload and manage menu images and PDFs.
          </p>

          <SpotMediaGallery
            venueId={venueId}
            mediaType="menu"
          />

          <div style={{ marginTop: "24px" }}>
            <Link href="/account/spot">
              ← Back to Spot Owner Account
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
