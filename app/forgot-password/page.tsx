"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";

export default function ForgotPasswordPage() {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "").trim();

    if (!email) return;

    setSending(true);
    setMessage("");

    const redirectTo = `${window.location.origin}/auth/reset-password`;

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo,
    });

    setSending(false);

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage(
      "Password reset email sent. Check your inbox for the TenderFans reset link."
    );
  }

  return (
    <main className="flow-page">
      <div className="shell narrow">
        <section className="flow-card">
          <div className="eyebrow">TENDERFANS ACCOUNT</div>
          <h1>Reset your password</h1>

          <p className="lead-copy">
            Enter the email address associated with your TenderFans account.
          </p>

          <form onSubmit={handleSubmit} style={{ display: "grid", gap: "16px" }}>
            <label style={{ display: "grid", gap: "7px" }}>
              <strong>Email address</strong>
              <input
                type="email"
                name="email"
                autoComplete="email"
                required
                style={{
                  minHeight: "48px",
                  padding: "0 14px",
                  borderRadius: "8px",
                  border: "1px solid rgba(20,35,45,.25)",
                  font: "inherit",
                }}
              />
            </label>

            <button
              type="submit"
              className="landing-action"
              disabled={sending}
            >
              {sending ? "Sending..." : "Send Reset Link"}
            </button>
          </form>

          {message && (
            <p style={{ marginTop: "18px" }} role="status">
              {message}
            </p>
          )}

          <Link
            href="/"
            style={{ display: "inline-block", marginTop: "22px" }}
          >
            Return to TenderFans
          </Link>
        </section>
      </div>
    </main>
  );
}
