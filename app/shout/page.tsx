import ShoutFlow from "./ShoutFlow";
import { supabase } from "@/lib/supabase";

export default async function ShoutPage() {
  const now = new Date().toISOString();

  const { data: activeContest } = await supabase
    .from("contests")
    .select("id")
    .eq("is_active", true)
    .lte("starts_at", now)
    .gte("ends_at", now)
    .maybeSingle();

  return (
    <section className="flow-page">
      <div className="shell narrow">
        <ShoutFlow
          contestMode={Boolean(activeContest)}
        />
      </div>
    </section>
  );
}
