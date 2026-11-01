"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export default function AdminCodexLauncher() {
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    let active = true;

    async function checkAdmin() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        if (active) setAuthorized(false);
        return;
      }

      const { data, error } = await supabase
        .from("platform_admins")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (active) setAuthorized(!error && Boolean(data));
    }

    void checkAdmin();

    const { data: subscription } =
      supabase.auth.onAuthStateChange(() => {
        if (active) setAuthorized(false);
        void checkAdmin();
      });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  if (!authorized) return null;

  return (
    <a
      href="https://chatgpt.com/codex"
      target="_blank"
      rel="noopener noreferrer"
      title="Open Codex — Developer Tools"
      aria-label="Open Codex — Developer Tools"
      style={{
        position: "fixed",
        right: 20,
        bottom: 20,
        zIndex: 900,
        width: 46,
        height: 46,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "50%",
        background: "#192b34",
        color: "#fff",
        fontWeight: 800,
        fontSize: 17,
        textDecoration: "none",
        boxShadow: "0 5px 18px rgba(0,0,0,.25)",
      }}
    >
      {"</>"}
    </a>
  );
}
