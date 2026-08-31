"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";

export default function LandingHero() {
  const [loginMessage, setLoginMessage] = useState("");

  function handleLogin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoginMessage("Login is ready for Supabase Auth wiring.");
  }

  return (
    <section className="landing-hero" aria-label="TenderFans welcome">
      <div className="landing-stage">
        <img
          className="landing-art"
          src="/landing-bar.png"
          alt="Warm neighborhood bar with a Give a Shout panel on the left silhouette and bartender or owner login on the right silhouette."
        />

        {/* Left silhouette: the artwork carries the visual design; this is the real click target. */}
        <Link
          href="/shout"
          className="landing-hotspot shout-hotspot"
          aria-label="Give a Shout"
        >
          <span className="sr-only">Give a Shout</span>
        </Link>

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

          <Link className="art-button bartender-claim-hotspot" href="/claim" aria-label="Claim your bartender profile">
            <span className="sr-only">Claim your bartender profile</span>
          </Link>

          <Link className="art-button venue-claim-hotspot" href="/claim" aria-label="Claim your establishment">
            <span className="sr-only">Claim your establishment</span>
          </Link>

          <Link className="art-button create-account-hotspot" href="/claim" aria-label="Create account">
            <span className="sr-only">Create account</span>
          </Link>
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
