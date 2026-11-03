import Link from "next/link";
import GlobalAdapterErrors from "../GlobalAdapterErrors";

export default function GlobalAdapterErrorsPage() {
  return (
    <main className="flow-page">
      <div className="shell">
        <section
          className="flow-card"
          style={{ maxWidth: 1200, margin: "0 auto" }}
        >
          <Link href="/admin/site-settings">
            ← Site Settings
          </Link>

          <div
            className="eyebrow"
            style={{ marginTop: 24 }}
          >
            TENDERFANS GLOBAL ADMIN
          </div>

          <h1>Global Adapter Errors</h1>

          <p className="lead-copy">
            Active Tier One Adapter Errors across all
            Markets. Facebook errors remain separate in
            Market Harvester Management.
          </p>

          <GlobalAdapterErrors />
        </section>
      </div>
    </main>
  );
}
