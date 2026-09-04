"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export default function Header() {
  const [signedIn, setSignedIn] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSignedIn(!!data.session);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setSignedIn(!!session);
    });

    return () => data.subscription.unsubscribe();
  }, []);

  async function handleSignOut() {
    await supabase.auth.signOut();

    // A deliberate sign-out ends any unfinished claim session.
    localStorage.removeItem("tf_pending_claim");

    setSignedIn(false);
    window.location.href = "/";
  }

  return (
    <header className="site-header">
      <div className="shell header-inner">
        <Link href="/" className="brand" aria-label="TenderFans home">
          <img src="/tfans.png" alt="TenderFans" className="header-logo" />
        </Link>
        <button
          type="button"
          className="mobile-nav-toggle"
          aria-label="Open navigation menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span />
          <span />
          <span />
        </button>

        <nav
          className={`nav${menuOpen ? " mobile-open" : ""}`}
          onClick={() => setMenuOpen(false)}
        >
          <Link href="/shout">Give a Shout</Link>
          <Link href="/claim">Claim Profile</Link>
          <Link href="/how-it-works">How it Works</Link>
          {signedIn ? (
            <>
              <Link className="nav-login" href="/account">Account</Link>
              <button
                type="button"
                className="nav-login"
                onClick={handleSignOut}
                style={{
                  background: "none",
                  border: 0,
                  cursor: "pointer",
                  font: "inherit",
                }}
              >
                Sign Out
              </button>
            </>
          ) : (
            <Link className="nav-login" href="/login">Sign in</Link>
          )}
        </nav>
      </div>
    </header>
  );
}
