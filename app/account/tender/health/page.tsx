import Link from "next/link";

export default function Page() {
  return (
    <main
      className="flow-page"
      style={{
        paddingTop: "18px",
        paddingBottom: "24px",
      }}
    >
      <div
        className="shell narrow"
        style={{
          width: "100%",
          maxWidth: "680px",
        }}
      >
        <section
          className="flow-card"
          style={{
            paddingTop: "28px",
            paddingBottom: "28px",
          }}
        >
          <div
            style={{
              textAlign: "center",
            }}
          >
            <div className="eyebrow">TENDER SERVICES</div>

            <div
              style={{
                marginTop: "8px",
                fontSize: "0.72rem",
                fontWeight: 800,
                color: "#879d20",
                letterSpacing: ".05em",
              }}
            >
              🏛️ Pillar 1 🏛️
            </div>

            <h1
              style={{
                marginTop: "8px",
                marginBottom: "8px",
              }}
            >
              Tender Health
            </h1>

            <p
              className="lead-copy"
              style={{
                marginTop: 0,
              }}
            >
              Supporting the health and well-being of the people who make hospitality happen.
            </p>
          </div>

          <div
            style={{
              marginTop: "24px",
              lineHeight: 1.65,
            }}
          >
            <p>Tender Health is the future health and wellness pillar of TenderFans. Its purpose is to help bring hospitality workers together around resources and opportunities that can be difficult to access individually in an industry built around changing schedules, multiple workplaces and nontraditional employment. As the Tender community grows, TenderFans will explore partnerships and programs designed around the real needs of hospitality workers.</p>

            <div
              style={{
                marginTop: "24px",
                padding: "18px",
                border: "1px solid #ded8cc",
                borderRadius: "14px",
                background: "#faf8f3",
              }}
            >
              <div
                className="eyebrow"
                style={{ marginBottom: "8px" }}
              >
                COMING SOON
              </div>

              <strong>What we're building toward</strong>

              <p style={{ marginBottom: 0 }}>
                Future areas may include health and wellness resources, benefit opportunities, education, discounts and partnerships created specifically for the hospitality community.
              </p>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "center",
              marginTop: "24px",
            }}
          >
            <Link
              href="/account/tender"
              className="btn outline"
            >
              Back to Tender Account
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
