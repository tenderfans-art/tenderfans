"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
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
  postalCode: string | null
) {
  const locality = [city, state]
    .filter(Boolean)
    .join(", ");

  return [
    address,
    [locality, postalCode]
      .filter(Boolean)
      .join(" "),
  ]
    .filter(Boolean)
    .join("\n");
}

function evidenceLabel(
  evidence: Record<string, unknown> | null,
  key: string
) {
  return evidence?.[key] === true ? "Yes" : "No";
}

export default function AdminVenueMatchesPage() {
  const [matches, setMatches] = useState<VenueMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [reviewingId, setReviewingId] =
    useState<string | null>(null);

  async function loadMatches() {
    setLoading(true);
    setMessage("");

    const { data, error } = await supabase.rpc(
      "admin_pending_event_harvest_venue_matches"
    );

    if (error) {
      setMatches([]);
      setMessage(error.message);
    } else {
      setMatches((data as VenueMatch[]) || []);
    }

    setLoading(false);
  }

  async function reviewMatch(
    id: string,
    approve: boolean
  ) {
    setReviewingId(id);
    setMessage("");

    const { error } = await supabase.rpc(
      "admin_review_event_harvest_venue_match",
      {
        p_match_id: id,
        p_approve: approve,
      }
    );

    if (error) {
      setMessage(error.message);
      setReviewingId(null);
      return;
    }

    setMessage(
      approve
        ? "Venue match approved."
        : "Venue match rejected."
    );

    setReviewingId(null);
    await loadMatches();
  }

  useEffect(() => {
    loadMatches();
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
          <Link
            href="/admin"
            style={{
              display: "inline-block",
              marginBottom: "22px",
              color: "inherit",
            }}
          >
            ← Admin Dashboard
          </Link>

          <div className="eyebrow">
            TENDERFANS ADMIN
          </div>

          <h1 style={{ marginBottom: "8px" }}>
            Venue Matches
          </h1>

          <p
            className="lead-copy"
            style={{
              marginTop: 0,
              marginBottom: "28px",
            }}
          >
            Review uncertain matches between
            TenderFans Spots and external event
            provider venues.
          </p>

          {message && (
            <div
              style={{
                marginBottom: "22px",
                padding: "14px 16px",
                border:
                  "1px solid rgba(20, 35, 45, 0.12)",
                borderRadius: "12px",
              }}
            >
              {message}
            </div>
          )}

          {loading ? (
            <p>Loading venue matches...</p>
          ) : matches.length === 0 ? (
            <div
              style={{
                padding: "32px",
                border:
                  "1px solid rgba(20, 35, 45, 0.12)",
                borderRadius: "18px",
                background:
                  "rgba(255,255,255,0.72)",
              }}
            >
              <h2
                style={{
                  marginTop: 0,
                  marginBottom: "8px",
                  fontSize: "1.25rem",
                }}
              >
                No venue matches need review
              </h2>

              <p
                style={{
                  margin: 0,
                  opacity: 0.72,
                  lineHeight: 1.55,
                }}
              >
                Ambiguous provider matches will
                appear here automatically when the
                Event Harvester finds them.
              </p>
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gap: "20px",
              }}
            >
              {matches.map((match) => {
                const busy =
                  reviewingId === match.id;

                return (
                  <article
                    key={match.id}
                    style={{
                      padding: "22px",
                      border:
                        "1px solid rgba(20, 35, 45, 0.12)",
                      borderRadius: "18px",
                      background:
                        "rgba(255,255,255,0.9)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent:
                          "space-between",
                        gap: "20px",
                        alignItems: "flex-start",
                        marginBottom: "20px",
                      }}
                    >
                      <div>
                        <div
                          className="eyebrow"
                          style={{
                            marginBottom: "6px",
                          }}
                        >
                          MATCH REVIEW
                        </div>

                        <h2
                          style={{
                            margin: 0,
                            fontSize: "1.35rem",
                          }}
                        >
                          {
                            match.tenderfans_venue_name
                          }
                        </h2>
                      </div>

                      <div
                        style={{
                          textAlign: "right",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <strong
                          style={{
                            fontSize: "1.25rem",
                          }}
                        >
                          {Math.round(
                            Number(
                              match.confidence_score
                            ) * 100
                          )}
                          %
                        </strong>

                        <div
                          style={{
                            fontSize: "0.75rem",
                            opacity: 0.6,
                          }}
                        >
                          confidence
                        </div>
                      </div>
                    </div>

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "repeat(auto-fit, minmax(260px, 1fr))",
                        gap: "18px",
                      }}
                    >
                      <div
                        style={{
                          padding: "18px",
                          borderRadius: "14px",
                          background:
                            "rgba(245,243,236,0.65)",
                        }}
                      >
                        <strong>
                          TenderFans Spot
                        </strong>

                        <h3
                          style={{
                            margin:
                              "10px 0 8px",
                          }}
                        >
                          {
                            match.tenderfans_venue_name
                          }
                        </h3>

                        <div
                          style={{
                            whiteSpace: "pre-line",
                            lineHeight: 1.55,
                            opacity: 0.75,
                          }}
                        >
                          {formatAddress(
                            match.tenderfans_address,
                            match.tenderfans_city,
                            match.tenderfans_state_region,
                            match.tenderfans_postal_code
                          ) || "No address available"}
                        </div>
                      </div>

                      <div
                        style={{
                          padding: "18px",
                          borderRadius: "14px",
                          background:
                            "rgba(245,243,236,0.65)",
                        }}
                      >
                        <strong>
                          {match.provider ===
                          "ticketmaster"
                            ? "Ticketmaster Venue"
                            : "Provider Venue"}
                        </strong>

                        <h3
                          style={{
                            margin:
                              "10px 0 8px",
                          }}
                        >
                          {
                            match.provider_venue_name
                          }
                        </h3>

                        <div
                          style={{
                            whiteSpace: "pre-line",
                            lineHeight: 1.55,
                            opacity: 0.75,
                          }}
                        >
                          {formatAddress(
                            match.provider_address,
                            match.provider_city,
                            match.provider_state_region,
                            match.provider_postal_code
                          ) || "No address available"}
                        </div>

                        <div
                          style={{
                            marginTop: "10px",
                            fontSize: "0.78rem",
                            opacity: 0.55,
                          }}
                        >
                          ID:{" "}
                          {match.provider_place_id}
                        </div>
                      </div>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: "8px",
                        marginTop: "18px",
                      }}
                    >
                      {[
                        [
                          "Name",
                          "nameExact",
                        ],
                        [
                          "Address",
                          "addressExact",
                        ],
                        [
                          "City",
                          "cityExact",
                        ],
                        [
                          "State",
                          "stateExact",
                        ],
                        [
                          "ZIP",
                          "postalExact",
                        ],
                      ].map(([label, key]) => (
                        <span
                          key={key}
                          style={{
                            padding:
                              "7px 10px",
                            borderRadius: "999px",
                            border:
                              "1px solid rgba(20, 35, 45, 0.12)",
                            fontSize: "0.78rem",
                          }}
                        >
                          {label}:{" "}
                          {evidenceLabel(
                            match.evidence,
                            key
                          )}
                        </span>
                      ))}
                    </div>

                    <div
                      style={{
                        display: "flex",
                        gap: "10px",
                        marginTop: "22px",
                        flexWrap: "wrap",
                      }}
                    >
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          reviewMatch(
                            match.id,
                            true
                          )
                        }
                        style={{
                          padding:
                            "11px 18px",
                          border: 0,
                          borderRadius: "10px",
                          cursor: busy
                            ? "default"
                            : "pointer",
                          fontWeight: 700,
                        }}
                      >
                        {busy
                          ? "Working..."
                          : "Approve Match"}
                      </button>

                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          reviewMatch(
                            match.id,
                            false
                          )
                        }
                        style={{
                          padding:
                            "11px 18px",
                          border:
                            "1px solid rgba(20, 35, 45, 0.2)",
                          borderRadius: "10px",
                          background:
                            "transparent",
                          cursor: busy
                            ? "default"
                            : "pointer",
                          fontWeight: 700,
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
        </section>
      </div>
    </main>
  );
}
