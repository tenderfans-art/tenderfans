"use client";

import Link from "next/link";
import { useState } from "react";
import CalendarImagePanel from "./CalendarImagePanel";
import SourceOwnershipPanel from "./SourceOwnershipPanel";

type Tab = "calendar" | "ownership";

const tabs: { id: Tab; label: string }[] = [
  { id: "calendar", label: "Calendar Image" },
  { id: "ownership", label: "HTML Source" },
];

export default function SourceReviewPage() {
  const [activeTab, setActiveTab] = useState<Tab>("calendar");

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
              color: "inherit"
            }}
          >
            ← Harvester Management
          </Link>

          <div className="eyebrow">EVENT HARVESTER</div>
          <h1 style={{ marginBottom: 8 }}>Source Review</h1>

          <p className="lead-copy" style={{ marginBottom: 24 }}>
            Review discovered calendar and HTML sources, including ownership
            conflicts, before validation and harvesting.
          </p>

          <div
            role="tablist"
            aria-label="Source review categories"
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              borderBottom: "1px solid rgba(20,35,45,.15)",
              paddingBottom: 12,
              marginBottom: 24
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
                  cursor: "pointer"
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div role="tabpanel">
            {activeTab === "calendar" && <CalendarImagePanel />}
            {activeTab === "ownership" && <SourceOwnershipPanel />}
          </div>
        </section>
      </div>
    </main>
  );
}
