"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Finding = {
  id: string;
  venue_name: string;
  website_url: string;
  fetched_url: string | null;
};

export default function ChallengeEncounteredPage() {
  const [rows, setRows] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    void (async () => {
      const result = await supabase.rpc(
        "admin_event_harvest_challenge_findings",
      );

      if (!active) return;

      if (result.error) {
        setError(result.error.message);
      } else {
        setRows((result.data ?? []) as Finding[]);
      }

      setLoading(false);
    })();

    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="flow-page">
      <div className="shell">
        <section
          className="flow-card"
          style={{
            maxWidth: "1200px",
            margin: "0 auto",
          }}
        >
          <Link href="/admin/harvester">
            ← Harvester Management
          </Link>

          <div
            className="eyebrow"
            style={{ marginTop: "22px" }}
          >
            EVENT HARVESTER
          </div>

          <h1>Challenge Encountered</h1>

          <p className="lead-copy">
            Sites presenting verified CAPTCHA or bot-access challenges.
          </p>

          {loading ? (
            <p>Loading findings...</p>
          ) : error ? (
            <p>Unable to load challenge findings: {error}</p>
          ) : rows.length === 0 ? (
            <p>No active challenges.</p>
          ) : (
            <div style={{ display: "grid", gap: "10px" }}>
              {rows.map((row) => (
                <div
                  key={row.id}
                  style={{
                    padding: "14px 18px",
                    border: "1px solid rgba(20,35,45,.12)",
                    borderRadius: "10px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: "12px",
                  }}
                >
                  <strong>{row.venue_name}</strong>

                  <a
                    href={row.fetched_url || row.website_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open Challenged Page ↗
                  </a>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
