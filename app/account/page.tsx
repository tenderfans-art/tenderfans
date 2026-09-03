"use client";

import { useEffect, useState } from "react";
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

      setMessage(
        "Your account does not have an approved Tender or Spot profile yet."
      );
    }

    routeAccount();
  }, []);

  return (
    <main className="flow-page">
      <div className="shell narrow">
        <div className="flow-card">
          <div className="eyebrow">TenderFans Account</div>
          <h1>Your account</h1>
          <p className="lead-copy">{message}</p>
        </div>
      </div>
    </main>
  );
}
