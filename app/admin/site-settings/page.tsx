import Link from "next/link";

const tools = [
  {
    title: "Global Spot Review",
    description:
      "Review pending Google Spots and website redirects across all Markets.",
    href: "/admin/site-settings/global-spot-review",
    status: "OPEN",
  },
  {
    title: "Global Adapter Errors",
    description:
      "Monitor active Tier One Adapter Errors across all Markets.",
    href: "/admin/site-settings/global-adapter-errors",
    status: "OPEN",
  },
  {
    title: "Site Banners",
    description:
      "Manage homepage hero and site-wide promotional banners.",
    href: null,
    status: "COMING SOON",
  },
  {
    title: "Global Events",
    description:
      "View and manage events across all Markets.",
    href: "/admin/events",
    status: "OPEN",
  },
];

export default function SiteSettingsPage() {
  return (
    <main className="flow-page">
      <div className="shell">
        <section
          className="flow-card"
          style={{ maxWidth: 1200, margin: "0 auto" }}
        >
          <Link href="/admin" className="text-link">
            ← Admin Dashboard
          </Link>

          <div
            className="eyebrow"
            style={{ marginTop: 24 }}
          >
            TENDERFANS GLOBAL ADMIN
          </div>

          <h1 style={{ marginBottom: 8 }}>
            Site Settings
          </h1>

          <p
            className="lead-copy"
            style={{ marginBottom: 24 }}
          >
            Cross-Market oversight and platform-wide
            administrative tools.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                "repeat(auto-fit, minmax(260px, 1fr))",
              gap: 18,
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
                      gap: 12,
                      marginBottom: 12,
                    }}
                  >
                    <h2
                      style={{
                        margin: 0,
                        fontSize: 20,
                      }}
                    >
                      {tool.title}
                    </h2>

                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 800,
                        letterSpacing: ".08em",
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

              const style = {
                display: "block",
                padding: 22,
                border: "1px solid #ddd7cc",
                borderRadius: 18,
                background: tool.href
                  ? "rgba(255,255,255,0.9)"
                  : "#f5f3ec",
                color: "inherit",
                textDecoration: "none",
                minHeight: 145,
                cursor: tool.href ? "pointer" : "default",
              };

              return tool.href ? (
                <Link
                  key={tool.title}
                  href={tool.href}
                  style={style}
                >
                  {content}
                </Link>
              ) : (
                <div key={tool.title} style={style}>
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
