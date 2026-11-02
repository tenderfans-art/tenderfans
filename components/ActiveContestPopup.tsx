"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";

type ActiveContest = {
  id: string;
  title: string;
  flyer_url: string | null;
  starts_at: string;
  ends_at: string;
};

export default function ActiveContestPopup() {
  const [contests, setContests] = useState<ActiveContest[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadActiveContests() {
      const now = new Date().toISOString();

      const { data, error } = await supabase
        .from("contests")
        .select("id, title, flyer_url, starts_at, ends_at")
        .eq("is_active", true)
        .lte("starts_at", now)
        .gte("ends_at", now)
        .order("starts_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        console.error("Homepage contest popup:", error);
        return;
      }

      const withFlyers = (data ?? []).filter((row) => row.flyer_url);

      if (withFlyers.length) {
        setContests(withFlyers);
        setOpen(true);
      }
    }

    loadActiveContests();
    return () => { cancelled = true; };
  }, []);

  if (!open || !contests.length) return null;

  return (
    <div
      className="contest-home-popup-backdrop"
      role="presentation"
      onClick={() => setOpen(false)}
    >
      <section
        className="contest-home-popup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="contest-home-popup-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="contest-home-popup-close"
          onClick={() => setOpen(false)}
          aria-label="Close contest promotion"
        >
          ×
        </button>

        <div id="contest-home-popup-title" className="sr-only">
          Active TenderFans Contests
        </div>

        <div style={{
          maxHeight: "75vh",
          overflowY: "auto",
          display: "grid",
          gap: 16,
        }}>
          {contests.map((contest) => (
            <Link
              key={contest.id}
              href={`/contest?contest=${encodeURIComponent(contest.id)}`}
              className="contest-home-popup-flyer-link"
              aria-label={`View ${contest.title}`}
            >
              <img
                src={contest.flyer_url ?? ""}
                alt={contest.title}
                className="contest-home-popup-flyer"
              />
            </Link>
          ))}
        </div>

        <div className="contest-home-popup-actions">
          {contests.length === 1 && (
            <Link
              href={`/contest?contest=${encodeURIComponent(contests[0].id)}`}
              className="btn primary"
            >
              View Contest
            </Link>
          )}
          <Link
            href="/how-it-works"
            className="btn outline contest-home-popup-secondary"
          >
            How It Works
          </Link>
        </div>
      </section>
    </div>
  );
}
