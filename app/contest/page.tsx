"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { QRCodeCanvas } from "qrcode.react";
import { supabase } from "@/lib/supabase";

type Contest = {
  id: string;
  title: string;
  prize_text: string;
  starts_at: string;
  ends_at: string;
  flyer_url: string | null;
  rules_text: string | null;
};

type ContestTender = {
  id: string;
  slug: string;
  name: string;
  spotName: string;
  entries: number;
};

function flyerSpotName(name: string) {
  const trimmed = name.trim();

  if (trimmed.length <= 10) {
    return trimmed;
  }

  return trimmed.slice(0, 10).trimEnd();
}

export default function ContestPage() {
  const [contest, setContest] = useState<Contest | null>(null);
  const [leaders, setLeaders] = useState<ContestTender[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const [contestUrl, setContestUrl] = useState("");

  useEffect(() => {
    setContestUrl(`${window.location.origin}/contest`);

    async function loadContest() {
      const now = new Date().toISOString();

      const [
        contestResult,
        bartenderResult,
        venueResult,
        leaderboardResult,
      ] = await Promise.all([
        supabase
          .from("contests")
          .select(
            "id, title, prize_text, starts_at, ends_at, flyer_url, rules_text"
          )
          .eq("is_active", true)
          .lte("starts_at", now)
          .gte("ends_at", now)
          .maybeSingle(),

        supabase
          .from("bartenders")
          .select("id, slug, display_name")
          .eq("status", "active"),

        supabase
          .from("bartender_venues")
          .select(`
            bartender_id,
            is_primary,
            venues(
              name
            )
          `)
          .eq("is_current", true),

        supabase.rpc("public_active_contest_leaderboard"),
      ]);

      if (contestResult.error) {
        console.error("Contest:", contestResult.error);
        setLoading(false);
        return;
      }

      if (bartenderResult.error) {
        console.error(
          "Contest Tenders:",
          bartenderResult.error
        );
        setLoading(false);
        return;
      }

      if (venueResult.error) {
        console.error(
          "Contest Tender Spots:",
          venueResult.error
        );
      }

      if (leaderboardResult.error) {
        console.error(
          "Contest leaderboard:",
          leaderboardResult.error
        );
      }

      const activeContest =
        contestResult.data as Contest | null;

      setContest(activeContest);

      if (!activeContest) {
        setLeaders([]);
        setLoading(false);
        return;
      }

      const entryCounts = new Map<string, number>();

      for (const row of leaderboardResult.data ?? []) {
        if (row.contest_id !== activeContest.id) continue;

        entryCounts.set(
          row.bartender_id,
          Number(row.entry_count ?? 0)
        );
      }

      const venueMap = new Map<
        string,
        {
          name: string;
          isPrimary: boolean;
        }[]
      >();

      for (const row of venueResult.data ?? []) {
        const venueData = (row as any).venues;

        const venue = Array.isArray(venueData)
          ? venueData[0]
          : venueData;

        if (!venue) continue;

        const current =
          venueMap.get(row.bartender_id) ?? [];

        current.push({
          name: venue.name,
          isPrimary: Boolean(
            (row as any).is_primary
          ),
        });

        venueMap.set(
          row.bartender_id,
          current
        );
      }

      for (const [, spots] of venueMap) {
        spots.sort(
          (a, b) =>
            Number(b.isPrimary) -
            Number(a.isPrimary)
        );
      }

      const ranked: ContestTender[] =
        (bartenderResult.data ?? [])
          .map((tender) => ({
            id: tender.id,
            slug: tender.slug,
            name: tender.display_name,
            spotName:
              venueMap.get(tender.id)?.[0]?.name ??
              "TenderFans",
            entries:
              entryCounts.get(tender.id) ?? 0,
          }))
          /*
           * Do not put zero-entry Tenders onto the public
           * contest leaderboard.
           */
          .filter((tender) => tender.entries > 0)
          .sort(
            (a, b) =>
              b.entries - a.entries ||
              a.name.localeCompare(b.name)
          )
          .slice(0, 5);

      setLeaders(ranked);
      setLoading(false);
    }

    loadContest();
  }, []);

  if (loading) {
    return (
      <main className="contest-public-page">
        <p className="contest-loading">
          Loading contest...
        </p>
      </main>
    );
  }

  if (!contest || !contest.flyer_url) {
    return (
      <main className="contest-public-page">
        <div className="contest-empty">
          <div className="eyebrow">
            TenderFans Contest
          </div>

          <h1>No contest is active right now.</h1>

          <Link className="btn primary" href="/">
            Return to TenderFans
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="contest-public-page">
      <div className="contest-flyer-stage">
        <img
          className="contest-flyer-art"
          src={contest.flyer_url}
          alt={contest.title}
        />

        <div className="contest-leaderboard-overlay">
          {[0, 1, 2, 3, 4].map((index) => {
            const tender = leaders[index];

            return tender ? (
              <Link
                key={tender.id}
                href={`/contest/t/${tender.slug}`}
                className={`contest-leader-row contest-leader-row-${index + 1}`}
                aria-label={`Give ${tender.name} a contest Shout`}
              >
                <span className="contest-leader-name">
                  {tender.name}
                </span>

                <span
                  className="contest-leader-count"
                  title={tender.spotName}
                >
                  {flyerSpotName(tender.spotName)}
                </span>
              </Link>
            ) : (
              <div
                key={`empty-${index}`}
                className={`contest-leader-row contest-leader-row-${index + 1}`}
                aria-hidden="true"
              />
            );
          })}
        </div>

        {contestUrl && (
          <div
            className="contest-public-qr"
            aria-label="TenderFans contest QR code"
          >
            <QRCodeCanvas
              value={contestUrl}
              size={220}
              marginSize={1}
            />
          </div>
        )}

        <button
          type="button"
          className="contest-details-hotspot"
          onClick={() => setShowDetails(true)}
        >
          Contest Details, Rules &amp; Disclaimers
        </button>
      </div>

      {showDetails && (
        <div
          className="contest-details-backdrop"
          role="presentation"
          onClick={() => setShowDetails(false)}
        >
          <section
            className="contest-details-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="contest-details-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="contest-details-close"
              onClick={() => setShowDetails(false)}
              aria-label="Close contest details"
            >
              ×
            </button>

            <div className="eyebrow">
              TenderFans Contest
            </div>

            <h2 id="contest-details-title">
              {contest.title}
            </h2>

            <p>
              <strong>{contest.prize_text}</strong>
            </p>

            <p>
              Contest period:{" "}
              {new Date(
                contest.starts_at
              ).toLocaleDateString()}{" "}
              through{" "}
              {new Date(
                contest.ends_at
              ).toLocaleDateString()}.
            </p>

            {contest.rules_text && (
              <div className="contest-rules-copy">
                {contest.rules_text}
              </div>
            )}

            <div className="privacy-note">
              TenderFans may remove duplicate, automated,
              fraudulent, manipulated or otherwise ineligible
              Shouts from contest totals. Final results are
              subject to review before a winner is certified.
            </div>

            <button
              type="button"
              className="btn primary"
              onClick={() => setShowDetails(false)}
            >
              Back to Contest
            </button>
          </section>
        </div>
      )}
    </main>
  );
}
