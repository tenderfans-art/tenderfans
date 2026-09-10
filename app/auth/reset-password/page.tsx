"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("Opening secure reset session...");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function checkSession() {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (session) {
        setReady(true);
        setMessage("");
        return;
      }

      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((event, session) => {
        if ((event === "PASSWORD_RECOVERY" || session) && session) {
          setReady(true);
          setMessage("");
        }
      });

      return () => subscription.unsubscribe();
    }

    checkSession();
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const form = new FormData(e.currentTarget);
    const password = String(form.get("password") ?? "");
    const confirmPassword = String(form.get("confirmPassword") ?? "");

    if (password.length < 8) {
      setMessage("Password must be at least 8 characters.");
      return;
    }

    if (password !== confirmPassword) {
      setMessage("Passwords do not match.");
      return;
    }

    setSaving(true);
    setMessage("");

    const { error } = await supabase.auth.updateUser({
      password,
    });

    setSaving(false);

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage("Password updated. Redirecting to your account...");

    setTimeout(() => {
      router.replace("/account");
    }, 1000);
  }

  return (
    <main className="flow-page">
      <div className="shell narrow">
        <section className="flow-card">
          <div className="eyebrow">TENDERFANS ACCOUNT</div>
          <h1>Choose a new password</h1>

          {!ready ? (
            <p className="lead-copy">{message}</p>
          ) : (
            <>
              <p className="lead-copy">
                Enter the new password you want to use for TenderFans.
              </p>

              <form
                onSubmit={handleSubmit}
                style={{ display: "grid", gap: "16px" }}
              >
                <label style={{ display: "grid", gap: "7px" }}>
                  <strong>New password</strong>
                  <input
                    type="password"
                    name="password"
                    autoComplete="new-password"
                    required
                    minLength={8}
                    style={{
                      minHeight: "48px",
                      padding: "0 14px",
                      borderRadius: "8px",
                      border: "1px solid rgba(20,35,45,.25)",
                      font: "inherit",
                    }}
                  />
                </label>

                <label style={{ display: "grid", gap: "7px" }}>
                  <strong>Confirm new password</strong>
                  <input
                    type="password"
                    name="confirmPassword"
                    autoComplete="new-password"
                    required
                    minLength={8}
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
                  disabled={saving}
                >
                  {saving ? "Updating..." : "Update Password"}
                </button>
              </form>
            </>
          )}

          {ready && message && (
            <p style={{ marginTop: "18px" }} role="status">
              {message}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
