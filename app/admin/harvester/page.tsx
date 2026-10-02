import Link from "next/link";

const tools = [
  {
    title: "Venue Matches",
    description:
      "Review unresolved event venues and provider venue matches that need administrator approval.",
    href: "/admin/venue-matches",
    status: "OPEN",
  },
  {
    title: "Calendar Image Adapter",
    description: "Manage event sources that require calendar-image extraction.",
    href: "/admin/harvester/calendar-images",
    status: "OPEN",
  },
  {
    title: "Facebook Adapter",
    description:
      "Review Spots where Facebook is the only potential event source currently detected.",
    href: "/admin/harvester/facebook",
    status: "OPEN",
  },
  {
    title: "Browser Required",
    description:
      "Review Spots whose event-source discovery requires browser execution.",
    href: "/admin/harvester/browser-required",
    status: "OPEN",
  },
  {
    title: "Transport Errors",
    description:
      "Review event sources blocked by transport or website-access failures.",
    href: "/admin/harvester/transport-errors",
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

          <h1 style={{ marginBottom: "8px" }}>Harvester Management</h1>

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
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: "18px",
            }}
          >
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
                      {tool.title}
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
