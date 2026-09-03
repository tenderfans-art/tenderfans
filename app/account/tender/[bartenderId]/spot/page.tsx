"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import GooglePlacePicker from "@/components/GooglePlacePicker";

type Venue = {
  id: string;
  name: string;
  city: string | null;
  state_region: string | null;
};

type Relationship = {
  id: string;
  venue_id: string;
  relationship_type: string;
  started_at: string | null;
  ended_at: string | null;
  is_primary: boolean;
  venue?: Venue;
};

type PendingRequest = {
  id: string;
  venue_id: string;
  relationship_type: string;
  request_type: string;
  requested_start_date: string | null;
  requested_end_date: string | null;
  make_primary: boolean;
  status: string;
  venue?: Venue;
};

export default function TenderManageSpotsPage() {
  const params = useParams();
  const bartenderId = params.bartenderId as string;

  const [displayName, setDisplayName] = useState("");
  const [venues, setVenues] = useState<Venue[]>([]);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [requests, setRequests] = useState<PendingRequest[]>([]);

  const [query, setQuery] = useState("");
  const [selectedVenueId, setSelectedVenueId] = useState("");
  const [relationshipType, setRelationshipType] = useState("regular");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [makePrimary, setMakePrimary] = useState(false);

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [message, setMessage] = useState("");

  async function loadData() {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      window.location.href = "/login";
      return;
    }

    const { data: permission, error: permissionError } =
      await supabase
        .from("bartender_permissions")
        .select("bartender_id, can_edit")
        .eq("bartender_id", bartenderId)
        .eq("user_id", user.id)
        .maybeSingle();

    if (permissionError) {
      setMessage(permissionError.message);
      setLoading(false);
      return;
    }

    if (!permission?.can_edit) {
      setMessage("You do not have permission to manage these Spot affiliations.");
      setLoading(false);
      return;
    }

    const [
      bartenderResult,
      relationshipResult,
      venueResult,
      requestResult,
    ] = await Promise.all([
      supabase
        .from("bartenders")
        .select("display_name")
        .eq("id", bartenderId)
        .single(),

      supabase
        .from("bartender_venues")
        .select(
          "id, venue_id, relationship_type, started_at, ended_at, is_primary"
        )
        .eq("bartender_id", bartenderId)
        .eq("is_current", true),

      supabase
        .from("venues")
        .select("id, name, city, state_region")
        .eq("status", "active")
        .order("name"),

      supabase
        .from("bartender_venue_requests")
        .select(
          "id, venue_id, relationship_type, request_type, requested_start_date, requested_end_date, make_primary, status"
        )
        .eq("bartender_id", bartenderId)
        .eq("status", "pending")
        .order("created_at", { ascending: false }),
    ]);

    if (bartenderResult.error) {
      setMessage(bartenderResult.error.message);
      setLoading(false);
      return;
    }

    if (relationshipResult.error) {
      setMessage(relationshipResult.error.message);
      setLoading(false);
      return;
    }

    if (venueResult.error) {
      setMessage(venueResult.error.message);
      setLoading(false);
      return;
    }

    if (requestResult.error) {
      setMessage(requestResult.error.message);
      setLoading(false);
      return;
    }

    const venueRows = (venueResult.data ?? []) as Venue[];
    const venueMap = new Map(
      venueRows.map((venue) => [venue.id, venue])
    );

    setDisplayName(bartenderResult.data.display_name);
    setVenues(venueRows);

    setRelationships(
      (relationshipResult.data ?? []).map((row) => ({
        ...row,
        venue: venueMap.get(row.venue_id),
      })) as Relationship[]
    );

    setRequests(
      (requestResult.data ?? []).map((row) => ({
        ...row,
        venue: venueMap.get(row.venue_id),
      })) as PendingRequest[]
    );

    setAllowed(true);
    setLoading(false);
  }

  useEffect(() => {
    loadData();
  }, [bartenderId]);

  const activeVenueIds = useMemo(
    () => new Set(relationships.map((row) => row.venue_id)),
    [relationships]
  );

  const pendingVenueIds = useMemo(
    () => new Set(requests.map((row) => row.venue_id)),
    [requests]
  );

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();

    if (!q) return [];

    return venues
      .filter(
        (venue) =>
          !activeVenueIds.has(venue.id) &&
          !pendingVenueIds.has(venue.id)
      )
      .filter((venue) =>
        `${venue.name} ${venue.city ?? ""} ${venue.state_region ?? ""}`
          .toLowerCase()
          .includes(q)
      )
      .slice(0, 8);
  }, [query, venues, activeVenueIds, pendingVenueIds]);

  const selectedVenue = venues.find(
    (venue) => venue.id === selectedVenueId
  );

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!allowed || !selectedVenueId || submitting) return;

    setSubmitting(true);
    setMessage("");

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      window.location.href = "/login";
      return;
    }

    const { error } = await supabase
      .from("bartender_venue_requests")
      .insert({
        bartender_id: bartenderId,
        venue_id: selectedVenueId,
        requested_by_user_id: user.id,
        request_type: "add",
        relationship_type: relationshipType,
        requested_start_date: startDate || null,
        requested_end_date: endDate || null,
        make_primary: makePrimary,
        status: "pending",
      });

    if (error) {
      setMessage(error.message);
      setSubmitting(false);
      return;
    }

    setMessage("Spot verification request submitted.");
    setQuery("");
    setSelectedVenueId("");
    setRelationshipType("regular");
    setStartDate("");
    setEndDate("");
    setMakePrimary(false);
    setSubmitting(false);

    await loadData();
  }

  function formatRelationship(value: string) {
    return value
      .split("_")
      .map(
        (word) =>
          word.charAt(0).toUpperCase() + word.slice(1)
      )
      .join(" ");
  }

  return (
    <main className="flow-page">
      <div className="shell">
        <div className="flow-card">
          <div className="eyebrow">Tender Account</div>
          <h1>Manage your Spots.</h1>

          <p className="lead-copy">
            Keep your verified workplaces current. You can be affiliated
            with multiple Spots at the same time.
          </p>

          {loading && <p>Loading your Spots...</p>}

          {!loading && !allowed && message && (
            <p style={{ color: "crimson" }}>{message}</p>
          )}

          {!loading && allowed && (
            <>
              <section style={{ marginTop: "16px" }}>
                <h2 style={{ margin: "0 0 8px" }}>
                  {displayName}&apos;s verified Spots
                </h2>

                {relationships.length === 0 ? (
                  <p style={{ color: "#697177" }}>
                    No verified Spot affiliations yet.
                  </p>
                ) : (
                  <div
                    style={{
                      display: "grid",
                      gap: "10px",
                    }}
                  >
                    {relationships.map((relationship) => (
                      <div
                        key={relationship.id}
                        style={{
                          padding: "10px 14px",
                          border: "1px solid #d7d1c6",
                          borderRadius: "14px",
                          display: "flex",
                          justifyContent: "space-between",
                          gap: "16px",
                          alignItems: "center",
                          flexWrap: "wrap",
                        }}
                      >
                        <div>
                          <strong>
                            {relationship.venue?.name ??
                              "Verified Spot"}
                          </strong>

                          {(relationship.venue?.city ||
                            relationship.venue?.state_region) && (
                            <div
                              style={{
                                marginTop: "3px",
                                fontSize: "0.85rem",
                                color: "#697177",
                              }}
                            >
                              {[
                                relationship.venue?.city,
                                relationship.venue?.state_region,
                              ]
                                .filter(Boolean)
                                .join(", ")}
                            </div>
                          )}
                        </div>

                        <div
                          style={{
                            display: "flex",
                            gap: "8px",
                            alignItems: "center",
                            flexWrap: "wrap",
                          }}
                        >
                          <span
                            style={{
                              padding: "5px 9px",
                              borderRadius: "999px",
                              background: "#f2efe6",
                              fontSize: "0.78rem",
                              fontWeight: 700,
                            }}
                          >
                            {formatRelationship(
                              relationship.relationship_type
                            )}
                          </span>

                          {relationship.is_primary && (
                            <span
                              style={{
                                padding: "5px 9px",
                                borderRadius: "999px",
                                background: "#0c2333",
                                color: "#fff",
                                fontSize: "0.78rem",
                                fontWeight: 800,
                              }}
                            >
                              Primary
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {requests.length > 0 && (
                <section style={{ marginTop: "18px" }}>
                  <h2 style={{ marginBottom: "14px" }}>
                    Awaiting verification
                  </h2>

                  <div style={{ display: "grid", gap: "10px" }}>
                    {requests.map((request) => (
                      <div
                        key={request.id}
                        style={{
                          padding: "14px 16px",
                          border: "1px solid #d7d1c6",
                          borderRadius: "14px",
                        }}
                      >
                        <strong>
                          {request.venue?.name ?? "Requested Spot"}
                        </strong>

                        <div
                          style={{
                            marginTop: "4px",
                            color: "#697177",
                            fontSize: "0.85rem",
                          }}
                        >
                          {formatRelationship(
                            request.relationship_type
                          )}{" "}
                          · Verification pending
                          {request.make_primary
                            ? " · Requested as primary"
                            : ""}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section
                style={{
                  marginTop: "18px",
                  paddingTop: "18px",
                  borderTop: "1px solid #ddd",
                }}
              >
                <h2>Add another Spot.</h2>

                <p style={{ color: "#697177" }}>
                  The Spot will verify your affiliation before it appears
                  publicly on your profile.
                </p>

                <form onSubmit={handleSubmit}>
                  <label
                    style={{
                      display: "block",
                      fontWeight: 800,
                      margin: "12px 0 6px",
                    }}
                  >
                    Search Spots
                  </label>

                  <input
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setSelectedVenueId("");
                    }}
                    placeholder="Search Spot name or city..."
                    style={{
                      width: "100%",
                      padding: "14px",
                      border: "1px solid #d7d1c6",
                      borderRadius: "12px",
                      font: "inherit",
                      boxSizing: "border-box",
                    }}
                  />

                  {searchResults.length > 0 && (
                    <div
                      style={{
                        marginTop: "8px",
                        border: "1px solid #d7d1c6",
                        borderRadius: "12px",
                        overflow: "hidden",
                      }}
                    >
                      {searchResults.map((venue) => (
                        <button
                          key={venue.id}
                          type="button"
                          onClick={() => {
                            setSelectedVenueId(venue.id);
                            setQuery(venue.name);
                          }}
                          style={{
                            width: "100%",
                            padding: "12px 14px",
                            border: 0,
                            borderBottom:
                              "1px solid #eee9df",
                            background: "#fff",
                            textAlign: "left",
                            cursor: "pointer",
                          }}
                        >
                          <strong>{venue.name}</strong>

                          {(venue.city || venue.state_region) && (
                            <div
                              style={{
                                marginTop: "2px",
                                color: "#697177",
                                fontSize: "0.8rem",
                              }}
                            >
                              {[venue.city, venue.state_region]
                                .filter(Boolean)
                                .join(", ")}
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}

                  {query.trim() &&
                    searchResults.length === 0 &&
                    !selectedVenueId && (
                      <div
                        className="new-entity"
                        style={{ marginTop: "10px" }}
                      >
                        <strong>
                          We don&apos;t have this Spot yet.
                        </strong>

                        <span>
                          Search Google for the exact business.
                          Selecting it will add the Spot to
                          TenderFans and let you request
                          verification.
                        </span>

                        <GooglePlacePicker
                          onSelect={async (place: any) => {
                            setMessage("");

                            const { data, error } =
                              await supabase.rpc(
                                "upsert_google_venue",
                                {
                                  p_place_id: place.id,
                                  p_name: place.name,
                                  p_street_address:
                                    place.streetAddress,
                                  p_city: place.city,
                                  p_state_region: place.state,
                                  p_postal_code:
                                    place.postalCode,
                                  p_latitude:
                                    place.latitude,
                                  p_longitude:
                                    place.longitude,
                                  p_public_phone:
                                    place.publicPhone,
                                  p_website_url:
                                    place.websiteUrl,
                                  p_regular_hours:
                                    place.regularHours,
                                }
                              );

                            if (error) {
                              setMessage(error.message);
                              return;
                            }

                            const { data: newVenue, error: venueError } =
                              await supabase
                                .from("venues")
                                .select(
                                  "id, name, city, state_region"
                                )
                                .eq("id", data)
                                .single();

                            if (venueError || !newVenue) {
                              setMessage(
                                venueError?.message ||
                                  "Spot was added, but could not be selected."
                              );
                              return;
                            }

                            setVenues((current) => [
                              ...current.filter(
                                (venue) =>
                                  venue.id !== newVenue.id
                              ),
                              newVenue as Venue,
                            ]);

                            setSelectedVenueId(newVenue.id);
                            setQuery(newVenue.name);

                            setMessage(
                              `${newVenue.name} added. Complete the details below and request verification.`
                            );
                          }}
                        />
                      </div>
                    )}

                  {selectedVenue && (
                    <div
                      style={{
                        marginTop: "12px",
                        padding: "12px 14px",
                        borderRadius: "12px",
                        background: "#f2efe6",
                      }}
                    >
                      <strong>Selected:</strong>{" "}
                      {selectedVenue.name}
                    </div>
                  )}

                  <label
                    style={{
                      display: "block",
                      fontWeight: 800,
                      margin: "14px 0 6px",
                    }}
                  >
                    Relationship
                  </label>

                  <select
                    value={relationshipType}
                    onChange={(e) =>
                      setRelationshipType(e.target.value)
                    }
                    style={{
                      width: "100%",
                      padding: "14px",
                      border: "1px solid #d7d1c6",
                      borderRadius: "12px",
                      background: "#fff",
                      font: "inherit",
                    }}
                  >
                    <option value="regular">Regular</option>
                    <option value="seasonal">Seasonal</option>
                    <option value="event">Event</option>
                    <option value="guest">Guest</option>
                    <option value="other">Other</option>
                  </select>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(2, minmax(0, 1fr))",
                      gap: "12px",
                      marginTop: "14px",
                    }}
                  >
                    <div>
                      <label
                        style={{
                          display: "block",
                          fontWeight: 800,
                          marginBottom: "7px",
                        }}
                      >
                        Start date
                      </label>

                      <input
                        type="date"
                        value={startDate}
                        onChange={(e) =>
                          setStartDate(e.target.value)
                        }
                        style={{
                          width: "100%",
                          padding: "14px",
                          border: "1px solid #d7d1c6",
                          borderRadius: "12px",
                          font: "inherit",
                          boxSizing: "border-box",
                        }}
                      />
                    </div>

                    <div>
                      <label
                        style={{
                          display: "block",
                          fontWeight: 800,
                          marginBottom: "7px",
                        }}
                      >
                        End date
                      </label>

                      <input
                        type="date"
                        value={endDate}
                        onChange={(e) =>
                          setEndDate(e.target.value)
                        }
                        style={{
                          width: "100%",
                          padding: "14px",
                          border: "1px solid #d7d1c6",
                          borderRadius: "12px",
                          font: "inherit",
                          boxSizing: "border-box",
                        }}
                      />
                    </div>
                  </div>

                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "9px",
                      marginTop: "12px",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={makePrimary}
                      onChange={(e) =>
                        setMakePrimary(e.target.checked)
                      }
                    />

                    <span>
                      Make this my primary Spot when approved
                    </span>
                  </label>

                  {message && (
                    <p
                      style={{
                        marginTop: "16px",
                        fontWeight: 700,
                      }}
                    >
                      {message}
                    </p>
                  )}

                  <div
                    style={{
                      display: "flex",
                      gap: "10px",
                      marginTop: "16px",
                      flexWrap: "wrap",
                    }}
                  >
                    <button
                      className="btn primary"
                      type="submit"
                      disabled={
                        submitting || !selectedVenueId
                      }
                    >
                      {submitting
                        ? "Submitting..."
                        : "Request Verification"}
                    </button>

                    <Link
                      href="/account/tender"
                      className="btn outline"
                    >
                      Back to Account
                    </Link>
                  </div>
                </form>
              </section>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
