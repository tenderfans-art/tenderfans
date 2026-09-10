"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Claim = {
  id: string;
  entity_kind: "bartender" | "venue";
  status: string;
  created_at: string;
  bartender_id: string | null;
  venue_id: string | null;
  claimant_user_id: string;
  claimant_name: string | null;
  claimant_username: string | null;
  claimant_email: string | null;
  claimed_name: string | null;
  verifying_spot_name: string | null;
  claimed_hire_date: string | null;
  claimant_role: string | null;
  business_email: string | null;
  role_start_date: string | null;
  requested_tender_type: string | null;
};

type SpotRequest = {
  id: string;
  bartender_id: string;
  bartender_name: string;
  venue_id: string;
  venue_name: string;
  request_type: string;
  relationship_type: string;
  requested_start_date: string | null;
  requested_end_date: string | null;
  make_primary: boolean;
  requested_by_user_id: string;
  created_at: string;
};

type EventRequest = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  flyer_url: string | null;
  venue_id: string;
  venue_name: string;
  submitted_by: string;
  partner_name: string | null;
  partner_company: string | null;
  venue_approval_status: "pending" | "approved" | "denied";
  admin_approval_status: "pending" | "approved" | "denied";
  created_at: string;
};

type PartnerRequest = {
  id: string;
  user_id: string;
  partner_type: "promoter" | "liquor_rep";
  display_name: string;
  company_name: string | null;
  verification_method: "public_record" | "supervisor";
  verification_source: string | null;
  verification_jurisdiction: string | null;
  verification_name: string | null;
  verification_reference: string | null;
  verification_url: string | null;
  supervisor_name: string | null;
  supervisor_title: string | null;
  supervisor_email: string | null;
  supervisor_phone: string | null;
  created_at: string;
};

export default function AdminClaimsPage() {
  const [claims, setClaims] = useState<Claim[]>([]);
  const [spotRequests, setSpotRequests] = useState<SpotRequest[]>([]);
  const [partnerRequests, setPartnerRequests] = useState<PartnerRequest[]>([]);
  const [eventRequests, setEventRequests] = useState<EventRequest[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  async function loadClaims() {
    setLoading(true);
    setMessage("");

    const [
      claimResult,
      spotRequestResult,
      partnerRequestResult,
      eventRequestResult,
    ] = await Promise.all([
      supabase.rpc("admin_pending_claim_details"),
      supabase.rpc("admin_pending_bartender_venue_requests"),
      supabase.rpc("admin_pending_partner_profiles"),
      supabase.rpc("admin_pending_events"),
    ]);

    if (claimResult.error) {
      setMessage(claimResult.error.message);
      setClaims([]);
    } else {
      setClaims((claimResult.data as Claim[]) || []);
    }

    if (spotRequestResult.error) {
      setMessage(spotRequestResult.error.message);
      setSpotRequests([]);
    } else {
      setSpotRequests(
        (spotRequestResult.data as SpotRequest[]) || []
      );
    }

    if (partnerRequestResult.error) {
      setMessage(partnerRequestResult.error.message);
      setPartnerRequests([]);
    } else {
      setPartnerRequests(
        (partnerRequestResult.data as PartnerRequest[]) || []
      );
    }

    if (eventRequestResult.error) {
      setMessage(eventRequestResult.error.message);
      setEventRequests([]);
    } else {
      setEventRequests(
        (eventRequestResult.data as EventRequest[]) || []
      );
    }

    setLoading(false);
  }

  async function reviewClaim(id: string, approve: boolean) {
    setMessage("");

    const { error } = await supabase.rpc("admin_review_claim", {
      p_claim_id: id,
      p_approve: approve,
    });

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage(approve ? "Claim approved." : "Claim rejected.");
    await loadClaims();
  }

  async function reviewSpotRequest(
    id: string,
    approve: boolean
  ) {
    setMessage("");

    const { error } = await supabase.rpc(
      "review_bartender_venue_request",
      {
        p_request_id: id,
        p_approve: approve,
      }
    );

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage(
      approve
        ? "Spot affiliation approved."
        : "Spot affiliation rejected."
    );

    await loadClaims();
  }

  async function reviewPartner(
    id: string,
    approve: boolean
  ) {
    setMessage("");

    const { error } = await supabase.rpc(
      "admin_review_partner_profile",
      {
        p_partner_id: id,
        p_approve: approve,
      }
    );

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage(
      approve
        ? "Partner profile approved."
        : "Partner profile rejected."
    );

    await loadClaims();
  }

  async function reviewEvent(
    id: string,
    approve: boolean
  ) {
    setMessage("");

    const { error } = await supabase.rpc(
      "admin_review_event",
      {
        p_event_id: id,
        p_approve: approve,
      }
    );

    if (error) {
      setMessage(error.message);
      return;
    }

    setMessage(
      approve
        ? "Event approved and published."
        : "Event rejected."
    );

    await loadClaims();
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

  useEffect(() => {
    loadClaims();
  }, []);

  return (
    <section className="flow-page">
      <div className="shell">
        <div className="flow-card">
          <div className="eyebrow">TENDERFANS ADMIN</div>
          <h1>Verification Requests</h1>

          {message && <div className="privacy-note">{message}</div>}

          {loading ? (
            <p>Loading claims...</p>
          ) : claims.length === 0 &&
            spotRequests.length === 0 &&
            partnerRequests.length === 0 &&
            eventRequests.length === 0 ? (
            <p>No pending verification requests.</p>
          ) : (
            <div style={{ display: "grid", gap: "16px", marginTop: "24px" }}>
              {claims.map((claim) => {
                const name = claim.claimed_name;

                return (
                  <div
                    key={claim.id}
                    style={{
                      border: "1px solid #d7d2c7",
                      borderRadius: "12px",
                      padding: "18px",
                    }}
                  >
                    <div className="eyebrow">
                      {claim.entity_kind === "bartender"
                        ? "TENDER CLAIM"
                        : "SPOT CLAIM"}
                    </div>

                    <h2>{name || "Unknown profile"}</h2>

                    <div
                      style={{
                        display: "grid",
                        gap: "6px",
                        marginTop: "14px",
                      }}
                    >
                      <div>
                        <strong>Claimant:</strong>{" "}
                        {claim.claimant_name || "Name not provided"}
                      </div>

                      <div>
                        <strong>Email:</strong>{" "}
                        {claim.claimant_email || "Unavailable"}
                      </div>

                      <div>
                        <strong>Account:</strong>{" "}
                        {claim.claimant_username || "Unknown user"}
                      </div>

                      {claim.entity_kind === "venue" && (
                        <>
                          <div>
                            <strong>Role:</strong>{" "}
                            {claim.claimant_role
                              ? claim.claimant_role
                                  .replaceAll("_", " ")
                                  .replace(/\w/g, (c) => c.toUpperCase())
                              : "Not provided"}
                          </div>

                          <div>
                            <strong>Business Email:</strong>{" "}
                            {claim.business_email || "Not provided"}
                          </div>

                          <div>
                            <strong>In Role Since:</strong>{" "}
                            {claim.role_start_date
                              ? new Date(
                                  `${claim.role_start_date}T00:00:00`
                                ).toLocaleDateString()
                              : "Not provided"}
                          </div>
                        </>
                      )}

                      {claim.entity_kind === "bartender" && (
                        <>
                          <div>
                            <strong>Tender Type:</strong>{" "}
                            {claim.requested_tender_type
                              ? claim.requested_tender_type
                                  .replaceAll("_", " ")
                                  .replace(/\b\w/g, (c) => c.toUpperCase())
                              : "Bartender"}
                          </div>

                          <div>
                            <strong>Verification Spot:</strong>{" "}
                            {claim.verifying_spot_name ||
                              "No current Spot available"}
                          </div>

                          <div>
                            <strong>Hire Date:</strong>{" "}
                            {claim.claimed_hire_date
                              ? new Date(
                                  `${claim.claimed_hire_date}T00:00:00`
                                ).toLocaleDateString()
                              : "Not provided"}
                          </div>
                        </>
                      )}

                      <div>
                        <strong>Submitted:</strong>{" "}
                        {new Date(claim.created_at).toLocaleString()}
                      </div>

                      <div
                        style={{
                          fontSize: "0.82rem",
                          opacity: 0.55,
                          marginTop: "4px",
                        }}
                      >
                        User ID: {claim.claimant_user_id}
                      </div>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        gap: "10px",
                        marginTop: "14px",
                      }}
                    >
                      <button
                        type="button"
                        className="landing-action"
                        onClick={() => reviewClaim(claim.id, true)}
                      >
                        Approve
                      </button>

                      <button
                        type="button"
                        onClick={() => reviewClaim(claim.id, false)}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                );
              })}

              {partnerRequests.map((partner) => (
                <div
                  key={partner.id}
                  style={{
                    border: "1px solid #d7d2c7",
                    borderRadius: "12px",
                    padding: "18px",
                  }}
                >
                  <div className="eyebrow">
                    {partner.partner_type === "promoter"
                      ? "PROMOTER PARTNER"
                      : "LIQUOR / BRAND REP"}
                  </div>

                  <h2>{partner.display_name}</h2>

                  <div
                    style={{
                      display: "grid",
                      gap: "6px",
                      marginTop: "14px",
                    }}
                  >
                    <div>
                      <strong>Company / Brand:</strong>{" "}
                      {partner.company_name || "Not provided"}
                    </div>

                    <div>
                      <strong>Verification:</strong>{" "}
                      {partner.verification_method === "public_record"
                        ? "Public Record"
                        : "Supervisor Contact"}
                    </div>

                    {partner.verification_method === "public_record" && (
                      <>
                        <div>
                          <strong>Source:</strong>{" "}
                          {partner.verification_source || "Not provided"}
                        </div>

                        <div>
                          <strong>Jurisdiction:</strong>{" "}
                          {partner.verification_jurisdiction || "Not provided"}
                        </div>

                        <div>
                          <strong>Public Record Name:</strong>{" "}
                          {partner.verification_name || "Not provided"}
                        </div>

                        <div>
                          <strong>Record / Document #:</strong>{" "}
                          {partner.verification_reference || "Not provided"}
                        </div>

                        {partner.verification_url && (
                          <div>
                            <strong>Public Record Link:</strong>{" "}
                            <a
                              href={partner.verification_url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open record
                            </a>
                          </div>
                        )}
                      </>
                    )}

                    {partner.verification_method === "supervisor" && (
                      <>
                        <div>
                          <strong>Supervisor:</strong>{" "}
                          {partner.supervisor_name || "Not provided"}
                        </div>

                        <div>
                          <strong>Supervisor Title:</strong>{" "}
                          {partner.supervisor_title || "Not provided"}
                        </div>

                        <div>
                          <strong>Supervisor Email:</strong>{" "}
                          {partner.supervisor_email || "Not provided"}
                        </div>

                        <div>
                          <strong>Supervisor Phone:</strong>{" "}
                          {partner.supervisor_phone || "Not provided"}
                        </div>
                      </>
                    )}

                    <div>
                      <strong>Submitted:</strong>{" "}
                      {new Date(partner.created_at).toLocaleString()}
                    </div>

                    <div
                      style={{
                        fontSize: "0.82rem",
                        opacity: 0.55,
                        marginTop: "4px",
                      }}
                    >
                      User ID: {partner.user_id}
                    </div>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: "10px",
                      marginTop: "14px",
                    }}
                  >
                    <button
                      type="button"
                      className="landing-action"
                      onClick={() => reviewPartner(partner.id, true)}
                    >
                      Approve
                    </button>

                    <button
                      type="button"
                      onClick={() => reviewPartner(partner.id, false)}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}

              {eventRequests.map((event) => {
                const start = new Date(event.starts_at);
                const end = event.ends_at
                  ? new Date(event.ends_at)
                  : null;

                return (
                  <div
                    key={event.id}
                    style={{
                      border: "1px solid #d7d2c7",
                      borderRadius: "12px",
                      padding: "18px",
                    }}
                  >
                    <div className="eyebrow">
                      EVENT VERIFICATION
                    </div>

                    <h2>{event.title}</h2>

                    <div
                      style={{
                        display: "grid",
                        gap: "6px",
                        marginTop: "14px",
                      }}
                    >
                      <div>
                        <strong>Hosting Spot:</strong>{" "}
                        {event.venue_name}
                      </div>

                      <div>
                        <strong>Submitted By:</strong>{" "}
                        {event.partner_name || "Partner"}
                        {event.partner_company
                          ? ` · ${event.partner_company}`
                          : ""}
                      </div>

                      <div>
                        <strong>When:</strong>{" "}
                        {start.toLocaleDateString()}{" "}
                        {start.toLocaleTimeString([], {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                        {end
                          ? ` – ${end.toLocaleTimeString([], {
                              hour: "numeric",
                              minute: "2-digit",
                            })}`
                          : ""}
                      </div>

                      <div>
                        <strong>Spot Verification:</strong>{" "}
                        {event.venue_approval_status.toUpperCase()}
                      </div>

                      <div>
                        <strong>TenderFans Verification:</strong>{" "}
                        {event.admin_approval_status.toUpperCase()}
                      </div>

                      {event.flyer_url && (
                        <div>
                          <strong>Flyer:</strong>{" "}
                          <a
                            href={event.flyer_url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View flyer
                          </a>
                        </div>
                      )}

                      <div>
                        <strong>Submitted:</strong>{" "}
                        {new Date(
                          event.created_at
                        ).toLocaleString()}
                      </div>

                      <div
                        style={{
                          fontSize: "0.82rem",
                          opacity: 0.55,
                          marginTop: "4px",
                        }}
                      >
                        User ID: {event.submitted_by}
                      </div>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        gap: "10px",
                        marginTop: "14px",
                        alignItems: "center",
                        flexWrap: "wrap",
                      }}
                    >
                      <button
                        type="button"
                        className="landing-action"
                        onClick={() =>
                          reviewEvent(event.id, true)
                        }
                        title="Confirm Spot verification and publish event"
                      >
                        Verify & Approve
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          reviewEvent(event.id, false)
                        }
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                );
              })}

              {spotRequests.map((request) => (
                <div
                  key={request.id}
                  style={{
                    border: "1px solid #d7d2c7",
                    borderRadius: "12px",
                    padding: "18px",
                  }}
                >
                  <div className="eyebrow">
                    TENDER SPOT REQUEST
                  </div>

                  <h2>{request.bartender_name}</h2>

                  <div
                    style={{
                      display: "grid",
                      gap: "6px",
                      marginTop: "14px",
                    }}
                  >
                    <div>
                      <strong>Requested Spot:</strong>{" "}
                      {request.venue_name}
                    </div>

                    <div>
                      <strong>Relationship:</strong>{" "}
                      {formatRelationship(
                        request.relationship_type
                      )}
                    </div>

                    <div>
                      <strong>Request Type:</strong>{" "}
                      {formatRelationship(
                        request.request_type
                      )}
                    </div>

                    <div>
                      <strong>Primary Spot:</strong>{" "}
                      {request.make_primary ? "Yes" : "No"}
                    </div>

                    <div>
                      <strong>Start Date:</strong>{" "}
                      {request.requested_start_date
                        ? new Date(
                            `${request.requested_start_date}T00:00:00`
                          ).toLocaleDateString()
                        : "Not provided"}
                    </div>

                    <div>
                      <strong>End Date:</strong>{" "}
                      {request.requested_end_date
                        ? new Date(
                            `${request.requested_end_date}T00:00:00`
                          ).toLocaleDateString()
                        : "Open-ended"}
                    </div>

                    <div>
                      <strong>Submitted:</strong>{" "}
                      {new Date(
                        request.created_at
                      ).toLocaleString()}
                    </div>

                    <div
                      style={{
                        fontSize: "0.82rem",
                        opacity: 0.55,
                        marginTop: "4px",
                      }}
                    >
                      User ID: {request.requested_by_user_id}
                    </div>
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: "10px",
                      marginTop: "14px",
                    }}
                  >
                    <button
                      type="button"
                      className="landing-action"
                      onClick={() =>
                        reviewSpotRequest(request.id, true)
                      }
                    >
                      Approve
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        reviewSpotRequest(request.id, false)
                      }
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
