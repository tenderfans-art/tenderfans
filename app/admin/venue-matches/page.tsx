"use client";

import { useEffect, useMemo, useState } from "react";
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

type UnresolvedVenue = {
  id: string;
  source_id: string;
  source_name: string;
  external_event_id: string;
  event_title: string;
  starts_at: string | null;
  source_url: string | null;
  publisher_venue_name: string;
  publisher_address: string | null;
  publisher_city: string | null;
  publisher_state_region: string | null;
  publisher_postal_code: string | null;
  suggested_venue_id: string | null;
  suggested_venue_name: string | null;
  confidence_score: number | null;
  evidence: Record<string, unknown> | null;
  first_seen_at: string;
  last_seen_at: string;
};

type Spot = {
  id: string;
  name: string;
  slug: string;
  city: string;
  state_region: string;
  status: string;
  manager_name: string | null;
  manager_role: string | null;
  manager_email: string | null;
};

type EventOccurrenceReview = {
  id: string;
  source_id: string;
  source_name: string;
  external_event_id: string;
  source_url: string | null;
  raw_title: string;
  raw_description: string | null;
  starts_at: string;
  ends_at: string | null;
  venue_id: string;
  venue_name: string;
  confidence_score: number | null;
  canonical_event_id: string | null;
  last_seen_at: string;
  created_at: string;
};

type CalendarEventVerification = {
  id: string;
  source_id: string;
  source_name: string;
  external_event_id: string;
  source_url: string | null;
  raw_title: string;
  raw_description: string | null;
  raw_starts_at: string | null;
  raw_ends_at: string | null;
  normalized_title: string | null;
  starts_at: string;
  ends_at: string | null;
  venue_id: string;
  venue_name: string;
  event_fingerprint: string | null;
  is_all_day: boolean;
  raw_payload: {
    imageUrl?: string;
    timeZone?: string;
    eventEvidence?: {
      dateBasis?: string;
      timeBasis?: string;
      titleBasis?: string;
      reviewReasons?: string[];
      requiresReview?: boolean;
      displayedWeekday?: string | null;
    };
    observation?: {
      displayedDate?: string;
      displayedTime?: string | null;
      displayedWeekday?: string | null;
      titleConfidence?: number;
      dateConfidence?: number | null;
      timeConfidence?: number | null;
    };
    resolvedObservation?: {
      localDate?: string | null;
    };
  } | null;
  last_seen_at: string;
  created_at: string;
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

function evidenceLabel(evidence: Record<string, unknown> | null, key: string) {
  const nested = evidence?.match_evidence;
  const comparisons =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : evidence;

  const value = comparisons?.[key];

  return value === true ? "Yes" : value === false ? "No" : "Unknown";
}

export default function AdminVenueMatchesPage() {
  const [matches, setMatches] = useState<VenueMatch[]>([]);
  const [unresolved, setUnresolved] = useState<UnresolvedVenue[]>([]);
  const [calendarEvents, setCalendarEvents] = useState<
    CalendarEventVerification[]
  >([]);
  const [occurrenceReviews, setOccurrenceReviews] = useState<
    EventOccurrenceReview[]
  >([]);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [spotSearch, setSpotSearch] = useState<Record<string, string>>({});
  const [selectedSpot, setSelectedSpot] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  async function loadMatches() {
    setLoading(true);
    setMessage("");

    const [
      matchResult,
      unresolvedResult,
      calendarResult,
      occurrenceResult,
      spotsResult,
    ] = await Promise.all([
      supabase.rpc("admin_pending_event_harvest_venue_matches"),
      supabase.rpc("admin_pending_event_harvest_unresolved_venues"),
      supabase.rpc("admin_list_calendar_event_verifications"),
      supabase.rpc("admin_list_event_occurrence_reviews"),
      supabase.rpc("admin_list_spots"),
    ]);

    const errors = [
      matchResult.error,
      unresolvedResult.error,
      calendarResult.error,
      occurrenceResult.error,
      spotsResult.error,
    ].filter(Boolean);

    if (errors.length > 0) {
      setMatches([]);
      setUnresolved([]);
      setCalendarEvents([]);
      setOccurrenceReviews([]);
      setSpots([]);
      setMessage(errors.map((error) => error!.message).join(" "));
      setLoading(false);
      return;
    }

    const unresolvedRows = (unresolvedResult.data as UnresolvedVenue[]) || [];

    setMatches((matchResult.data as VenueMatch[]) || []);
    setUnresolved(unresolvedRows);
    setCalendarEvents(
      (calendarResult.data as CalendarEventVerification[]) || [],
    );
    setOccurrenceReviews(
      (occurrenceResult.data as EventOccurrenceReview[]) || [],
    );
    setSpots(
      ((spotsResult.data as Spot[]) || []).filter(
        (spot) => spot.status === "active",
      ),
    );

    const defaults: Record<string, string> = {};

    for (const item of unresolvedRows) {
      if (item.suggested_venue_id) {
        defaults[item.id] = item.suggested_venue_id;
      }
    }

    setSelectedSpot(defaults);
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

  async function reviewUnresolved(id: string, approve: boolean) {
    const venueId = selectedSpot[id] || null;

    if (approve && !venueId) {
      setMessage("Select the correct TenderFans Spot before resolving.");
      return;
    }

    setReviewingId(id);
    setMessage("");

    const { error } = await supabase.rpc(
      "admin_review_event_harvest_unresolved_venue",
      {
        p_unresolved_id: id,
        p_venue_id: approve ? venueId : null,
        p_approve: approve,
      },
    );

    if (error) {
      setMessage(error.message);
      setReviewingId(null);
      return;
    }

    setMessage(
      approve ? "Publisher venue resolved." : "Publisher venue rejected.",
    );

    setReviewingId(null);
    await loadMatches();
  }

  async function reviewCalendarEvent(
    id: string,
    approve: boolean,
  ) {
    setReviewingId(id);
    setMessage("");

    const { error } = await supabase.rpc(
      "admin_review_calendar_event_verification",
      {
        p_candidate_id: id,
        p_approve: approve,
      },
    );

    if (error) {
      setMessage(error.message);
      setReviewingId(null);
      return;
    }

    setMessage(
      approve
        ? "Calendar event approved and published."
        : "Calendar event rejected.",
    );

    setReviewingId(null);
    await loadMatches();
  }

  async function reviewOccurrence(
    id: string,
    approve: boolean,
  ) {
    setReviewingId(id);
    setMessage("");

    const { error } = await supabase.rpc(
      "admin_review_event_occurrence",
      {
        p_candidate_id: id,
        p_approve: approve,
      },
    );

    if (error) {
      setMessage(error.message);
      setReviewingId(null);
      return;
    }

    setMessage(
      approve
        ? "Event approved and published."
        : "Event rejected.",
    );

    setReviewingId(null);
    await loadMatches();
  }

  const spotChoices = useMemo(() => {
    const result: Record<string, Spot[]> = {};

    for (const item of unresolved) {
      const term = (spotSearch[item.id] || "").trim().toLowerCase();

      const filtered = term
        ? spots.filter((spot) =>
            [spot.name, spot.city, spot.state_region]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
              .includes(term),
          )
        : spots;

      result[item.id] = filtered.slice(0, 5);
    }

    return result;
  }, [spots, unresolved, spotSearch]);

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
            href="/admin/harvester"
            style={{
              display: "inline-block",
              marginBottom: "22px",
              color: "inherit",
            }}
          >
            ← Harvester Management
          </Link>

          <div className="eyebrow">TENDERFANS ADMIN</div>

          <h1 style={{ marginBottom: "8px" }}>Event Venue Match Review</h1>

          <p
            className="lead-copy"
            style={{
              marginTop: 0,
              marginBottom: "28px",
            }}
          >
            Review event venue matches and event details that require human
            verification before publication.
          </p>

          {message && (
            <div
              style={{
                marginBottom: "22px",
                padding: "14px 16px",
                border: "1px solid rgba(20, 35, 45, 0.12)",
                borderRadius: "12px",
              }}
            >
              {message}
            </div>
          )}

          {loading ? (
            <p>Loading event reviews...</p>
          ) : matches.length === 0 &&
              unresolved.length === 0 &&
              calendarEvents.length === 0 &&
              occurrenceReviews.length === 0 ? (
            <div
              style={{
                padding: "32px",
                border: "1px solid rgba(20, 35, 45, 0.12)",
                borderRadius: "18px",
                background: "rgba(255,255,255,0.72)",
              }}
            >
              <h2
                style={{
                  marginTop: 0,
                  marginBottom: "8px",
                  fontSize: "1.25rem",
                }}
              >
                No events need review
              </h2>

              <p
                style={{
                  margin: 0,
                  opacity: 0.72,
                  lineHeight: 1.55,
                }}
              >
                Venue attribution and event-detail questions will appear here
                automatically when the Event Harvester needs human verification.
              </p>
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gap: "20px",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "minmax(280px, 2fr) minmax(150px, 1fr) 150px 185px 82px 82px",
                  gap: "8px",
                  alignItems: "end",
                  padding: "0 10px",
                  fontSize: "0.66rem",
                  fontWeight: 800,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  opacity: 0.55,
                }}
              >
                <span>Event / Source</span>
                <span>Suggested Match</span>
                <span>Spot Search</span>
                <span>Select Spot</span>
                <span
                  style={{
                    gridColumn: "5 / 7",
                    textAlign: "center",
                  }}
                >
                  Action
                </span>
              </div>

              {unresolved.map((item) => {
                const busy = reviewingId === item.id;
                const choices = spotChoices[item.id] || [];

                return (
                  <div
                    key={`unresolved-${item.id}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "minmax(280px, 2fr) minmax(150px, 1fr) 150px 185px 82px 82px",
                      alignItems: "center",
                      gap: "8px",
                      padding: "8px 10px",
                      border: "1px solid rgba(20, 35, 45, 0.12)",
                      borderRadius: "10px",
                      background: "rgba(255,255,255,0.9)",
                    }}
                  >
                    <div
                      style={{
                        minWidth: 0,
                        fontSize: "0.88rem",
                      }}
                    >
                      {item.source_url ? (
                        <a
                          href={item.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`${item.event_title} — Open source`}
                          style={{
                            display: "block",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            fontWeight: 700,
                            color: "inherit",
                            textDecoration: "underline",
                            textDecorationThickness: "1px",
                            textUnderlineOffset: "3px",
                          }}
                        >
                          {item.event_title}
                        </a>
                      ) : (
                        <strong
                          title={item.event_title}
                          style={{
                            display: "block",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {item.event_title}
                        </strong>
                      )}
                    </div>

                    <div
                      style={{
                        minWidth: 0,
                        fontSize: "0.88rem",
                      }}
                    >
                      {item.suggested_venue_name ? (
                        <strong
                          title={item.suggested_venue_name}
                          style={{
                            display: "block",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {item.suggested_venue_name}
                        </strong>
                      ) : (
                        <span style={{ opacity: 0.55 }}>No suggestion</span>
                      )}
                    </div>

                    <input
                      type="search"
                      value={spotSearch[item.id] || ""}
                      onChange={(event) =>
                        setSpotSearch((current) => ({
                          ...current,
                          [item.id]: event.target.value,
                        }))
                      }
                      placeholder="Search Spots..."
                      aria-label="Search TenderFans Spots"
                      style={{
                        width: "150px",
                        minWidth: "130px",
                        padding: "7px 9px",
                        fontSize: "0.82rem",
                      }}
                    />

                    <select
                      value={selectedSpot[item.id] || ""}
                      onChange={(event) =>
                        setSelectedSpot((current) => ({
                          ...current,
                          [item.id]: event.target.value,
                        }))
                      }
                      style={{
                        width: "185px",
                        minWidth: "160px",
                        padding: "7px 9px",
                        fontSize: "0.82rem",
                      }}
                    >
                      <option value="">Select Spot...</option>

                      {choices.map((spot) => (
                        <option key={spot.id} value={spot.id}>
                          {spot.name}
                          {spot.city ? ` — ${spot.city}` : ""}
                        </option>
                      ))}
                    </select>

                    <button
                      type="button"
                      disabled={busy || !selectedSpot[item.id]}
                      onClick={() => reviewUnresolved(item.id, true)}
                      style={{
                        padding: "7px 11px",
                        border: 0,
                        borderRadius: "8px",
                        cursor:
                          busy || !selectedSpot[item.id]
                            ? "default"
                            : "pointer",
                        fontWeight: 700,
                        fontSize: "0.8rem",
                        whiteSpace: "nowrap",
                        opacity: busy || !selectedSpot[item.id] ? 0.55 : 1,
                      }}
                    >
                      {busy ? "Working..." : "Resolve"}
                    </button>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => reviewUnresolved(item.id, false)}
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
                );
              })}

              {occurrenceReviews.map((item) => {
                const busy = reviewingId === item.id;

                const proposedDate = new Date(
                  item.starts_at,
                ).toLocaleDateString();

                const proposedTime = new Date(
                  item.starts_at,
                ).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                });

                return (
                  <div
                    key={`occurrence-${item.id}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "minmax(280px, 2fr) minmax(150px, 1fr) 150px 185px 82px 82px",
                      alignItems: "center",
                      gap: "8px",
                      padding: "8px 10px",
                      border: "1px solid rgba(20, 35, 45, 0.12)",
                      borderRadius: "10px",
                      background: "rgba(255,255,255,0.9)",
                    }}
                  >
                    <div
                      style={{
                        minWidth: 0,
                        fontSize: "0.88rem",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.source_url ? (
                        <a
                          href={item.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`${item.raw_title} — Open source`}
                          style={{
                            display: "block",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            fontWeight: 700,
                            color: "inherit",
                            textDecoration: "underline",
                            textDecorationThickness: "1px",
                            textUnderlineOffset: "3px",
                          }}
                        >
                          {item.raw_title}
                        </a>
                      ) : (
                        <strong>{item.raw_title}</strong>
                      )}

                      <span
                        style={{
                          fontSize: "0.78rem",
                          opacity: 0.62,
                        }}
                      >
                        {proposedDate} · {proposedTime}
                      </span>
                    </div>

                    <div
                      style={{
                        minWidth: 0,
                        fontSize: "0.88rem",
                      }}
                    >
                      <strong>{item.venue_name}</strong>
                    </div>

                    <div
                      style={{
                        fontSize: "0.78rem",
                        opacity: 0.7,
                      }}
                    >
                      {item.source_name}
                    </div>

                    <div
                      style={{
                        fontSize: "0.76rem",
                        lineHeight: 1.35,
                      }}
                    >
                      Possible duplicate occurrence
                    </div>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        reviewOccurrence(item.id, true)
                      }
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
                      onClick={() =>
                        reviewOccurrence(item.id, false)
                      }
                      style={{
                        padding: "6px 10px",
                        border:
                          "1px solid rgba(20, 35, 45, 0.2)",
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
                );
              })}

              {calendarEvents.map((item) => {
                const busy = reviewingId === item.id;
                const evidence = item.raw_payload?.eventEvidence;
                const imageUrl = item.raw_payload?.imageUrl;

                const proposedDate = new Date(
                  item.starts_at,
                ).toLocaleDateString([], {
                  timeZone: item.raw_payload?.timeZone,
                });

                const proposedTime = new Date(
                  item.starts_at,
                ).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                  timeZone: item.raw_payload?.timeZone,
                });

                return (
                  <div
                    key={`calendar-${item.id}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "minmax(280px, 2fr) minmax(150px, 1fr) 150px 185px 82px 82px",
                      alignItems: "center",
                      gap: "8px",
                      padding: "8px 10px",
                      border: "1px solid rgba(20, 35, 45, 0.12)",
                      borderRadius: "10px",
                      background: "rgba(255,255,255,0.9)",
                    }}
                  >
                    <div
                      style={{
                        minWidth: 0,
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        fontSize: "0.88rem",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.source_url ? (
                        <a
                          href={item.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`${item.raw_title} — Open source`}
                          style={{
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            fontWeight: 700,
                            color: "inherit",
                            textDecoration: "underline",
                            textDecorationThickness: "1px",
                            textUnderlineOffset: "3px",
                          }}
                        >
                          {item.raw_title}
                        </a>
                      ) : (
                        <strong
                          title={item.raw_title}
                          style={{
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {item.raw_title}
                        </strong>
                      )}

                      <span
                        style={{
                          flexShrink: 0,
                          fontSize: "0.78rem",
                          opacity: 0.62,
                        }}
                      >
                        · {proposedDate} · {proposedTime}
                      </span>
                    </div>

                    <div
                      style={{
                        minWidth: 0,
                        fontSize: "0.88rem",
                      }}
                    >
                      <strong
                        title={item.venue_name}
                        style={{
                          display: "block",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {item.venue_name}
                      </strong>
                    </div>

                    <div
                      style={{
                        fontSize: "0.82rem",
                      }}
                    >
                      {imageUrl ? (
                        <a
                          href={imageUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            display: "inline-block",
                            padding: "7px 10px",
                            border:
                              "1px solid rgba(20, 35, 45, 0.2)",
                            borderRadius: "8px",
                            color: "inherit",
                            fontWeight: 700,
                            textDecoration: "none",
                            whiteSpace: "nowrap",
                          }}
                        >
                          View Calendar
                        </a>
                      ) : (
                        <span style={{ opacity: 0.55 }}>
                          No calendar file
                        </span>
                      )}
                    </div>

                    <div
                      style={{
                        minWidth: 0,
                        fontSize: "0.76rem",
                        lineHeight: 1.35,
                        padding: 0,
                        borderRadius: 0,
                        background: "transparent",
                      }}
                    >

                      {evidence?.reviewReasons?.includes(
                        "calendar_date_inferred_from_explicit_weekday",
                      )
                        ? `${evidence.displayedWeekday || "Weekday"} shown · date inferred`
                        : evidence?.reviewReasons?.join(", ") ||
                          "Verification required"}
                    </div>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        reviewCalendarEvent(item.id, true)
                      }
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
                      onClick={() =>
                        reviewCalendarEvent(item.id, false)
                      }
                      style={{
                        padding: "6px 10px",
                        border:
                          "1px solid rgba(20, 35, 45, 0.2)",
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
                );
              })}

              {matches.map((match) => {
                const busy = reviewingId === match.id;
                const isRedirect = match.provider === "website_redirect";
                const originalUrl =
                  typeof match.evidence?.registered_website_url === "string"
                    ? match.evidence.registered_website_url
                    : null;
                const verifiedUrl = isRedirect
                  ? match.provider_place_id
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
                      rowGap: "5px",
                      padding: "10px 12px",
                      border: "1px solid rgba(20, 35, 45, 0.12)",
                      borderRadius: "10px",
                      background: "rgba(255,255,255,0.9)",
                      fontSize: "0.88rem",
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
                      style={{
                        textAlign: "right",
                        fontSize: "0.76rem",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <strong>
                        {Math.round(Number(match.confidence_score) * 100)}%
                      </strong>
                      <span style={{ opacity: 0.6 }}> confidence</span>
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
                        display: "flex",
                        justifyContent: "flex-end",
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
                        Deny
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
