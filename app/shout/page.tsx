import ShoutFlow from "./ShoutFlow";
import { supabase } from "@/lib/supabase";

export default async function ShoutPage({
  searchParams,
}: {
  searchParams: Promise<{ contest?: string }>;
}) {
  const { contest: contestId } = await searchParams;
  let activeContestId: string | undefined;

  if (contestId) {
    const now = new Date().toISOString();

    const { data } = await supabase
      .from("contests")
      .select("id")
      .eq("id", contestId)
      .eq("is_active", true)
      .lte("starts_at", now)
      .gte("ends_at", now)
      .maybeSingle();

    activeContestId = data?.id;
  }

  return (
    <section className="flow-page">
      <div className="shell narrow shout-shell">
        <ShoutFlow
          contestMode={Boolean(activeContestId)}
          contestId={activeContestId}
        />
      </div>
    </section>
  );
}
