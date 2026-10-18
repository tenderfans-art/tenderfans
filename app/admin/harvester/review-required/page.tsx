import Link from "next/link";

const tools = [
  {
    title: "Spot Review",
    description: "Review Spot identities, redirects and Google Places matches.",
    href: "/admin/harvester/spot-review",
  },
  {
    title: "Source Review",
    description: "Review calendar and HTML source ownership.",
    href: "/admin/harvester/source-review",
  },
  {
    title: "Event Review",
    description: "Review uncertain harvested events before publication.",
    href: "/admin/venue-matches",
  },
];

export default function ReviewRequiredPage() {
  return (
    <main
      style={{
        maxWidth: "1300px",
        margin: "0 auto",
        padding: "24px 36px 60px",
      }}
    >
      <Link href="/admin/harvester" style={{ color: "inherit" }}>
        ← Harvester Management
      </Link>

      <div style={{ margin: "24px 0 40px" }}>
        <div
          style={{
            color: "#82951c",
            fontSize: "0.75rem",
            fontWeight: 800,
            letterSpacing: "0.16em",
          }}
        >
          TENDERFANS ADMIN
        </div>
        <h1 style={{ margin: "4px 0 12px", fontSize: "2.25rem" }}>
          Review Required
        </h1>
        <p style={{ margin: 0, color: "#68747b", fontSize: "1.1rem" }}>
          Review Spot identities, event sources, and harvested events.
        </p>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: "18px",
        }}
      >
        {tools.map((tool) => (
          <Link
            key={tool.title}
            href={tool.href}
            style={{
              display: "block",
              padding: "22px",
              border: "1px solid rgba(20, 35, 45, 0.12)",
              borderRadius: "18px",
              background: "rgba(255,255,255,0.9)",
              textDecoration: "none",
              color: "inherit",
              minHeight: "145px",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: "12px",
                marginBottom: "12px",
              }}
            >
              <h2 style={{ margin: 0, fontSize: "1.25rem" }}>
                {tool.title}
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
              {tool.description}
            </p>
          </Link>
        ))}
      </div>
    </main>
  );
}
