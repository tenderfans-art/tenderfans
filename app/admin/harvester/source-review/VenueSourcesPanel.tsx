"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type VenueMatch = {
  id: string;
  venue_id: string;
  tenderfans_venue_name: string;
  tenderfans_address: string | null;
  tenderfans_city: string | null;
  tenderfans_state_region: string | null;
  tenderfans_postal_code: string | null;
  provider: string;
  provider_place_id: string;
  provider_venue_name: string;
  provider_address: string | null;
  provider_city: string | null;
  provider_state_region: string | null;
  provider_postal_code: string | null;
  confidence_score: number;
  evidence: Record<string, unknown> | null;
  first_seen_at: string;
  last_seen_at: string;
};

function formatAddress(
  address: string | null,
  city: string | null,
  state: string | null,
  postalCode: string | null,
) {
  const locality = [city, state].filter(Boolean).join(", ");

  return [address, [locality, postalCode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join("\n");
}

export default function VenueSourcesPanel() {
  const [matches, setMatches] = useState<VenueMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  async function loadMatches() {
    setLoading(true);

    const { data, error } = await supabase.rpc(
      "admin_pending_event_harvest_venue_matches"
    );

    if (error) {
      setMatches([]);
      setMessage(error.message);
    } else {
      setMatches(
        ((data as VenueMatch[]) || []).filter(
          (match) => match.provider !== "website_redirect"
        )
      );
    }

    setLoading(false);
  }

  async function reviewMatch(id: string, approve: boolean) {
    setReviewingId(id);
    setMessage("");

    const { error } = await supabase.rpc(
      "admin_review_event_harvest_venue_match",
      {
        p_match_id: id,
        p_approve: approve,
      },
    );

    if (error) {
      setMessage(error.message);
      setReviewingId(null);
      return;
    }

    setMessage(approve ? "Venue match approved." : "Venue match rejected.");

    setReviewingId(null);
    await loadMatches();
  }


  useEffect(() => {
    void loadMatches();
  }, []);

  return (
    <div>
      <p style={{ marginBottom: 20 }}>
        Verify external venue and source associations with existing
        TenderFans Spots before approving their use by harvesters.
      </p>

      {message && (
        <p role="status" style={{ marginBottom: 16 }}>
          {message}
        </p>
      )}

      {loading ? (
        <p>Loading venue source reviews...</p>
      ) : matches.length === 0 ? (
        <p>No venue source associations need review.</p>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
              {matches.map((match) => {
                const busy = reviewingId === match.id;
                const isRedirect = match.provider === "website_redirect";
                const originalUrl =
                  typeof match.evidence?.registered_website_url === "string"
                    ? match.evidence.registered_website_url
                    : null;
                const verifiedUrl = isRedirect
                  ? match.provider_place_id
                  : match.provider === "ticketmaster"
                    ? `https://www.ticketmaster.com/venue/${encodeURIComponent(match.provider_place_id)}`
                    : null;

                return (
                  <article
                    key={match.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "minmax(280px, 2fr) minmax(280px, 1.5fr) minmax(185px, 1fr)",
                      gridTemplateRows: "auto auto",
                      alignItems: "center",
                      columnGap: "16px",
                      rowGap: "0px",
                      padding: "4px 10px",
                      border: "1px solid rgba(20, 35, 45, 0.12)",
                      borderRadius: "10px",
                      background: "rgba(255,255,255,0.9)",
                      fontSize: "0.88rem",
                    }}
                  >
                    <div
                      style={{
                        minWidth: 0,
                        display: "flex",
                        alignItems: "baseline",
                        gap: "10px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <strong
                        title={match.tenderfans_venue_name}
                        style={{
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {match.tenderfans_venue_name}
                      </strong>
                      <span
                        style={{
                          flexShrink: 0,
                          fontSize: "0.72rem",
                          opacity: 0.65,
                        }}
                      >
                        {Math.round(Number(match.confidence_score) * 100)}%
                        {" confidence"}
                      </span>
                    </div>

                    <div
                      style={{
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {verifiedUrl ? (
                        <a
                          href={verifiedUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={verifiedUrl}
                          style={{
                            fontWeight: 700,
                            color: "inherit",
                            textDecoration: "underline",
                          }}
                        >
                          {verifiedUrl}
                        </a>
                      ) : (
                        <strong>{match.provider_venue_name}</strong>
                      )}
                    </div>

                    <div
                      title={formatAddress(
                        match.tenderfans_address,
                        match.tenderfans_city,
                        match.tenderfans_state_region,
                        match.tenderfans_postal_code,
                      )}
                      style={{
                        minWidth: 0,
                        fontSize: "0.76rem",
                        opacity: 0.7,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {formatAddress(
                        match.tenderfans_address,
                        match.tenderfans_city,
                        match.tenderfans_state_region,
                        match.tenderfans_postal_code,
                      ).replace(/\\n/g, ", ") || "No address available"}
                    </div>

                    <div
                      title={originalUrl ?? undefined}
                      style={{
                        minWidth: 0,
                        fontSize: "0.76rem",
                        opacity: 0.7,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {isRedirect
                        ? `Original URL: ${originalUrl ?? "Unavailable"}`
                        : `${match.provider}: ${match.provider_venue_name}`}
                    </div>

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "82px 82px",
                        justifyContent: "end",
                        alignItems: "center",
                        gridColumn: 3,
                        gridRow: "1 / 3",
                        gap: "8px",
                      }}
                    >
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => reviewMatch(match.id, true)}
                        style={{
                          padding: "7px 11px",
                          border: 0,
                          borderRadius: "8px",
                          cursor: busy ? "default" : "pointer",
                          fontWeight: 700,
                          fontSize: "0.8rem",
                          whiteSpace: "nowrap",
                          opacity: busy ? 0.55 : 1,
                        }}
                      >
                        {busy ? "Working..." : "Approve"}
                      </button>

                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => reviewMatch(match.id, false)}
                        style={{
                          padding: "6px 10px",
                          border: "1px solid rgba(20, 35, 45, 0.2)",
                          borderRadius: "8px",
                          background: "transparent",
                          cursor: busy ? "default" : "pointer",
                          fontWeight: 700,
                          fontSize: "0.8rem",
                          whiteSpace: "nowrap",
                        }}
                      >
                        Reject
                      </button>
                    </div>
                  </article>
                );
              })}
        </div>
      )}
    </div>
  );
}
