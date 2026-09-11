"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Contest = {
  id: string;
  title: string;
  prize_text: string;
  starts_at: string;
  ends_at: string;
  is_active: boolean;
  flyer_url: string | null;
};

type ContestLeader = {
  id: string;
  slug: string;
  name: string;
  spotName: string;
  contestShouts: number;
  socials: {
    platform: string;
    handle: string;
  }[];
};

export default function AdminContestsPage() {
  const [contests, setContests] = useState<Contest[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  const [contestLeaders, setContestLeaders] =
    useState<ContestLeader[]>([]);

  const [verifiedParticipants, setVerifiedParticipants] =
    useState(0);

  const [marketingSubscribers, setMarketingSubscribers] =
    useState(0);

  async function loadContests() {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      window.location.href = "/login";
      return;
    }

    const { data: admin } = await supabase
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!admin) {
      window.location.href = "/account";
      return;
    }

    const { data, error } = await supabase
      .from("contests")
      .select(
        "id, title, prize_text, starts_at, ends_at, is_active, flyer_url"
      )
      .order("starts_at", { ascending: false });

    if (error) {
      setMessage(error.message);
      setLoading(false);
      return;
    }

    const loadedContests =
      (data as Contest[]) ?? [];

    setContests(loadedContests);

    const activeContest =
      loadedContests.find(
        (contest) => contest.is_active
      );

    if (!activeContest) {
      setContestLeaders([]);
      setVerifiedParticipants(0);
      setMarketingSubscribers(0);
      setLoading(false);
      return;
    }

    const [
      entryResult,
      bartenderResult,
      relationshipResult,
      socialResult,
      marketingResult,
    ] = await Promise.all([
      supabase
        .from("contest_shout_entries")
        .select(
          "bartender_id, phone_identity_id"
        )
        .eq(
          "contest_id",
          activeContest.id
        ),

      supabase
        .from("bartenders")
        .select(
          "id, slug, display_name"
        )
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

      supabase
        .from("tender_social_permissions")
        .select(
          "bartender_id, platform, social_handle, tag_permission"
        )
        .eq("tag_permission", true),

      supabase
        .from("marketing_sms_subscribers")
        .select("id", {
          count: "exact",
          head: true,
        })
        .eq("status", "active"),
    ]);

    if (entryResult.error) {
      setMessage(entryResult.error.message);
      setLoading(false);
      return;
    }

    if (bartenderResult.error) {
      setMessage(bartenderResult.error.message);
      setLoading(false);
      return;
    }

    if (relationshipResult.error) {
      setMessage(
        relationshipResult.error.message
      );
      setLoading(false);
      return;
    }

    if (socialResult.error) {
      setMessage(socialResult.error.message);
      setLoading(false);
      return;
    }

    if (marketingResult.error) {
      setMessage(
        marketingResult.error.message
      );
      setLoading(false);
      return;
    }

    const shoutCounts =
      new Map<string, number>();

    const participantIds =
      new Set<string>();

    for (const entry of entryResult.data ?? []) {
      shoutCounts.set(
        entry.bartender_id,
        (shoutCounts.get(
          entry.bartender_id
        ) ?? 0) + 1
      );

      participantIds.add(
        entry.phone_identity_id
      );
    }

    const venueMap =
      new Map<
        string,
        {
          name: string;
          isPrimary: boolean;
        }[]
      >();

    for (
      const row of
      relationshipResult.data ?? []
    ) {
      const venueData =
        (row as any).venues;

      const venue =
        Array.isArray(venueData)
          ? venueData[0]
          : venueData;

      if (!venue) continue;

      const current =
        venueMap.get(
          row.bartender_id
        ) ?? [];

      current.push({
        name: venue.name,
        isPrimary:
          Boolean(
            (row as any).is_primary
          ),
      });

      venueMap.set(
        row.bartender_id,
        current
      );
    }

    for (
      const [, spots] of venueMap
    ) {
      spots.sort(
        (a, b) =>
          Number(b.isPrimary) -
          Number(a.isPrimary)
      );
    }

    const socialMap =
      new Map<
        string,
        {
          platform: string;
          handle: string;
        }[]
      >();

    for (
      const row of
      socialResult.data ?? []
    ) {
      const current =
        socialMap.get(
          row.bartender_id
        ) ?? [];

      current.push({
        platform: row.platform,
        handle: row.social_handle,
      });

      socialMap.set(
        row.bartender_id,
        current
      );
    }

    const leaders: ContestLeader[] =
      (bartenderResult.data ?? [])
        .map((tender) => ({
          id: tender.id,
          slug: tender.slug,
          name:
            tender.display_name,
          spotName:
            venueMap.get(
              tender.id
            )?.[0]?.name ??
            "No current Spot",
          contestShouts:
            shoutCounts.get(
              tender.id
            ) ?? 0,
          socials:
            socialMap.get(
              tender.id
            ) ?? [],
        }))
        .sort(
          (a, b) =>
            b.contestShouts -
              a.contestShouts ||
            a.name.localeCompare(
              b.name
            )
        )
        .slice(0, 5);

    setContestLeaders(leaders);

    setVerifiedParticipants(
      participantIds.size
    );

    setMarketingSubscribers(
      marketingResult.count ?? 0
    );

    setLoading(false);
  }

  useEffect(() => {
    loadContests();
  }, []);

  async function setActive(contest: Contest) {
    setMessage("");

    if (!contest.is_active) {
      const { error: deactivateError } = await supabase
        .from("contests")
        .update({ is_active: false })
        .eq("is_active", true);

      if (deactivateError) {
        setMessage(deactivateError.message);
        return;
      }
    }

    const { error } = await supabase
      .from("contests")
      .update({ is_active: !contest.is_active })
      .eq("id", contest.id);

    if (error) {
      setMessage(error.message);
      return;
    }

    await loadContests();
  }

  return (
    <main className="flow-page">
      <div className="shell">
        <section className="flow-card">
          <div className="eyebrow">TENDERFANS ADMIN</div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "16px",
              flexWrap: "wrap",
            }}
          >
            <div>
              <h1 style={{ marginBottom: "6px" }}>
                Contests
              </h1>

              <p className="lead-copy" style={{ marginTop: 0 }}>
                Create, activate and manage TenderFans contests.
              </p>
            </div>

            <Link className="btn primary" href="/admin/contests/new">
              New Contest
            </Link>
          </div>

          {loading && <p>Loading contests...</p>}

          {message && (
            <p style={{ color: "crimson" }}>
              {message}
            </p>
          )}

          {!loading && contests.length === 0 && (
            <div className="privacy-note">
              No contests have been created yet.
            </div>
          )}

          <div
            style={{
              display: "grid",
              gap: "14px",
              marginTop: "24px",
            }}
          >
            {contests.map((contest) => (
              <div
                key={contest.id}
                style={{
                  border: "1px solid #d7d1c6",
                  borderRadius: "16px",
                  padding: "18px",
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  gap: "16px",
                  alignItems: "center",
                }}
              >
                <div>
                  <div
                    style={{
                      display: "flex",
                      gap: "10px",
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <strong>{contest.title}</strong>

                    <span
                      style={{
                        fontSize: "0.72rem",
                        fontWeight: 800,
                        padding: "4px 8px",
                        borderRadius: "999px",
                        background: contest.is_active
                          ? "#172735"
                          : "#ece8de",
                        color: contest.is_active
                          ? "#fff"
                          : "#697177",
                      }}
                    >
                      {contest.is_active ? "ACTIVE" : "INACTIVE"}
                    </span>
                  </div>

                  <div
                    style={{
                      color: "#697177",
                      marginTop: "5px",
                      fontSize: "0.88rem",
                    }}
                  >
                    {contest.prize_text} ·{" "}
                    {new Date(contest.starts_at).toLocaleDateString()} –{" "}
                    {new Date(contest.ends_at).toLocaleDateString()}
                  </div>
                </div>

                <div
                  style={{
                    display: "flex",
                    gap: "8px",
                    flexWrap: "wrap",
                    justifyContent: "flex-end",
                  }}
                >
                  <button
                    type="button"
                    className="btn outline"
                    onClick={() => setActive(contest)}
                  >
                    {contest.is_active ? "Deactivate" : "Activate"}
                  </button>

                  <Link
                    className="btn outline"
                    href={`/admin/contests/${contest.id}/edit`}
                  >
                    Edit
                  </Link>
                </div>
              </div>
            ))}
          </div>

          {contests.some(
            (contest) => contest.is_active
          ) && (
            <section
              style={{
                marginTop: "30px",
                paddingTop: "26px",
                borderTop:
                  "1px solid #d7d1c6",
              }}
            >
              <div className="eyebrow">
                LIVE CONTEST TRACKER
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent:
                    "space-between",
                  gap: "18px",
                  alignItems:
                    "flex-start",
                  flexWrap: "wrap",
                  marginTop: "6px",
                }}
              >
                <div>
                  <h2
                    style={{
                      margin:
                        "0 0 6px",
                    }}
                  >
                    Top 5 Tenders
                  </h2>

                  <p
                    style={{
                      margin: 0,
                      color:
                        "#697177",
                    }}
                  >
                    Rankings use qualifying
                    contest Shouts only.
                  </p>
                </div>

                <div
                  style={{
                    display: "flex",
                    gap: "10px",
                    flexWrap: "wrap",
                  }}
                >
                  <div
                    style={{
                      padding:
                        "10px 14px",
                      border:
                        "1px solid #d7d1c6",
                      borderRadius:
                        "12px",
                    }}
                  >
                    <strong>
                      {verifiedParticipants}
                    </strong>
                    <div
                      style={{
                        fontSize:
                          "0.75rem",
                        color:
                          "#697177",
                      }}
                    >
                      Verified participants
                    </div>
                  </div>

                  <div
                    style={{
                      padding:
                        "10px 14px",
                      border:
                        "1px solid #d7d1c6",
                      borderRadius:
                        "12px",
                    }}
                  >
                    <strong>
                      {marketingSubscribers}
                    </strong>
                    <div
                      style={{
                        fontSize:
                          "0.75rem",
                        color:
                          "#697177",
                      }}
                    >
                      SMS marketing subscribers
                    </div>
                  </div>
                </div>
              </div>

              <div
                style={{
                  display: "grid",
                  gap: "10px",
                  marginTop: "20px",
                }}
              >
                {contestLeaders.map(
                  (leader, index) => (
                    <div
                      key={leader.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "48px minmax(160px, 1fr) minmax(170px, 1fr) 100px minmax(190px, 1.2fr)",
                        gap: "12px",
                        alignItems:
                          "center",
                        padding:
                          "13px 14px",
                        border:
                          "1px solid #d7d1c6",
                        borderRadius:
                          "14px",
                      }}
                    >
                      <strong
                        style={{
                          fontSize:
                            "1.1rem",
                        }}
                      >
                        #{index + 1}
                      </strong>

                      <Link
                        href={`/t/${leader.slug}`}
                        className="text-link"
                      >
                        <strong>
                          {leader.name}
                        </strong>
                      </Link>

                      <span>
                        {leader.spotName}
                      </span>

                      <strong>
                        {
                          leader.contestShouts
                        }{" "}
                        {leader.contestShouts ===
                        1
                          ? "Shout"
                          : "Shouts"}
                      </strong>

                      <div
                        style={{
                          fontSize:
                            "0.82rem",
                        }}
                      >
                        {leader.socials
                          .length > 0 ? (
                          <div>
                            <strong>
                              Social tagging ✓
                            </strong>

                            {leader.socials.map(
                              (social) => (
                                <div
                                  key={`${leader.id}-${social.platform}`}
                                  style={{
                                    color:
                                      "#697177",
                                    marginTop:
                                      "2px",
                                  }}
                                >
                                  {social.platform}:{" "}
                                  {social.handle}
                                </div>
                              )
                            )}
                          </div>
                        ) : (
                          <span
                            style={{
                              color:
                                "#697177",
                            }}
                          >
                            No social permission
                          </span>
                        )}
                      </div>
                    </div>
                  )
                )}
              </div>
            </section>
          )}

          <div style={{ marginTop: "24px" }}>
            <Link href="/admin" className="text-link">
              ← Back to Admin
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
