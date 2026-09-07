"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";

type PartnerType = "promoter" | "liquor_rep";

type ExistingProfile = {
  id: string;
  partner_type: PartnerType;
  display_name: string;
  company_name: string | null;
  status: "pending" | "approved" | "suspended";
};

export default function PartnerApplyPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [existing, setExisting] = useState<ExistingProfile | null>(null);

  const [partnerType, setPartnerType] = useState<PartnerType | "">("");
  const [displayName, setDisplayName] = useState("");
  const [companyName, setCompanyName] = useState("");

  // Promoter verification
  const [verificationSource, setVerificationSource] = useState("");
  const [verificationJurisdiction, setVerificationJurisdiction] = useState("");
  const [verificationName, setVerificationName] = useState("");
  const [verificationReference, setVerificationReference] = useState("");
  const [verificationUrl, setVerificationUrl] = useState("");

  // Rep verification
  const [supervisorName, setSupervisorName] = useState("");
  const [supervisorTitle, setSupervisorTitle] = useState("");
  const [supervisorEmail, setSupervisorEmail] = useState("");
  const [supervisorPhone, setSupervisorPhone] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    async function load() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        window.location.href = "/partners/login";
        return;
      }

      setUserId(user.id);

      const { data, error } = await supabase
        .from("partner_profiles")
        .select("id, partner_type, display_name, company_name, status")
        .eq("user_id", user.id)
        .maybeSingle();

      if (error) {
        setMessage(error.message);
      } else if (data) {
        setExisting(data as ExistingProfile);
      }

      setChecking(false);
    }

    load();
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!userId || !partnerType) return;

    setSubmitting(true);
    setMessage("");

    if (displayName.trim().length < 2) {
      setMessage("Enter your name.");
      setSubmitting(false);
      return;
    }

    if (!companyName.trim()) {
      setMessage(
        partnerType === "promoter"
          ? "Enter your company, organization or promoter name."
          : "Enter the company, distributor or brand you represent."
      );
      setSubmitting(false);
      return;
    }

    if (partnerType === "promoter") {
      if (
        !verificationSource.trim() ||
        !verificationJurisdiction.trim() ||
        !verificationName.trim() ||
        (!verificationReference.trim() && !verificationUrl.trim())
      ) {
        setMessage(
          "Complete the public-record verification information. Include either a record/reference number or a public record URL."
        );
        setSubmitting(false);
        return;
      }
    }

    if (partnerType === "liquor_rep") {
      if (
        !supervisorName.trim() ||
        !supervisorTitle.trim() ||
        !supervisorEmail.trim() ||
        !supervisorPhone.trim()
      ) {
        setMessage("Complete all supervisor verification fields.");
        setSubmitting(false);
        return;
      }
    }

    const payload: {
      user_id: string;
      partner_type: PartnerType;
      display_name: string;
      company_name: string;
      status: "pending";
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
    } = {
      user_id: userId,
      partner_type: partnerType,
      display_name: displayName.trim(),
      company_name: companyName.trim(),
      status: "pending",
      verification_method:
        partnerType === "promoter" ? "public_record" : "supervisor",
      verification_source:
        partnerType === "promoter" ? verificationSource.trim() : null,
      verification_jurisdiction:
        partnerType === "promoter"
          ? verificationJurisdiction.trim()
          : null,
      verification_name:
        partnerType === "promoter" ? verificationName.trim() : null,
      verification_reference:
        partnerType === "promoter"
          ? verificationReference.trim() || null
          : null,
      verification_url:
        partnerType === "promoter"
          ? verificationUrl.trim() || null
          : null,
      supervisor_name:
        partnerType === "liquor_rep" ? supervisorName.trim() : null,
      supervisor_title:
        partnerType === "liquor_rep" ? supervisorTitle.trim() : null,
      supervisor_email:
        partnerType === "liquor_rep"
          ? supervisorEmail.trim().toLowerCase()
          : null,
      supervisor_phone:
        partnerType === "liquor_rep" ? supervisorPhone.trim() : null,
    };

    const { data, error } = await supabase
      .from("partner_profiles")
      .insert(payload)
      .select("id, partner_type, display_name, company_name, status")
      .single();

    if (error) {
      if (
        error.code === "23505" ||
        error.message.toLowerCase().includes("duplicate")
      ) {
        setMessage("A Partner profile already exists for this account.");
      } else {
        setMessage(error.message);
      }

      setSubmitting(false);
      return;
    }

    localStorage.removeItem("tf_partner_signup");
    setExisting(data as ExistingProfile);
    setSubmitting(false);
  }

  if (checking) {
    return (
      <main className="flow-page">
        <div className="shell narrow">
          <div className="flow-card">
            <div className="eyebrow">TenderFans Partners</div>
            <h1>Loading your Partner profile...</h1>
          </div>
        </div>
      </main>
    );
  }

  if (existing) {
    return (
      <main className="flow-page">
        <div className="shell narrow">
          <div className="flow-card">
            <div className="eyebrow">Partner Application</div>

            <h1>
              {existing.status === "approved"
                ? "Your Partner profile is approved."
                : existing.status === "suspended"
                ? "Your Partner profile needs attention."
                : "You’re in the verification queue."}
            </h1>

            <p className="lead-copy">
              <strong>{existing.display_name}</strong>
              {existing.company_name
                ? ` · ${existing.company_name}`
                : ""}
            </p>

            {existing.status === "pending" && (
              <div className="privacy-note">
                TenderFans will verify the information you submitted before
                Partner access is granted.
              </div>
            )}

            {existing.status === "approved" && (
              <div className="privacy-note">
                Your Partner identity has been verified. Partner event tools
                will be available from your Partner dashboard.
              </div>
            )}

            {existing.status === "suspended" && (
              <div className="privacy-note">
                Your Partner access is currently suspended. Contact TenderFans
                if you believe this is an error.
              </div>
            )}

            <div style={{ marginTop: "20px" }}>
              <Link href="/partners">About Partner Profiles</Link>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="flow-page">
      <div className="shell narrow">
        <div className="flow-card">
          <div className="eyebrow">Partner Application</div>
          <h1>Create your Partner profile.</h1>

          <p className="lead-copy">
            Tell us whether you work as an event promoter or as a liquor,
            distributor or brand representative.
          </p>

          <form onSubmit={handleSubmit} className="partner-application-form">
            <div className="partner-type-grid">
              <button
                type="button"
                className={`claim-card ${
                  partnerType === "promoter" ? "partner-type-selected" : ""
                }`}
                onClick={() => {
                  setPartnerType("promoter");
                  setMessage("");
                }}
              >
                <strong>Event Promoter</strong>
                <span>
                  Submit public business information we can independently verify.
                </span>
              </button>

              <button
                type="button"
                className={`claim-card ${
                  partnerType === "liquor_rep" ? "partner-type-selected" : ""
                }`}
                onClick={() => {
                  setPartnerType("liquor_rep");
                  setMessage("");
                }}
              >
                <strong>Liquor / Brand Rep</strong>
                <span>
                  Provide a supervisor contact who can verify your role.
                </span>
              </button>
            </div>

            {partnerType && (
              <>
                <label>
                  <strong>Your name</strong>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="First and last name"
                    autoComplete="name"
                    required
                  />
                </label>

                <label>
                  <strong>
                    {partnerType === "promoter"
                      ? "Company / promoter name"
                      : "Company / distributor / brand"}
                  </strong>

                  <input
                    type="text"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    required
                  />
                </label>
              </>
            )}

            {partnerType === "promoter" && (
              <div className="partner-verification-section">
                <div>
                  <strong>Public-record verification</strong>
                  <p>
                    Provide a publicly searchable business record such as
                    Sunbiz or another state business registry.
                  </p>
                </div>

                <label>
                  <span>Public record source</span>
                  <input
                    type="text"
                    value={verificationSource}
                    onChange={(e) => setVerificationSource(e.target.value)}
                    placeholder="Example: Florida Sunbiz"
                    required
                  />
                </label>

                <label>
                  <span>Jurisdiction</span>
                  <input
                    type="text"
                    value={verificationJurisdiction}
                    onChange={(e) =>
                      setVerificationJurisdiction(e.target.value)
                    }
                    placeholder="Example: Florida"
                    required
                  />
                </label>

                <label>
                  <span>Name shown on public record</span>
                  <input
                    type="text"
                    value={verificationName}
                    onChange={(e) => setVerificationName(e.target.value)}
                    placeholder="Business or organization name"
                    required
                  />
                </label>

                <label>
                  <span>Record / document number</span>
                  <input
                    type="text"
                    value={verificationReference}
                    onChange={(e) =>
                      setVerificationReference(e.target.value)
                    }
                    placeholder="If available"
                  />
                </label>

                <label>
                  <span>Public record URL</span>
                  <input
                    type="url"
                    value={verificationUrl}
                    onChange={(e) => setVerificationUrl(e.target.value)}
                    placeholder="If available"
                  />
                </label>

                <div className="privacy-note">
                  Provide at least a record/document number or a public record URL.
                </div>
              </div>
            )}

            {partnerType === "liquor_rep" && (
              <div className="partner-verification-section">
                <div>
                  <strong>Supervisor verification</strong>
                  <p>
                    This information is used only by TenderFans to verify your
                    professional relationship and is not displayed publicly.
                  </p>
                </div>

                <label>
                  <span>Supervisor name</span>
                  <input
                    type="text"
                    value={supervisorName}
                    onChange={(e) => setSupervisorName(e.target.value)}
                    required
                  />
                </label>

                <label>
                  <span>Supervisor title</span>
                  <input
                    type="text"
                    value={supervisorTitle}
                    onChange={(e) => setSupervisorTitle(e.target.value)}
                    required
                  />
                </label>

                <label>
                  <span>Supervisor business email</span>
                  <input
                    type="email"
                    value={supervisorEmail}
                    onChange={(e) => setSupervisorEmail(e.target.value)}
                    required
                  />
                </label>

                <label>
                  <span>Supervisor phone</span>
                  <input
                    type="tel"
                    value={supervisorPhone}
                    onChange={(e) => setSupervisorPhone(e.target.value)}
                    required
                  />
                </label>
              </div>
            )}

            {partnerType && (
              <button
                type="submit"
                className="landing-action"
                disabled={submitting}
              >
                {submitting
                  ? "Submitting..."
                  : "Submit Partner Application"}
              </button>
            )}

            {message && (
              <div className="privacy-note">{message}</div>
            )}
          </form>
        </div>
      </div>
    </main>
  );
}
