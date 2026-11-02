import { redirect } from "next/navigation";
import ShoutFlow from "@/app/shout/ShoutFlow";
import { supabase } from "@/lib/supabase";

export default async function ContestTenderPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ contest?: string }>;
}) {
  const { slug } = await params;
  const { contest: contestId } = await searchParams;
  const now = new Date().toISOString();

  let contestQuery = supabase
    .from("contests")
    .select("id")
    .eq("is_active", true)
    .eq("contest_format", "shouts")
    .lte("starts_at", now)
    .gte("ends_at", now);

  if (contestId) {
    contestQuery = contestQuery.eq("id", contestId);
  }

  const { data, error } = await contestQuery.limit(2);

  if (error || !data || data.length !== 1) {
    redirect(`/t/${encodeURIComponent(slug)}`);
  }

  return (
    <section className="flow-page">
      <div className="shell narrow">
        <ShoutFlow
          initialTenderSlug={slug}
          contestMode
          contestId={data[0].id}
        />
      </div>
    </section>
  );
}
