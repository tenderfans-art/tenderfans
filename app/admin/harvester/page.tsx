import Link from "next/link";
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
    title: "Calendar Images",
    countRpc: "admin_event_harvest_calendar_image_findings",
    description:
      "Review event calendars published as images.",
    href: "/admin/harvester/calendar-images",
    status: "OPEN",
  },
  {
    title: "HTML Errors",
    countRpc: "admin_event_harvest_html_error_findings",
    description:
      "Review HTML event sources with failed or incomplete event extraction.",
    href: "/admin/harvester/html-errors",
    status: "OPEN",
  },
  {
    title: "Facebook Adapter",
    countRpc: "admin_event_harvest_facebook_findings",
    description:
      "Review Spots where Facebook is the only potential event source currently detected.",
    href: "/admin/harvester/facebook",
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
      "Review transport and website-access failures.",
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

export default function AdminHarvesterPage() {
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
            href="/admin"
            style={{
              display: "inline-block",
              marginBottom: "22px",
              color: "inherit",
            }}
          >
            ← Admin Dashboard
          </Link>

          <div className="eyebrow">TENDERFANS ADMIN</div>

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
            <CoverageTally />
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
            <details
              style={{
                padding: "22px",
                border: "1px solid rgba(20, 35, 45, 0.12)",
                borderRadius: "18px",
                background: "rgba(255,255,255,0.9)",
                minHeight: "145px",
                alignSelf: "start",
              }}
            >
              <summary
                style={{
                  cursor: "pointer",
                  fontSize: "1.25rem",
                  fontWeight: 700,
                  marginBottom: "12px",
                }}
              >
                Review Required
              </summary>

              <p
                style={{
                  margin: 0,
                  lineHeight: 1.55,
                  opacity: 0.75,
                }}
              >
                Review Spot identities, source ownership and event attribution.
              </p>

              <div
                style={{
                  display: "grid",
                  gap: "10px",
                  marginTop: "18px",
                }}
              >
                {reviewTools.map((tool) => (
                  <Link
                    key={tool.title}
                    href={tool.href}
                    style={{
                      display: "block",
                      padding: "12px",
                      border: "1px solid rgba(20, 35, 45, 0.12)",
                      borderRadius: "10px",
                      background: "rgba(245,243,236,0.65)",
                      textDecoration: "none",
                      color: "inherit",
                    }}
                  >
                    <strong style={{ display: "block", marginBottom: "5px" }}>
                      {tool.title}
                    </strong>
                    <span style={{ fontSize: ".8rem", opacity: 0.75 }}>
                      {tool.description}
                    </span>
                  </Link>
                ))}
              </div>
            </details>

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
                      {tool.title}{tool.countRpc && <BucketCount rpc={tool.countRpc} />}
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
                <Link key={tool.title} href={tool.href} style={cardStyle}>
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
