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
              🏛️ Pillar 4 🏛️
            </div>

            <h1
              style={{
                marginTop: "8px",
                marginBottom: "8px",
              }}
            >
              Tender Tools
            </h1>

            <p
              className="lead-copy"
              style={{
                marginTop: 0,
              }}
            >
              Helping Tenders build stronger careers inside hospitality.
            </p>
          </div>

          <div
            style={{
              marginTop: "24px",
              lineHeight: 1.65,
            }}
          >
            <p>Tender Tools is the future professional-resource pillar of TenderFans. Its purpose is to give hospitality workers access to tools, information and opportunities that help them grow throughout their careers while allowing their Tender identity and community connections to move with them from Spot to Spot.</p>

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
                Future areas may include job opportunities, education, training, career resources, industry tools, professional discounts and partnerships that help Tenders grow and succeed.
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
