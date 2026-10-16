"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type RedirectMatch = {
  id: string;
  tenderfans_venue_name: string;
  provider: string;
  provider_place_id: string;
  confidence_score: number;
  evidence: Record<string, unknown> | null;
};

export default function HttpRedirectPanel() {
  const [rows, setRows] = useState<RedirectMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const { data, error: loadError } = await supabase.rpc(
      "admin_pending_event_harvest_venue_matches"
    );

    if (loadError) {
      setError(loadError.message);
    } else {
      setRows(
        ((data ?? []) as RedirectMatch[]).filter(
          (item) => item.provider === "website_redirect"
        )
      );
      setError(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function review(id: string, approve: boolean) {
    if (!window.confirm(
      approve ? "Approve this website redirect?" : "Reject this website redirect?"
    )) return;

    setBusyId(id);
    setError(null);
    setMessage("");

    const { error: reviewError } = await supabase.rpc(
      "admin_review_event_harvest_venue_match",
      { p_match_id: id, p_approve: approve }
    );

    if (reviewError) {
      setError(reviewError.message);
    } else {
      await load();
      setMessage(
        approve ? "Website redirect approved." : "Website redirect rejected."
      );
    }

    setBusyId(null);
  }

  return (
    <div>
      <p style={{ marginBottom: 20 }}>
        Review website redirects before affected Spots resume normal
        detector and harvester processing.
      </p>

      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}

      {loading ? (
        <p>Loading HTTP redirects...</p>
      ) : rows.length === 0 ? (
        <p>No pending HTTP redirects.</p>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {rows.map((item) => {
            const originalUrl =
              typeof item.evidence?.registered_website_url === "string"
                ? item.evidence.registered_website_url
                : null;
            const busy = busyId !== null;

            return (
              <div
                key={item.id}
                style={{
                  padding: "12px 14px",
                  border: "1px solid rgba(20,35,45,.12)",
                  borderRadius: 10,
                  background: "rgba(255,255,255,.9)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 16,
                  flexWrap: "wrap"
                }}
              >
                <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                  <strong>{item.tenderfans_venue_name}</strong>
                  <div style={{ fontSize: ".8rem", opacity: .7 }}>
                    {Math.round(Number(item.confidence_score) * 100)}% confidence
                  </div>
                  <div style={{ fontSize: ".8rem", marginTop: 6 }}>
                    Original: {originalUrl ?? "Unavailable"}
                  </div>
                  <a
                    href={item.provider_place_id}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: ".82rem" }}
                  >
                    {item.provider_place_id}
                  </a>
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void review(item.id, true)}
                  >
                    {busyId === item.id ? "Working..." : "Approve"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void review(item.id, false)}
                  >
                    Reject
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
