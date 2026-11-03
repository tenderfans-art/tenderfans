"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import CoverageTally from "./CoverageTally";
import BucketCount from "./BucketCount";

const reviewTools = [
  {
    title: "Spot Review",
    description: "Spot identities, redirects and Google Places matches.",
    href: "/admin/harvester/spot-review",
  },
  {
    title: "Source Review",
    description: "Calendar and HTML source ownership.",
    href: "/admin/harvester/source-review",
  },
  {
    title: "Event Review",
    description: "Uncertain harvested events before publication.",
    href: "/admin/venue-matches",
  },
];

const tools = [
  {
    title: "Archive",
    countRpc: null,
    description:
      "Archived Spots organized by city for monthly detector rechecks.",
    href: "/admin/harvester/archive",
    status: "OPEN",
  },
  {
    title: "Adapter Errors",
    countRpc: "admin_event_harvest_adapter_error_findings",
    description:
      "Interrupted source and adapter evaluations requiring troubleshooting.",
    href: "/admin/harvester/adapter-errors",
    status: "OPEN",
  },
  {
    title: "Challenge Encountered",
    countRpc: "admin_event_harvest_challenge_findings",
    description:
      "Review CAPTCHA and automated-access challenges.",
    href: "/admin/harvester/challenge-encountered",
    status: "OPEN",
  },
  {
    title: "Transport Errors",
    countRpc: "admin_event_harvest_transport_findings",
    description:
      "Review Spots whose websites could not be accessed during discovery.",
    href: "/admin/harvester/transport-errors",
    status: "OPEN",
  },
  {
    title: "No Sources",
    countRpc: "admin_event_harvest_no_source_findings",
    description:
      "Review Spots where discovery found no event source.",
    href: "/admin/harvester/no-source",
    status: "OPEN",
  },
];

type MarketScope = {
  market: {
    id: string;
    market_key: string;
    display_name: string;
    is_enabled: boolean;
  };
  venueIds: string[];
};

export default function HarvesterDashboard({
  marketKey,
}: {
  marketKey: string;
}) {
  const [scope, setScope] = useState<MarketScope | null>(null);
  const [scopeError, setScopeError] = useState("");

  useEffect(() => {
    if (!marketKey) return;

    let active = true;

    async function loadScope() {
      try {
        const { data: { session } } =
          await supabase.auth.getSession();

        if (!session) {
          throw new Error("Administrator sign-in required.");
        }

        const response = await fetch(
          `/api/admin/markets/harvester-scope?market=${encodeURIComponent(marketKey)}`,
          {
            headers: {
              Authorization: `Bearer ${session.access_token}`,
            },
            cache: "no-store",
          }
        );

        const payload = await response.json();

        if (!response.ok) {
          throw new Error(
            payload.error || "Unable to load Market."
          );
        }

        if (active) setScope(payload as MarketScope);
      } catch (error) {
        if (active) {
          setScopeError(
            error instanceof Error
              ? error.message
              : "Unable to load Market."
          );
        }
      }
    }

    void loadScope();

    return () => { active = false; };
  }, [marketKey]);

  const scopedHref = (href: string) =>
    marketKey
      ? `${href}${href.includes("?") ? "&" : "?"}market=${encodeURIComponent(marketKey)}`
      : href;

  if (marketKey && (scopeError || !scope)) {
    return (
      <main className="flow-page">
        <div className="shell">
          <section className="flow-card">
            {scopeError
              ? <p role="alert">{scopeError}</p>
              : <p>Loading Market Harvester Management...</p>}
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="flow-page">
      <div className="shell">
        <section
          className="flow-card"
          style={{
            maxWidth: "1200px",
            margin: "0 auto",
          }}
        >
          <Link
            href={marketKey
              ? `/admin/markets/${encodeURIComponent(marketKey)}`
              : "/admin"}
            style={{
              display: "inline-block",
              marginBottom: "22px",
              color: "inherit",
            }}
          >
            ← Admin Dashboard
          </Link>

          <div className="eyebrow">
            {scope
              ? `TENDERFANS MARKET · ${scope.market.display_name}`
              : "TENDERFANS ADMIN"}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "16px",
              flexWrap: "wrap",
              marginBottom: "8px",
            }}
          >
            <h1 style={{ margin: 0 }}>Harvester Management</h1>
            {scope
              ? <strong style={{ fontSize: "0.85rem" }}>
                  {scope.venueIds.length} assigned Spots
                </strong>
              : <CoverageTally />}
          </div>

          <p
            className="lead-copy"
            style={{
              marginTop: 0,
              marginBottom: "32px",
            }}
          >
            Review Event Harvester exceptions, adapters and source issues.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
              gap: "18px",
            }}
          >
            <Link
            href={scopedHref("/admin/harvester/review-required")}
            style={{
              display: "block",
              padding: "22px",
              border: "1px solid rgba(20, 35, 45, 0.12)",
              borderRadius: "18px",
              background: "rgba(255,255,255,0.9)",
              textDecoration: "none",
              color: "inherit",
              minHeight: "145px",
              cursor: "pointer",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: "12px",
                marginBottom: "12px",
              }}
            >
              <h2 style={{ margin: 0, fontSize: "1.25rem" }}>
                Review Required
              </h2>
              <span
                style={{
                  fontSize: "0.68rem",
                  fontWeight: 800,
                  letterSpacing: "0.08em",
                }}
              >
                OPEN
              </span>
            </div>
            <p style={{ margin: 0, lineHeight: 1.55, opacity: 0.75 }}>
              Review Spot identities, event-source ownership, and
              harvested events awaiting approval.
            </p>
          </Link>

          {tools.map((tool) => {
              const content = (
                <>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      gap: "12px",
                      marginBottom: "12px",
                    }}
                  >
                    <h2
                      style={{
                        margin: 0,
                        fontSize: "1.25rem",
                      }}
                    >
                      {tool.title}{tool.countRpc && <BucketCount
                        rpc={tool.countRpc}
                        marketVenueIds={scope?.venueIds}
                      />}
                    </h2>

                    <span
                      style={{
                        fontSize: "0.68rem",
                        fontWeight: 800,
                        letterSpacing: "0.08em",
                        whiteSpace: "nowrap",
                        opacity: tool.href ? 1 : 0.55,
                      }}
                    >
                      {tool.status}
                    </span>
                  </div>

                  <p
                    style={{
                      margin: 0,
                      lineHeight: 1.55,
                      opacity: 0.75,
                    }}
                  >
                    {tool.description}
                  </p>
                </>
              );

              const cardStyle = {
                display: "block",
                padding: "22px",
                border: "1px solid rgba(20, 35, 45, 0.12)",
                borderRadius: "18px",
                background: tool.href
                  ? "rgba(255,255,255,0.9)"
                  : "rgba(245,243,236,0.65)",
                textDecoration: "none",
                color: "inherit",
                minHeight: "145px",
                cursor: tool.href ? "pointer" : "default",
              };

              return tool.href ? (
                <Link key={tool.title} href={scopedHref(tool.href)} style={cardStyle}>
                  {content}
                </Link>
              ) : (
                <div key={tool.title} style={cardStyle}>
                  {content}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
