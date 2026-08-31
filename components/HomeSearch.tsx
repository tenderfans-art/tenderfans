"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { bartenders, venues } from "@/lib/mock-data";

export default function HomeSearch() {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return [];
    const venueMatches = venues.filter(v => `${v.name} ${v.city} ${v.type}`.toLowerCase().includes(q)).slice(0, 4).map(v => ({ kind: "spot", title: v.name, meta: `${v.type} · ${v.city}`, href: `/s/${v.slug}` }));
    const bartenderMatches = bartenders.filter(b => `${b.name} ${b.venueName} ${b.city}`.toLowerCase().includes(q)).slice(0, 4).map(b => ({ kind: "tender", title: b.name, meta: `${b.venueName} · ${b.city}`, href: `/t/${b.slug}` }));
    return [...bartenderMatches, ...venueMatches].slice(0, 6);
  }, [q]);

  return (
    <div className="search-wrap">
      <div className="search-box">
        <span aria-hidden="true">⌕</span>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search bartender, bar or city..." aria-label="Search bartender, bar or city" />
      </div>
      {q && <div className="search-results">
        {matches.length ? matches.map(m => (
          <Link key={`${m.kind}-${m.href}`} href={m.href} className="search-result">
            <span className="result-kicker">{m.kind === "tender" ? "Tender" : "Spot"}</span>
            <strong>{m.title}</strong>
            <small>{m.meta}</small>
          </Link>
        )) : <div className="search-empty">No TenderFans match yet. Start a shout to add the spot.</div>}
      </div>}
    </div>
  );
}
