import { redirect } from "next/navigation";
import ShoutFlow from "@/app/shout/ShoutFlow";
import { supabase } from "@/lib/supabase";

export default async function ContestTenderPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const now = new Date().toISOString();

  const { data: activeContest } = await supabase
    .from("contests")
    .select("id")
    .eq("is_active", true)
    .lte("starts_at", now)
    .gte("ends_at", now)
    .maybeSingle();

  if (!activeContest) {
    redirect(`/t/${slug}`);
  }

  return (
    <section className="flow-page">
      <div className="shell narrow">
        <ShoutFlow
          initialTenderSlug={slug}
          contestMode
        />
      </div>
    </section>
  );
}
