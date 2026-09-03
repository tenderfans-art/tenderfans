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
  bartenders?: { display_name: string }[];
  venues?: { name: string }[];
};

export default function AdminClaimsPage() {
  const [claims, setClaims] = useState<Claim[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  async function loadClaims() {
    setLoading(true);
    setMessage("");

    const { data, error } = await supabase
      .from("entity_claims")
      .select(`
        id,
        entity_kind,
        status,
        created_at,
        bartender_id,
        venue_id,
        claimant_user_id,
        bartenders!entity_claims_bartender_id_fkey(display_name),
        venues!entity_claims_venue_id_fkey(name)
      `)
      .eq("status", "pending")
      .order("created_at", { ascending: true });

    if (error) {
      setMessage(error.message);
      setClaims([]);
    } else {
      setClaims((data as Claim[]) || []);
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
          ) : claims.length === 0 ? (
            <p>No pending claims.</p>
          ) : (
            <div style={{ display: "grid", gap: "16px", marginTop: "24px" }}>
              {claims.map((claim) => {
                const name =
                  claim.entity_kind === "bartender"
                    ? claim.bartenders?.[0]?.display_name
                    : claim.venues?.[0]?.name;

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

                    <p>
                      Submitted{" "}
                      {new Date(claim.created_at).toLocaleString()}
                    </p>

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
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
