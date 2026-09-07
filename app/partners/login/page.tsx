"use client";

import Link from "next/link";
import { FormEvent, Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";

function PartnerLoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [creating, setCreating] = useState(
    searchParams.get("mode") === "create"
  );

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

    if (error) {
      if (error.message.toLowerCase().includes("email not confirmed")) {
        const { error: resendError } = await supabase.auth.resend({
          type: "signup",
          email: email.trim(),
          options: {
            emailRedirectTo:
              `${window.location.origin}/auth/confirmed?partner=1`,
          },
        });

        setMessage(
          resendError
            ? "Your email is not verified yet. We could not resend the verification email: " +
                resendError.message
            : "Your email is not verified yet. We just sent you a new verification email."
        );
      } else {
        setMessage(error.message);
      }

      setLoading(false);
      return;
    }

    router.push("/partners/apply");
  }

  async function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setMessage("");

    localStorage.setItem("tf_partner_signup", "1");

    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        emailRedirectTo:
          `${window.location.origin}/auth/confirmed?partner=1`,
      },
    });

    if (error) {
      setMessage(error.message);
      setLoading(false);
      return;
    }

    if (
      data.user &&
      Array.isArray(data.user.identities) &&
      data.user.identities.length === 0
    ) {
      setCreating(false);
      setMessage(
        "That email already has a TenderFans account. Sign in here to continue into the Partner portal."
      );
      setLoading(false);
      return;
    }

    if (data.session && data.user) {
      router.push("/partners/apply");
      return;
    }

    setMessage(
      "Account created. Check your email to verify your address, then return to the Partner portal to continue."
    );

    setLoading(false);
  }

  return (
    <section className="flow-page">
      <div className="shell narrow">
        <div className="flow-card partner-login-card">
          <div className="eyebrow">TenderFans Partner Portal</div>

          <h1>
            {creating ? "Create your Partner account." : "Welcome, Partners."}
          </h1>

          <p className="lead-copy">
            {creating
              ? "For event promoters and liquor or brand representatives."
              : "Sign in to your Promoter or Rep portal."}
          </p>

          <div className="partner-login-switch">
            <button
              type="button"
              className={!creating ? "active" : ""}
              onClick={() => {
                setCreating(false);
                setMessage("");
              }}
            >
              Log In
            </button>

            <button
              type="button"
              className={creating ? "active" : ""}
              onClick={() => {
                setCreating(true);
                setMessage("");
              }}
            >
              Create Account
            </button>
          </div>

          <form
            onSubmit={creating ? handleCreate : handleLogin}
            className="partner-auth-form"
          >
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              autoComplete="email"
              required
            />

            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoComplete={creating ? "new-password" : "current-password"}
              minLength={6}
              required
            />

            <button
              type="submit"
              className="landing-action"
              disabled={loading}
            >
              {loading
                ? creating
                  ? "Creating..."
                  : "Signing in..."
                : creating
                ? "Create Partner Account"
                : "Partner Sign In"}
            </button>
          </form>

          {message && (
            <div className="privacy-note partner-login-message">
              {message}
            </div>
          )}

          <div className="partner-about-link">
            New to the Partner program?{" "}
            <Link href="/partners">About Partner Profiles</Link>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function PartnerLoginPage() {
  return (
    <Suspense fallback={null}>
      <PartnerLoginContent />
    </Suspense>
  );
}
