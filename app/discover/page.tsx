import HomeSearch from "@/components/HomeSearch";
import { Suspense } from "react";

export default function DiscoverPage() {
  return (
    <section className="flow-page">
      <div className="shell narrow shout-shell">
        <div className="flow-card discover-flow-card">
          <Suspense fallback={<div>Loading spots...</div>}>
            <HomeSearch showDiscoverHeader />
          </Suspense>
        </div>
      </div>
    </section>
  );
}
