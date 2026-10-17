"use client";

import Link from "next/link";
import { useState } from "react";
import HttpRedirectPanel from "./HttpRedirectPanel";
import GoogleSpotsPanel from "./GoogleSpotsPanel";

type Tab = "redirect" | "google";

const tabs: { id: Tab; label: string }[] = [
  { id: "redirect", label: "Website Redirects" },
  { id: "google", label: "Google Spots" },
];

export default function SpotReviewPage() {
  const [activeTab, setActiveTab] = useState<Tab>("redirect");

  return (
    <main className="flow-page">
      <div className="shell">
        <section
          className="flow-card"
          style={{ maxWidth: 1200, margin: "0 auto" }}
        >
          <Link
            href="/admin/harvester"
            style={{
              display: "inline-block",
              marginBottom: 22,
              color: "inherit",
            }}
          >
            ← Harvester Management
          </Link>

          <div className="eyebrow">EVENT HARVESTER</div>
          <h1 style={{ marginBottom: 8 }}>Spot Review</h1>

          <p className="lead-copy" style={{ marginBottom: 24 }}>
            Review website redirects and uncertain publisher identities
            before returning approved Spots to source detection.
          </p>

          <div
            role="tablist"
            aria-label="Spot review categories"
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              borderBottom: "1px solid rgba(20,35,45,.15)",
              paddingBottom: 12,
              marginBottom: 24,
            }}
          >
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  padding: "10px 16px",
                  borderRadius: 8,
                  border: "1px solid rgba(20,35,45,.15)",
                  background:
                    activeTab === tab.id ? "#263b32" : "transparent",
                  color: activeTab === tab.id ? "#fff" : "inherit",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div role="tabpanel">
            {activeTab === "redirect" && <HttpRedirectPanel />}
            {activeTab === "google" && <GoogleSpotsPanel />}
          </div>
        </section>
      </div>
    </main>
  );
}
