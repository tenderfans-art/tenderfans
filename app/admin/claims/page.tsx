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

export default function AdminClaimsPage() {
  const [claims, setClaims] = useState<Claim[]>([]);
  const [spotRequests, setSpotRequests] = useState<SpotRequest[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  async function loadClaims() {
    setLoading(true);
    setMessage("");

    const [
      claimResult,
      spotRequestResult,
    ] = await Promise.all([
      supabase.rpc("admin_pending_claim_details"),
      supabase.rpc("admin_pending_bartender_venue_requests"),
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
          <h1>Pending Claims</h1>

          {message && <div className="privacy-note">{message}</div>}

          {loading ? (
            <p>Loading claims...</p>
          ) : claims.length === 0 && spotRequests.length === 0 ? (
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
