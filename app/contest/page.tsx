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

  if (trimmed.length <= 15) {
    return trimmed;
  }

  return trimmed.slice(0, 15).trimEnd();
}

export default function ContestPage() {
  const [contest, setContest] = useState<Contest | null>(null);
  const [leaders, setLeaders] = useState<ContestTender[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const [contestInfoTab, setContestInfoTab] = useState<
    "details" | "rules" | "disclaimers"
  >("details");
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

        <Link
          href="/shout"
          className="contest-shout-hotspot"
          aria-label="Find your Tender and give them a Shout"
          title="Find your Tender and give them a Shout"
        />

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
            className="contest-details-modal contest-info-center"
            role="dialog"
            aria-modal="true"
            aria-labelledby="contest-details-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="contest-details-close"
              onClick={() => setShowDetails(false)}
              aria-label="Close contest information"
            >
              ×
            </button>

            <div className="eyebrow">
              TENDERFANS CONTEST
            </div>

            <h2 id="contest-details-title">
              {contest.title}
            </h2>

            <div
              className="contest-info-period"
            >
              {new Date(
                contest.starts_at
              ).toLocaleDateString()}{" "}
              through{" "}
              {new Date(
                contest.ends_at
              ).toLocaleDateString()}
            </div>

            <div
              className="contest-info-tabs"
              role="tablist"
              aria-label="Contest information"
            >
              <button
                type="button"
                role="tab"
                aria-selected={
                  contestInfoTab === "details"
                }
                className={
                  contestInfoTab === "details"
                    ? "contest-info-tab active"
                    : "contest-info-tab"
                }
                onClick={() =>
                  setContestInfoTab("details")
                }
              >
                Details
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={
                  contestInfoTab === "rules"
                }
                className={
                  contestInfoTab === "rules"
                    ? "contest-info-tab active"
                    : "contest-info-tab"
                }
                onClick={() =>
                  setContestInfoTab("rules")
                }
              >
                Official Rules
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={
                  contestInfoTab === "disclaimers"
                }
                className={
                  contestInfoTab === "disclaimers"
                    ? "contest-info-tab active"
                    : "contest-info-tab"
                }
                onClick={() =>
                  setContestInfoTab("disclaimers")
                }
              >
                Disclaimers
              </button>
            </div>

            <div className="contest-info-content">
              {contestInfoTab === "details" && (
                <div>
                  <h3>How TenderFans Contests Work</h3>

                  <p>
                    TenderFans contests celebrate the
                    hospitality professionals who make our
                    favorite Spots worth coming back to.
                  </p>

                  <p>
                    Give a participating Tender a Shout during
                    the Contest Period. To create a qualifying
                    Contest Entry, you&apos;ll verify your mobile
                    number and accept the contest terms.
                  </p>

                  <div className="contest-info-callout">
                    <strong>Entry Limit</strong>

                    <p>
                      One verified participant may submit one
                      qualifying Contest Entry for the same Tender
                      every 7 days. You may support different
                      Tenders during that same period.
                    </p>
                  </div>

                  <p>
                    Rankings are based only on qualifying Contest
                    Entries associated with the current contest.
                    A Tender&apos;s lifetime TenderFans Shout total
                    is separate and does not determine contest
                    standings.
                  </p>

                  <div className="contest-prize-grid">
                    <div>
                      <span>🥇 1st Place</span>
                      <strong>$750 cash</strong>
                    </div>

                    <div>
                      <span>🥈 2nd Place</span>
                      <strong>$250 cash</strong>
                    </div>

                    <div>
                      <span>🥉 3rd Place</span>
                      <strong>
                        TenderFans Swag Bag
                      </strong>
                      <small>ARV $150</small>
                    </div>
                  </div>

                  <p>
                    No purchase is necessary. Joining TenderFans
                    marketing messages is optional and does not
                    affect your ability to participate or the value
                    of your Shout.
                  </p>

                  <p>
                    Current standings are unofficial until
                    TenderFans reviews and certifies the final
                    results.
                  </p>

                  {contest.rules_text && (
                    <div className="contest-info-special-note">
                      <strong>
                        Special Contest Notes
                      </strong>

                      <div>
                        {contest.rules_text}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {contestInfoTab === "rules" && (
                <div className="contest-rules-sections">
                  <h3>Official Rules</h3>

                  <section>
                    <h4>1. Sponsor</h4>
                    <p>
                      The Contest is sponsored and administered
                      by TenderFans LLC, a Florida limited
                      liability company (&quot;TenderFans&quot;
                      or &quot;Sponsor&quot;).
                    </p>
                  </section>

                  <section>
                    <h4>2. Eligibility</h4>
                    <p>
                      Participation is open to legal residents of
                      the United States who are 18 years of age
                      or older at the time of entry.
                    </p>

                    <p>
                      A prize-winning Tender must also be at least
                      18 years old, be legally eligible to receive
                      the applicable prize, and provide information
                      reasonably required by TenderFans to verify
                      identity, eligibility, and satisfy applicable
                      tax or reporting requirements. Void where
                      prohibited by law.
                    </p>
                  </section>

                  <section>
                    <h4>3. Contest Period</h4>
                    <p>
                      This Contest runs from{" "}
                      <strong>
                        {new Date(
                          contest.starts_at
                        ).toLocaleString()}
                      </strong>{" "}
                      through{" "}
                      <strong>
                        {new Date(
                          contest.ends_at
                        ).toLocaleString()}
                      </strong>.
                    </p>

                    <p>
                      Entries received outside the Contest Period
                      do not qualify except during an officially
                      announced overtime period.
                    </p>
                  </section>

                  <section>
                    <h4>4. How to Participate</h4>
                    <p>
                      No purchase is necessary. A participant
                      selects an eligible Tender, completes
                      TenderFans&apos; mobile-number verification,
                      accepts the contest terms, and submits a
                      Shout. A successfully verified and eligible
                      submission creates a qualifying Contest
                      Entry.
                    </p>
                  </section>

                  <section>
                    <h4>5. Entry Limit</h4>
                    <p>
                      A verified participant may submit one
                      qualifying Contest Entry for the same Tender
                      during each rolling 7-day period.
                    </p>

                    <p>
                      A participant may submit qualifying entries
                      for different Tenders during that same
                      period.
                    </p>

                    <p>
                      Attempts to circumvent this restriction
                      through additional numbers, automated
                      systems, fabricated identities, or other
                      means may result in disqualification of
                      affected entries.
                    </p>
                  </section>

                  <section>
                    <h4>6. Eligible Tenders</h4>
                    <p>
                      A Tender must represent a genuine hospitality
                      professional associated with a legitimate
                      Spot or hospitality establishment and
                      otherwise satisfy TenderFans&apos;
                      eligibility requirements.
                    </p>

                    <p>
                      A Tender does not need to own, claim, or
                      administer a TenderFans profile to receive
                      qualifying Contest Entries.
                    </p>
                  </section>

                  <section>
                    <h4>7. Scoring and Standings</h4>
                    <p>
                      Rankings are determined by the number of
                      qualifying Contest Entries received by each
                      Tender for the applicable contest.
                    </p>

                    <p>
                      Lifetime TenderFans Shout totals are separate
                      and do not determine contest standings.
                      Public standings are preliminary and subject
                      to verification.
                    </p>
                  </section>

                  <section>
                    <h4>8. Standard Prizes</h4>
                    <p>
                      Subject to the tie provisions below:
                    </p>

                    <ul>
                      <li>
                        First Place: $750 cash.
                      </li>
                      <li>
                        Second Place: $250 cash.
                      </li>
                      <li>
                        Third Place: one TenderFans Swag Bag,
                        ARV $150.
                      </li>
                    </ul>
                  </section>

                  <section>
                    <h4>9. First-Place Overtime</h4>
                    <p>
                      If two or more Tenders are tied for first
                      place when the scheduled Contest Period ends,
                      the Tenders tied for first enter a 48-hour
                      overtime period.
                    </p>

                    <p>
                      Existing contest totals carry forward.
                      Qualifying Contest Entries continue to
                      accumulate under the same entry restrictions,
                      including the rolling 7-day limit.
                    </p>

                    <p>
                      If the tie is broken during overtime, final
                      first- and second-place awards are determined
                      by the resulting standings.
                    </p>
                  </section>

                  <section>
                    <h4>
                      10. First-Place Tie Remaining After Overtime
                    </h4>

                    <p>
                      If a first-place tie remains when the 48-hour
                      overtime period expires, the Tenders
                      remaining tied for first will divide the
                      $1,000 cash prize pool equally.
                    </p>

                    <p>
                      The next-ranked Tender will receive a
                      TenderFans Swag Bag. If multiple Tenders are
                      tied at that next position, each will receive
                      a Swag Bag.
                    </p>
                  </section>

                  <section>
                    <h4>11. Other Ties</h4>

                    <p>
                      If first place is undisputed and exactly two
                      Tenders tie for second place, each receives
                      $125 cash and each receives a TenderFans
                      Swag Bag.
                    </p>

                    <p>
                      If first place is undisputed and three or
                      more Tenders tie for second place, each
                      Tender tied for second will receive a
                      TenderFans Swag Bag in lieu of the $250
                      second-place cash prize.
                    </p>

                    <p>
                      If first and second places are undisputed and
                      multiple Tenders tie for third place, each
                      Tender tied for third will receive a
                      TenderFans Swag Bag.
                    </p>
                  </section>

                  <section>
                    <h4>12. Winner Verification</h4>
                    <p>
                      Results are not final until reviewed and
                      certified by TenderFans. Potential winners
                      may be required to verify identity, age,
                      eligibility, and other information reasonably
                      necessary to award a prize.
                    </p>

                    <p>
                      Failure to provide requested information
                      within a reasonable period specified by
                      TenderFans may result in forfeiture, subject
                      to applicable law.
                    </p>
                  </section>

                  <section>
                    <h4>13. Fraud, Manipulation and Abuse</h4>
                    <p>
                      Automated entries, bots, fabricated
                      identities, unauthorized use of another
                      person&apos;s mobile number, coordinated
                      manipulation, attempts to circumvent entry
                      limits, or other fraudulent or abusive
                      activity are prohibited.
                    </p>

                    <p>
                      TenderFans may investigate and exclude
                      entries reasonably determined to violate
                      these Official Rules. Entries will not be
                      arbitrarily removed.
                    </p>
                  </section>

                  <section>
                    <h4>14. Technical Problems</h4>
                    <p>
                      TenderFans is not responsible for entries
                      that cannot be completed because of network
                      outages, telecommunications failures,
                      corrupted transmissions, service-provider
                      failures, or other technical conditions
                      outside TenderFans&apos; reasonable control.
                    </p>

                    <p>
                      TenderFans may suspend, extend, modify, or
                      cancel a contest when fraud, technical
                      failure, force majeure, or another
                      circumstance materially compromises the
                      integrity or operation of the contest,
                      subject to applicable law.
                    </p>
                  </section>

                  <section>
                    <h4>15. Taxes and Prize Conditions</h4>
                    <p>
                      Winners are responsible for taxes, fees, or
                      other obligations associated with receipt of
                      a prize.
                    </p>

                    <p>
                      Cash prizes will be paid using a method
                      selected by TenderFans after winner
                      verification. Prizes are nontransferable
                      before award except as expressly permitted by
                      TenderFans.
                    </p>
                  </section>

                  <section>
                    <h4>16. Publicity</h4>
                    <p>
                      Where permitted by law, winners agree that
                      TenderFans may identify their Tender name,
                      TenderFans profile, associated Spot,
                      placement, and prize in TenderFans&apos;
                      website, social media, and contest-related
                      promotional materials without additional
                      compensation.
                    </p>
                  </section>

                  <section>
                    <h4>17. Privacy</h4>
                    <p>
                      Mobile-number verification information may be
                      used to administer the contest, verify
                      participation, enforce entry limits,
                      investigate abuse, and maintain contest
                      integrity.
                    </p>

                    <p>
                      Promotional SMS enrollment is separate,
                      optional, and is not required to participate.
                    </p>
                  </section>

                  <section>
                    <h4>18. Governing Law</h4>
                    <p>
                      The Contest and these Official Rules are
                      governed by applicable federal law and the
                      laws of the State of Florida, without regard
                      to conflict-of-law principles.
                    </p>

                    <p>
                      Any dispute shall be handled in an
                      appropriate court having jurisdiction in
                      Florida unless applicable law requires
                      otherwise.
                    </p>
                  </section>

                  <section>
                    <h4>19. Sponsor Decisions</h4>
                    <p>
                      TenderFans&apos; good-faith determinations
                      regarding eligibility, qualifying entries,
                      standings, and application of these Official
                      Rules are final to the extent permitted by
                      law.
                    </p>
                  </section>
                </div>
              )}

              {contestInfoTab === "disclaimers" && (
                <div className="contest-disclaimer-sections">
                  <h3>
                    Important Disclosures
                  </h3>

                  <section>
                    <h4>No Purchase Necessary</h4>

                    <p>
                      Making a purchase, creating a paid
                      relationship with TenderFans, or opting into
                      promotional messages does not improve a
                      participant&apos;s chances or give a Tender
                      additional contest credit.
                    </p>
                  </section>

                  <section>
                    <h4>
                      Contest Verification and Marketing Are Separate
                    </h4>

                    <p>
                      A mobile number submitted solely for contest
                      verification is used for contest
                      administration, eligibility enforcement, and
                      integrity purposes.
                    </p>

                    <p>
                      It is not enrolled in TenderFans promotional
                      SMS marketing unless the participant
                      separately and affirmatively opts in.
                    </p>
                  </section>

                  <section>
                    <h4>Optional SMS Marketing</h4>

                    <p>
                      If you separately consent to TenderFans
                      marketing texts, you agree to receive
                      promotional SMS messages from TenderFans at
                      the number provided.
                    </p>

                    <p>
                      Consent is not a condition of contest
                      participation. Message frequency may vary.
                      Message and data rates may apply. You may
                      withdraw consent, including by replying STOP
                      to a TenderFans marketing message.
                    </p>
                  </section>

                  <section>
                    <h4>Leaderboard Disclaimer</h4>

                    <p>
                      Public leaderboard standings are unofficial
                      and may change as qualifying entries are
                      received, reviewed, or determined to be
                      ineligible.
                    </p>

                    <p>
                      Final winners are established only after
                      TenderFans certifies the results.
                    </p>
                  </section>

                  <section>
                    <h4>Independent Establishments</h4>

                    <p>
                      A Tender&apos;s association with a bar,
                      restaurant, venue, or other Spot does not
                      mean that establishment sponsors,
                      administers, endorses, or is affiliated with
                      the Contest unless TenderFans expressly
                      states otherwise.
                    </p>
                  </section>

                  <section>
                    <h4>TenderFans Administration</h4>

                    <p>
                      TenderFans may investigate suspected fraud
                      or manipulation and apply the Official Rules
                      to protect participants and the integrity of
                      the Contest.
                    </p>
                  </section>
                </div>
              )}
            </div>

            <div className="contest-info-footer">
              <button
                type="button"
                className="btn primary"
                onClick={() => setShowDetails(false)}
              >
                Back to Contest
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
