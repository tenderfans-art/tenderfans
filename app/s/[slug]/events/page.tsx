import Link from "next/link";

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  return (
    <main className="flow-page">
      <div className="shell">
        <section className="flow-card">
          <div className="eyebrow">SPOT EVENTS</div>
          <h1>Events are coming soon.</h1>

          <p className="lead-copy">
            Approved events for this Spot will appear here automatically from the TenderFans calendar in a future release.
          </p>

          <div style={{ marginTop: 24 }}>
            <Link href={`/s/${slug}`} className="button secondary-button">
              Back to Spot Profile
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
