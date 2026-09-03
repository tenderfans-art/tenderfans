"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import SpotMediaGallery from "@/components/spot/SpotMediaGallery";
import { supabase } from "@/lib/supabase";

export default function Page({
  params,
}: {
  params: Promise<{ venueId: string }>;
}) {
  const { venueId } = use(params);
  const [authorized, setAuthorized] = useState<boolean | null>(null);

  useEffect(() => {
    async function checkAccess() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        window.location.href = "/login";
        return;
      }

      const { data, error } = await supabase
        .from("venue_permissions")
        .select("venue_id")
        .eq("user_id", user.id)
        .eq("venue_id", venueId)
        .eq("can_manage_media", true)
        .maybeSingle();

      if (error || !data) {
        setAuthorized(false);
        return;
      }

      setAuthorized(true);
    }

    checkAccess();
  }, [venueId]);

  if (authorized === null) {
    return (
      <main className="flow-page">
        <div className="shell">
          <section className="flow-card">
            <p>Checking Spot access...</p>
          </section>
        </div>
      </main>
    );
  }

  if (!authorized) {
    return (
      <main className="flow-page">
        <div className="shell">
          <section className="flow-card">
            <div className="eyebrow">SPOT OWNER ACCOUNT</div>
            <h1>Access denied.</h1>

            <p className="lead-copy">
              You do not have permission to manage media for this Spot.
            </p>

            <Link href="/account/spot">
              ← Back to Spot Owner Account
            </Link>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="flow-page">
      <div className="shell">
        <section className="flow-card">
          <div className="eyebrow">SPOT MEDIA</div>
          <h1>Menus</h1>

          <p className="lead-copy">
            Upload and manage menu images and PDFs.
          </p>

          <SpotMediaGallery
            venueId={venueId}
            mediaType="menu"
          />

          <div style={{ marginTop: "24px" }}>
            <Link href="/account/spot">
              ← Back to Spot Owner Account
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
