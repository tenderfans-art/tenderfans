import HomeSearch from "@/components/HomeSearch";
import { Suspense } from "react";

export default function DiscoverPage() {
  return (
    <main className="flow-page discover-page">
      <div className="flow-card discover-card">
        <div className="flow-card discover-card">
          <Suspense fallback={<div>Loading spots...</div>}>
            <HomeSearch showDiscoverHeader />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
