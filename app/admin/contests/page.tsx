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

export default function AdminContestsPage() {
  const [contests, setContests] = useState<Contest[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

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
    } else {
      setContests((data as Contest[]) ?? []);
    }

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
