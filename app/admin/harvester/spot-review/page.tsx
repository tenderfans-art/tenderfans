import Link from "next/link";
import HttpRedirectPanel from "./HttpRedirectPanel";

export default function SpotReviewPage() {
  return (
    <main className="flow-page">
      <div className="shell">
        <section
          className="flow-card"
          style={{ maxWidth: 1200, margin: "0 auto" }}
        >
          <Link
            href="/admin/harvester"
            style={{
              display: "inline-block",
              marginBottom: 22,
              color: "inherit",
            }}
          >
            ← Harvester Management
          </Link>

          <div className="eyebrow">EVENT HARVESTER</div>
          <h1 style={{ marginBottom: 8 }}>Spot Review</h1>

          <p className="lead-copy" style={{ marginBottom: 24 }}>
            Review uncertain Spot identities and website redirects
            before returning approved Spots to source detection.
          </p>

          <HttpRedirectPanel />
        </section>
      </div>
    </main>
  );
}
