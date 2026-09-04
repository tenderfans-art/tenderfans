"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function LandingHero() {
  const router = useRouter();
  const [loginMessage, setLoginMessage] = useState("");

  async function handleLogin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoginMessage("Signing in...");

    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setLoginMessage(error.message);
      return;
    }
 
    setLoginMessage("Signed in.");
    try { const saved = localStorage.getItem("tf_pending_claim"); const pending = saved ? JSON.parse(saved) : null; if (pending?.type === "bartender" || pending?.type === "venue") { router.push(`/claim?type=${pending.type}`); return; } } catch {} router.push("/admin/claims");
  }

  return (
    <section className="landing-hero" aria-label="TenderFans welcome">
      <div className="landing-stage">
        <picture>
          <source
            media="(max-width: 767px)"
            srcSet="/tfansmobile.png"
          />
          <img
            className="landing-art"
            src="/landing-bar.png"
            alt="Warm neighborhood bar with two silhouetted figures at the bar."
          />
        </picture>

        <div className="hide-start-line" aria-hidden="true" />

        {/* Left silhouette: the artwork carries the visual design; this is the real click target. */}
        <Link
          href="/shout"
          className="landing-hotspot shout-hotspot"
          aria-label="Give a Shout"
        >
          <span className="sr-only">Give a Shout</span>
        </Link>

        <Link
          href="/discover"
          className="landing-hotspot discover-hotspot"
          aria-label="Find a Spot"
        >
          <span className="sr-only">Find a Spot</span>
        </Link>
        
        <Link href="/discover?view=trending" className="landing-hotspot trending-hotspot" aria-label="Trending Spots"><span className="sr-only">Trending Spots</span></Link>
        <Link href="/discover?view=nearby" className="landing-hotspot nearby-hotspot" aria-label="Nearby Spots"><span className="sr-only">Nearby Spots</span></Link>
        <Link href="/discover?view=recent" className="landing-hotspot recent-hotspot" aria-label="Recent Shouts"><span className="sr-only">Recent Shouts</span></Link>
        <Link href="/how-it-works" className="landing-hotspot how-it-works-hotspot" aria-label="Learn how TenderFans works"><span className="sr-only">Learn how TenderFans works</span></Link>
        
        {/* Right silhouette: invisible form controls sit exactly over the fields shown in the artwork. */}
        <form className="owner-hotspot" onSubmit={handleLogin} aria-label="Bartender or owner login">
          <label className="art-input email-hotspot">
            <span className="sr-only">Email address</span>
            <input
              type="email"
              name="email"
              autoComplete="email"
              aria-label="Email address"
              required
            />
          </label>

          <label className="art-input password-hotspot">
            <span className="sr-only">Password</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              aria-label="Password"
              required
            />
          </label>

          <button className="art-button login-hotspot" type="submit" aria-label="Log in">
            <span className="sr-only">Log in</span>
          </button>

          <Link className="art-button bartender-claim-hotspot" href="/claim?type=bartender" aria-label="Claim your Tender profile">
            <span className="sr-only">Claim your bartender profile</span>
          </Link>

          <Link className="art-button venue-claim-hotspot" href="/claim?type=venue" aria-label="Claim your Spot">
            <span className="sr-only">Claim your establishment</span>
          </Link>

          <span className="art-button create-account-hotspot" aria-hidden="true" />
        </form>

        {loginMessage && (
          <div className="landing-auth-message" role="status">
            {loginMessage}
          </div>
        )}
      </div>

      <div className="mobile-landing-actions">
        <div className="mobile-action-card">
          <span className="panel-kicker">FAN</span>
          <h2>Know a great bartender?</h2>
          <Link className="landing-action" href="/shout">Give a Shout</Link>
        </div>
        <div className="mobile-action-card">
          <span className="panel-kicker">BARTENDER / OWNER</span>
          <h2>Make your profile yours.</h2>
          <Link className="landing-action secondary" href="/claim">Login or Claim</Link>
        </div>
      </div>
    </section>
  );
}
