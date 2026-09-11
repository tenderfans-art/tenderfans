import ShoutFlow from "@/app/shout/ShoutFlow";

export default async function ContestTenderPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  return (
    <section className="flow-page">
      <div className="shell narrow">
        <ShoutFlow initialTenderSlug={slug} />
      </div>
    </section>
  );
}
