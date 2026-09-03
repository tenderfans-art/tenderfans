import Link from "next/link";

const tools = [
  {
    title: "Verification Requests",
    description: "Review pending Tender and Spot ownership claims.",
    href: "/admin/claims",
    status: "OPEN",
  },
  {
    title: "Manage Spots",
    description: "Search, edit, hide or remove venue profiles.",
    href: null,
    status: "COMING SOON",
  },
  {
    title: "Manage Tenders",
    description: "Search, edit, hide or remove bartender profiles.",
    href: null,
    status: "COMING SOON",
  },
  {
    title: "Events",
    description: "Add and manage events for the TenderFans calendar.",
    href: null,
    status: "COMING SOON",
  },
  {
    title: "Site Banners",
    description: "Quickly change hero and banner images across the site.",
    href: null,
    status: "COMING SOON",
  },
  {
    title: "Site Settings",
    description: "Platform controls and future administrative tools.",
    href: null,
    status: "COMING SOON",
  },
];

export default function AdminPage() {
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
          <div className="eyebrow">TENDERFANS ADMIN</div>

          <h1 style={{ marginBottom: "8px" }}>
            Admin Dashboard
          </h1>

          <p
            className="lead-copy"
            style={{
              marginTop: 0,
              marginBottom: "32px",
            }}
          >
            Manage the people, places and activity that power TenderFans.
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
                <Link
                  key={tool.title}
                  href={tool.href}
                  style={cardStyle}
                >
                  {content}
                </Link>
              ) : (
                <div
                  key={tool.title}
                  style={cardStyle}
                >
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
