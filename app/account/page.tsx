"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";

export default function AccountPage() {
  const [message, setMessage] = useState("Loading your account...");

  useEffect(() => {
    async function routeAccount() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        window.location.href = "/login";
        return;
      }

      // Admin takes priority.
      const { data: admin } = await supabase
        .from("platform_admins")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (admin) {
        window.location.href = "/admin";
        return;
      }

      // Spot Owner / Manager
      const { data: spotPermissions } = await supabase
        .from("venue_permissions")
        .select("venue_id")
        .eq("user_id", user.id)
        .limit(1);

      if (spotPermissions && spotPermissions.length > 0) {
        window.location.href = "/account/spot";
        return;
      }

      // Tender
      const { data: tenderPermissions } = await supabase
        .from("bartender_permissions")
        .select("bartender_id")
        .eq("user_id", user.id)
        .limit(1);

      if (tenderPermissions && tenderPermissions.length > 0) {
        window.location.href = "/account/tender";
        return;
      }

      // Approved Partner
      const { data: partnerProfile } = await supabase
        .from("partner_profiles")
        .select("id")
        .eq("user_id", user.id)
        .eq("status", "approved")
        .maybeSingle();

      if (partnerProfile) {
        window.location.href = "/account/partner";
        return;
      }

      setMessage(
        "If you recently submitted a Tender or Spot claim, it is currently awaiting TenderFans approval. Once approved, your account will automatically gain access to the appropriate management portal. No further action is needed at this time."
      );
    }

    routeAccount();
  }, []);

  return (
    <main className="flow-page">
      <div className="shell narrow">
        <div className="flow-card">
          <div className="eyebrow">TenderFans Account</div>
          <h1>Your account is awaiting verification.</h1>
          <p className="lead-copy">{message}</p>

          <Link className="landing-action" href="/">
            Return to TenderFans
          </Link>
        </div>
      </div>
    </main>
  );
}
