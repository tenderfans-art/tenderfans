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
              🏛️ Pillar 3 🏛️
            </div>

            <h1
              style={{
                marginTop: "8px",
                marginBottom: "8px",
              }}
            >
              Tender Families
            </h1>

            <p
              className="lead-copy"
              style={{
                marginTop: 0,
              }}
            >
              Because hospitality life doesn't end when the shift does.
            </p>
          </div>

          <div
            style={{
              marginTop: "24px",
              lineHeight: 1.65,
            }}
          >
            <p>Tender Families is the future family-resource pillar of TenderFans. Hospitality schedules can make everyday family needs harder to navigate, particularly when traditional services are designed around traditional working hours. This pillar will explore resources and partnerships that can make life outside the shift easier for Tenders and their families.</p>

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
                Future areas may include family resources, childcare-related partnerships, discounts, community programs and services that better reflect the schedules and needs of hospitality households.
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
