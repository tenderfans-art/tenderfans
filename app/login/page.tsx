"use client";

import { FormEvent, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const continuingClaim = searchParams.get("claim") === "1";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setMessage("");

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (error) { if (error.message.toLowerCase().includes("email not confirmed")) { const { error: resendError } = await supabase.auth.resend({ type: "signup", email: email.trim(), options: { emailRedirectTo: window.location.origin } }); setMessage(resendError ? "Your email is not verified yet. We could not resend the verification email: " + resendError.message : "Your email is not verified yet. We just sent you a new verification email. Please verify it, then come back here and sign in again."); } else { setMessage(error.message); } setLoading(false); return; }

    if (continuingClaim) {
      try {
        const saved = localStorage.getItem("tf_pending_claim");

        if (saved) {
          const pending = JSON.parse(saved);

          if (
            pending?.type === "bartender" ||
            pending?.type === "venue"
          ) {
            router.push(`/claim?type=${pending.type}&resume=1`);
            return;
          }
        }
      } catch {}
    }

    router.push("/account");
  }

  return (
    <section className="flow-page">
      <div className="shell narrow">
        <div className="flow-card">
          <div className="eyebrow">Tender / Spot Login</div>
          <h1>Welcome back.</h1>

          <p className="lead-copy">
            {continuingClaim
              ? "You already have a TenderFans account. Sign in to continue your claim."
              : "Sign in to manage your verified Tender or Spot profile."}
          </p>

          <form
            onSubmit={handleLogin}
            style={{ display: "grid", gap: "14px" }}
          >
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              autoComplete="email"
              required
              style={{
                padding: "14px 16px",
                borderRadius: "10px",
                border: "1px solid #d7d2c7",
                fontSize: "16px",
              }}
            />

            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoComplete="current-password"
              required
              style={{
                padding: "14px 16px",
                borderRadius: "10px",
                border: "1px solid #d7d2c7",
                fontSize: "16px",
              }}
            />

            <button
              type="submit"
              className="landing-action"
              disabled={loading}
            >
              {loading ? "Signing in..." : "Sign in"}
            </button>

            {message && (
              <div className="privacy-note">{message}</div>
            )}
          </form>
        </div>
      </div>
    </section>
  );
}
