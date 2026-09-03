"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export default function Header() {
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSignedIn(!!data.session);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setSignedIn(!!session);
    });

    return () => data.subscription.unsubscribe();
  }, []);

  return (
    <header className="site-header">
      <div className="shell header-inner">
        <Link href="/" className="brand" aria-label="TenderFans home">
          <img src="/tfans.png" alt="TenderFans" className="header-logo" />
        </Link>
        <nav className="nav">
          <Link href="/shout">Give a Shout</Link>
          <Link href="/claim">Claim Profile</Link>
          <Link href="/how-it-works">How it Works</Link>
          {signedIn ? (
            <Link className="nav-login" href="/admin/claims">Account</Link>
          ) : (
            <Link className="nav-login" href="/login">Sign in</Link>
          )}
        </nav>
      </div>
    </header>
  );
}
