"use client";

import {
  FormEvent,
  Suspense,
  useEffect,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const continuingClaim = searchParams.get("claim") === "1";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const [needsVerification, setNeedsVerification] =
    useState(false);

  const [resendSeconds, setResendSeconds] = useState(0);
  const [resendRemaining, setResendRemaining] = useState(3);
  const [verificationLocked, setVerificationLocked] =
    useState(false);

  const [resending, setResending] = useState(false);

  useEffect(() => {
    if (resendSeconds <= 0) return;

    const timer = window.setInterval(() => {
      setResendSeconds((current) =>
        current <= 1 ? 0 : current - 1
      );
    }, 1000);

    return () => window.clearInterval(timer);
  }, [resendSeconds]);

  async function initializeVerificationState() {
    try {
      const response = await fetch(
        "/api/auth/resend-verification",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: email.trim(),
            action: "start",
          }),
        }
      );

      const data = await response.json();

      if (typeof data.retryAfterSeconds === "number") {
        setResendSeconds(data.retryAfterSeconds);
      }

      if (typeof data.remaining === "number") {
        setResendRemaining(data.remaining);
      }

      if (data.locked === true) {
        setVerificationLocked(true);
      }
    } catch (error) {
      console.error(
        "Could not initialize verification state:",
        error
      );
    }
  }

  async function handleResendVerification() {
    if (
      resendSeconds > 0 ||
      verificationLocked ||
      resending
    ) {
      return;
    }

    setResending(true);
    setMessage("");

    try {
      const response = await fetch(
        "/api/auth/resend-verification",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: email.trim(),
            action: "resend",
          }),
        }
      );

      const data = await response.json();

      if (typeof data.retryAfterSeconds === "number") {
        setResendSeconds(data.retryAfterSeconds);
      }

      if (typeof data.remaining === "number") {
        setResendRemaining(data.remaining);
      }

      if (data.locked === true) {
        setVerificationLocked(true);
      }

      if (!response.ok) {
        setMessage(
          data.error ||
            "We couldn't send another verification email."
        );
        return;
      }

      setMessage(
        data.remaining > 0
          ? `A new verification email has been sent. You have ${data.remaining} resend attempt${data.remaining === 1 ? "" : "s"} remaining.`
          : "A new verification email has been sent. This was your final automatic resend."
      );
    } catch {
      setMessage(
        "We couldn't send another verification email right now."
      );
    } finally {
      setResending(false);
    }
  }

  async function handleLogin(
    e: FormEvent<HTMLFormElement>
  ) {
    e.preventDefault();

    setLoading(true);
    setMessage("");
    setNeedsVerification(false);

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (error) {
      if (
        error.message
          .toLowerCase()
          .includes("email not confirmed")
      ) {
        setNeedsVerification(true);

        setMessage(
          "Your email hasn't been verified yet. Check your inbox for the verification email we already sent."
        );

        await initializeVerificationState();
      } else {
        setMessage(error.message);
      }

      setLoading(false);
      return;
    }

    if (continuingClaim) {
      try {
        const saved = localStorage.getItem(
          "tf_pending_claim"
        );

        if (saved) {
          const pending = JSON.parse(saved);

          if (
            pending?.type === "bartender" ||
            pending?.type === "venue"
          ) {
            router.push(
              `/claim?type=${pending.type}&resume=1`
            );
            return;
          }
        }
      } catch {}
    }

    router.push("/account");
  }

  const minutes = Math.floor(resendSeconds / 60);
  const seconds = resendSeconds % 60;

  const formattedCountdown =
    `${minutes}:${String(seconds).padStart(2, "0")}`;

  return (
    <section className="flow-page login-page">
      <div className="shell narrow">
        <div className="flow-card login-card">
          <div className="eyebrow">
            Tender / Spot Login
          </div>

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
              onChange={(e) => {
                setEmail(e.target.value);
                setNeedsVerification(false);
              }}
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
              <div
                className="privacy-note"
                style={{
                  padding: needsVerification ? "12px 14px" : undefined,
                  margin: needsVerification ? 0 : undefined,
                }}
              >
                {message}
              </div>
            )}

            {needsVerification && (
              <div
                style={{
                  display: "grid",
                  gap: "8px",
                  marginTop: 0,
                }}
              >
                {verificationLocked ? (
                  <div
                    className="privacy-note"
                    style={{
                      padding: "10px 14px",
                      margin: 0,
                    }}
                  >
                    You've reached the verification email
                    resend limit. Please contact TenderFans
                    customer service for help verifying your
                    account.
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className="landing-action"
                      disabled={
                        resendSeconds > 0 || resending
                      }
                      onClick={handleResendVerification}
                    >
                      {resending
                        ? "Sending..."
                        : resendSeconds > 0
                          ? `Resend available in ${formattedCountdown}`
                          : "Resend verification email"}
                    </button>

                    <div
                      className="privacy-note"
                      style={{
                        padding: "10px 14px",
                        margin: 0,
                      }}
                    >
                      {resendRemaining} automatic resend
                      attempt
                      {resendRemaining === 1 ? "" : "s"}{" "}
                      remaining.
                    </div>
                  </>
                )}
              </div>
            )}
          </form>
        </div>
      </div>
    </section>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginContent />
    </Suspense>
  );
}
