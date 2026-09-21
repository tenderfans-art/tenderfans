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
              🏛️ Pillar 2 🏛️
            </div>

            <h1
              style={{
                marginTop: "8px",
                marginBottom: "8px",
              }}
            >
              Tender Money
            </h1>

            <p
              className="lead-copy"
              style={{
                marginTop: 0,
              }}
            >
              Turning a larger hospitality community into greater financial opportunity.
            </p>
          </div>

          <div
            style={{
              marginTop: "24px",
              lineHeight: 1.65,
            }}
          >
            <p>Tender Money is the future financial-resource pillar of TenderFans. Its purpose is to help hospitality workers gain access to useful financial education, services, savings opportunities and benefits while exploring the collective purchasing power that comes from bringing a fragmented workforce together as one community.</p>

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
                Future areas may include financial education, savings programs, industry discounts, financial-service partnerships and other opportunities created through the collective strength of the Tender community.
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
