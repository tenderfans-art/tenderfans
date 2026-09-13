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
  const [contest, setContest] =
    useState<ActiveContest | null>(null);

  const [open, setOpen] =
    useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadActiveContest() {
      const now =
        new Date().toISOString();

      const { data, error } =
        await supabase
          .from("contests")
          .select(
            "id, title, flyer_url, starts_at, ends_at"
          )
          .eq("is_active", true)
          .lte("starts_at", now)
          .gte("ends_at", now)
          .maybeSingle();

      if (cancelled) return;

      if (error) {
        console.error(
          "Homepage contest popup:",
          error
        );
        return;
      }

      if (
        data &&
        data.flyer_url
      ) {
        setContest(
          data as ActiveContest
        );
        setOpen(true);
      }
    }

    loadActiveContest();

    return () => {
      cancelled = true;
    };
  }, []);

  if (
    !contest ||
    !contest.flyer_url ||
    !open
  ) {
    return null;
  }

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
        onClick={(event) =>
          event.stopPropagation()
        }
      >
        <button
          type="button"
          className="contest-home-popup-close"
          onClick={() => setOpen(false)}
          aria-label="Close contest promotion"
        >
          ×
        </button>

        <div
          id="contest-home-popup-title"
          className="sr-only"
        >
          {contest.title}
        </div>

        <Link
          href="/contest"
          className="contest-home-popup-flyer-link"
          aria-label={`View ${contest.title}`}
        >
          <img
            src={contest.flyer_url}
            alt={contest.title}
            className="contest-home-popup-flyer"
          />
        </Link>

        <div className="contest-home-popup-actions">
          <Link
            href="/contest"
            className="btn primary"
          >
            View Contest
          </Link>

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
