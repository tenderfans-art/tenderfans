"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type ClaimType = "bartender" | "venue";

type TenderOption = {
  id: string;
  name: string;
  venueId: string | null;
  venueName: string;
  city: string;
  state: string;
};

type VenueOption = {
  id: string;
  name: string;
  city: string;
  state: string;
  address: string;
};

export default function ClaimPage() {
  const [type, setType] = useState<ClaimType | null>(null);
  const [query, setQuery] = useState("");
  const [tenders, setTenders] = useState<TenderOption[]>([]);
  const [venues, setVenues] = useState<VenueOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [userId, setUserId] = useState<string | null>(null);
  const [claimantName, setClaimantName] = useState("");
  const [hireDate, setHireDate] = useState("");
  const [claimantRole, setClaimantRole] = useState("");
  const [businessEmail, setBusinessEmail] = useState("");
  const [roleStartDate, setRoleStartDate] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("type");

    if (value === "bartender" || value === "venue") {
      setType(value);
    }

    supabase.auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUserId(session?.user?.id ?? null);
      }
    );

    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    async function loadData() {
      setLoading(true);

      const [bartenderResult, venueResult, relationshipResult] =
        await Promise.all([
          supabase
            .from("bartenders")
            .select("id, display_name")
            .eq("status", "active"),

          supabase
            .from("venues")
            .select("id, name, city, state_region, street_address")
            .eq("status", "active"),

          supabase
            .from("bartender_venues")
            .select("bartender_id, venue_id")
            .eq("is_current", true),
        ]);

      if (bartenderResult.error) {
        setMessage(bartenderResult.error.message);
        setLoading(false);
        return;
      }

      if (venueResult.error) {
        setMessage(venueResult.error.message);
        setLoading(false);
        return;
      }

      if (relationshipResult.error) {
        setMessage(relationshipResult.error.message);
        setLoading(false);
        return;
      }

      const venueMap = new Map(
        (venueResult.data ?? []).map((venue) => [
          venue.id,
          {
            id: venue.id,
            name: venue.name,
            city: venue.city,
            state: venue.state_region,
            address: venue.street_address ?? "",
          },
        ])
      );

      const bartenderVenueMap = new Map<string, string>();

      for (const relationship of relationshipResult.data ?? []) {
        if (!bartenderVenueMap.has(relationship.bartender_id)) {
          bartenderVenueMap.set(
            relationship.bartender_id,
            relationship.venue_id
          );
        }
      }

      setVenues([...venueMap.values()]);

      setTenders(
        (bartenderResult.data ?? []).map((bartender) => {
          const venueId =
            bartenderVenueMap.get(bartender.id) ?? null;

          const venue = venueId
            ? venueMap.get(venueId)
            : undefined;

          return {
            id: bartender.id,
            name: bartender.display_name,
            venueId,
            venueName: venue?.name ?? "Spot not yet verified",
            city: venue?.city ?? "",
            state: venue?.state ?? "",
          };
        })
      );

      const params = new URLSearchParams(window.location.search);
      const shouldResume = params.get("resume") === "1";

      if (shouldResume) {
        try {
          const saved = localStorage.getItem("tf_pending_claim");

          if (saved) {
            const parsed = JSON.parse(saved);

            if (
              parsed?.type === type &&
              typeof parsed?.selectedId === "string"
            ) {
              setSelectedId(parsed.selectedId);

              if (typeof parsed?.claimantName === "string") {
                setClaimantName(parsed.claimantName);
              }

              if (typeof parsed?.hireDate === "string") {
                setHireDate(parsed.hireDate);
              }

              if (typeof parsed?.claimantRole === "string") {
                setClaimantRole(parsed.claimantRole);
              }

              if (typeof parsed?.businessEmail === "string") {
                setBusinessEmail(parsed.businessEmail);
              }

              if (typeof parsed?.roleStartDate === "string") {
                setRoleStartDate(parsed.roleStartDate);
              }
            }
          }
        } catch {}
      } else {
        // A normal Claim visit always starts a fresh form.
        localStorage.removeItem("tf_pending_claim");
        setQuery("");
        setSelectedId(null);
        setClaimantName("");
        setHireDate("");
        setClaimantRole("");
        setBusinessEmail("");
        setRoleStartDate("");
        setEmail("");
        setPassword("");
        setMessage("");
      }

      setLoading(false);
    }

    if (type) loadData();
  }, [type]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();

    if (!q) return [];

    if (type === "bartender") {
      return tenders
        .filter((tender) =>
          `${tender.name} ${tender.venueName} ${tender.city} ${tender.state}`
            .toLowerCase()
            .includes(q)
        )
        .slice(0, 10);
    }

    return venues
      .filter((venue) =>
        `${venue.name} ${venue.city} ${venue.state} ${venue.address}`
          .toLowerCase()
          .includes(q)
      )
      .slice(0, 10);
  }, [query, tenders, venues, type]);

  const selectedTender =
    type === "bartender"
      ? tenders.find((tender) => tender.id === selectedId)
      : undefined;

  const selectedVenue =
    type === "venue"
      ? venues.find((venue) => venue.id === selectedId)
      : undefined;

  async function createClaim(claimantUserId: string) {
    if (!type || !selectedId) return;

    const claim: Record<string, string | null> =
      type === "bartender"
        ? {
            entity_kind: "bartender",
            bartender_id: selectedId,
            venue_id: null,
            claimant_user_id: claimantUserId,
            claimant_name: claimantName.trim(),
            claimed_hire_date: hireDate || null,
            verifying_venue_id: selectedTender?.venueId ?? null,
            status: "pending",
          }
        : {
            entity_kind: "venue",
            bartender_id: null,
            venue_id: selectedId,
            claimant_user_id: claimantUserId,
            claimant_name: claimantName.trim(),
            claimant_role: claimantRole,
            business_email: businessEmail.trim().toLowerCase(),
            role_start_date: roleStartDate || null,
            verifying_venue_id: null,
            status: "pending",
          };

    const { error } = await supabase
      .from("entity_claims")
      .insert(claim);

    if (error) {
      if (
        error.message.toLowerCase().includes("duplicate") ||
        error.code === "23505"
      ) {
        setMessage(
          "You already have an active claim for this profile."
        );
        return;
      }

      setMessage(error.message);
      return;
    }

    localStorage.removeItem("tf_pending_claim");
    setSubmitted(true);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!selectedId || !type) return;

    setSubmitting(true);
    setMessage("");

    if (claimantName.trim().length < 2) {
      setMessage("Enter your first and last name.");
      setSubmitting(false);
      return;
    }

    if (type === "venue") {
      if (!claimantRole) {
        setMessage("Select your role at this Spot.");
        setSubmitting(false);
        return;
      }

      if (!businessEmail.trim()) {
        setMessage("Enter your business email address.");
        setSubmitting(false);
        return;
      }

      if (!roleStartDate) {
        setMessage("Enter when you began this role.");
        setSubmitting(false);
        return;
      }

      const accountEmail = userId
        ? (await supabase.auth.getUser()).data.user?.email ?? ""
        : email.trim();

      if (
        accountEmail &&
        businessEmail.trim().toLowerCase() ===
          accountEmail.trim().toLowerCase()
      ) {
        setMessage(
          "Business email must be different from your TenderFans account email."
        );
        setSubmitting(false);
        return;
      }
    }

    if (userId) {
      await createClaim(userId);
      setSubmitting(false);
      return;
    }

    if (!email.trim() || !password) {
      setMessage("Enter an email address and password.");
      setSubmitting(false);
      return;
    }

    localStorage.setItem(
      "tf_pending_claim",
      JSON.stringify({
        type,
        selectedId,
        claimantName: claimantName.trim(),
        hireDate,
        claimantRole,
        businessEmail: businessEmail.trim(),
        roleStartDate,
      })
    );

    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        emailRedirectTo: `${origin}/auth/confirmed`
      },
    });

    if (error) {
      setMessage(error.message);
      setSubmitting(false);
      return;
    }

    // Supabase may return a user object for an already-registered email
    // without creating a new identity. Route that user to login instead.
    if (
      data.user &&
      Array.isArray(data.user.identities) &&
      data.user.identities.length === 0
    ) {
      setSubmitting(false);
      window.location.href = "/login?claim=1";
      return;
    }

    if (data.session && data.user) {
      await createClaim(data.user.id);
      setSubmitting(false);
      return;
    }

    setMessage(
      "Account created. Check your email to confirm your account. Then return here and sign in to finish your claim."
    );

    setSubmitting(false);
  }

  if (!type) {
    return (
      <section className="flow-page">
        <div className="shell narrow">
          <div className="flow-card">
            <div className="eyebrow">Claim a profile</div>
            <h1>What are you claiming?</h1>

            <div className="claim-grid">
              <a
                className="claim-card"
                href="/claim?type=bartender"
              >
                <strong>I’m a Tender</strong>
                <span>Claim my existing Tender profile.</span>
              </a>

              <a
                className="claim-card"
                href="/claim?type=venue"
              >
                <strong>I represent a Spot</strong>
                <span>Claim an existing Spot.</span>
              </a>
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (submitted) {
    return (
      <section className="flow-page">
        <div className="shell narrow">
          <div className="flow-card">
            <div className="eyebrow">Claim submitted</div>

            <h1>You’re in the verification queue.</h1>

            <p className="lead-copy">
              {type === "venue"
                ? "TenderFans will verify your relationship with this Spot before management access is granted."
                : selectedTender?.venueId
                ? `${selectedTender.venueName} can verify that this Tender profile belongs to you. TenderFans can also manually review the claim during V1.`
                : "TenderFans will manually review this Tender claim because no current verified Spot relationship is available."}
            </p>

            <div className="privacy-note">
              <strong>No personal verification data is stored.</strong>{" "}
              Your claim records only the account, profile, verification
              status and verification relationship.
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="flow-page">
      <div className="shell narrow">
        <div className="flow-card">
          <div className="eyebrow">
            {type === "bartender"
              ? "Claim your Tender profile"
              : "Claim your Spot"}
          </div>

          <h1>
            {type === "bartender"
              ? "Find your existing Tender profile."
              : "Find your existing Spot."}
          </h1>

          <p className="lead-copy">
            {type === "bartender"
              ? "Search by your name or Spot. Select the profile that belongs to you."
              : "Search for the Spot you are authorized to represent."}
          </p>

          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              type === "bartender"
                ? "Search Tender name or Spot..."
                : "Search Spot name, city or address..."
            }
            style={{
              width: "100%",
              padding: "14px 16px",
              borderRadius: "10px",
              border: "1px solid #d7d2c7",
              fontSize: "16px",
              marginBottom: "14px",
            }}
          />

          {loading && <p>Loading...</p>}

          {!loading &&
            query.trim() &&
            results.length === 0 && (
              <div className="privacy-note">
                No matching {type === "bartender" ? "Tender" : "Spot"}{" "}
                found.
              </div>
            )}

          {results.length > 0 && (
            <div
              style={{
                display: "grid",
                gap: "10px",
                marginBottom: "20px",
              }}
            >
              {type === "bartender"
                ? (results as TenderOption[]).map((tender) => (
                    <button
                      key={tender.id}
                      type="button"
                      className="claim-card"
                      onClick={() => setSelectedId(tender.id)}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        cursor: "pointer",
                        outline:
                          selectedId === tender.id
                            ? "2px solid currentColor"
                            : "none",
                      }}
                    >
                      <strong>{tender.name}</strong>
                      <span>
                        {tender.venueName}
                        {tender.city
                          ? ` · ${tender.city}, ${tender.state}`
                          : ""}
                      </span>
                    </button>
                  ))
                : (results as VenueOption[]).map((venue) => (
                    <button
                      key={venue.id}
                      type="button"
                      className="claim-card"
                      onClick={() => setSelectedId(venue.id)}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        cursor: "pointer",
                        outline:
                          selectedId === venue.id
                            ? "2px solid currentColor"
                            : "none",
                      }}
                    >
                      <strong>{venue.name}</strong>
                      <span>
                        {venue.city}, {venue.state}
                        {venue.address
                          ? ` · ${venue.address}`
                          : ""}
                      </span>
                    </button>
                  ))}
            </div>
          )}

          {selectedId && (
            <form onSubmit={handleSubmit}>
              <div className="privacy-note">
                <strong>Selected:</strong>{" "}
                {type === "bartender"
                  ? `${selectedTender?.name} — ${selectedTender?.venueName}`
                  : selectedVenue?.name}
              </div>

              <div
                style={{
                  display: "grid",
                  gap: "6px",
                  marginTop: "18px",
                }}
              >
                <label htmlFor="claimant-name">
                  <strong>Your name</strong>
                </label>

                <input
                  id="claimant-name"
                  type="text"
                  value={claimantName}
                  onChange={(e) => setClaimantName(e.target.value)}
                  placeholder="First and last name"
                  autoComplete="name"
                  minLength={2}
                  maxLength={100}
                  required
                  style={{
                    padding: "14px 16px",
                    borderRadius: "10px",
                    border: "1px solid #d7d2c7",
                    fontSize: "16px",
                  }}
                />

                <span
                  style={{
                    fontSize: "0.82rem",
                    opacity: 0.65,
                  }}
                >
                  Used only to verify your relationship with the profile you are claiming.
                </span>
              </div>

              {type === "bartender" && (
                <div
                  style={{
                    display: "grid",
                    gap: "6px",
                    marginTop: "14px",
                  }}
                >
                  <label htmlFor="hire-date">
                    <strong>Hire date</strong>
                  </label>

                  <input
                    id="hire-date"
                    type="date"
                    value={hireDate}
                    onChange={(e) => setHireDate(e.target.value)}
                    style={{
                      padding: "14px 16px",
                      borderRadius: "10px",
                      border: "1px solid #d7d2c7",
                      fontSize: "16px",
                    }}
                  />

                  <span
                    style={{
                      fontSize: "0.82rem",
                      opacity: 0.65,
                    }}
                  >
                    Used to help the Spot verify your employment history.
                  </span>
                </div>
              )}

              {type === "venue" && (
                <div
                  style={{
                    display: "grid",
                    gap: "12px",
                    marginTop: "18px",
                  }}
                >
                  <p style={{ margin: 0 }}>
                    <strong>Spot verification</strong>
                  </p>

                  <label
                    htmlFor="claimant-role"
                    style={{ display: "grid", gap: "6px" }}
                  >
                    <span>Role at this Spot</span>

                    <select
                      id="claimant-role"
                      value={claimantRole}
                      onChange={(e) => setClaimantRole(e.target.value)}
                      required
                      style={{
                        padding: "14px 16px",
                        borderRadius: "10px",
                        border: "1px solid #d7d2c7",
                        fontSize: "16px",
                        background: "white",
                      }}
                    >
                      <option value="">Select your role</option>
                      <option value="owner">Owner</option>
                      <option value="general_manager">General Manager</option>
                      <option value="bar_manager">Bar Manager</option>
                      <option value="assistant_manager">
                        Assistant Manager
                      </option>
                      <option value="marketing_operations">
                        Marketing / Operations
                      </option>
                      <option value="other">Other</option>
                    </select>
                  </label>

                  <label
                    htmlFor="business-email"
                    style={{ display: "grid", gap: "6px" }}
                  >
                    <span>Business email</span>

                    <input
                      id="business-email"
                      type="email"
                      value={businessEmail}
                      onChange={(e) => setBusinessEmail(e.target.value)}
                      placeholder="info@yourspot.com"
                      autoComplete="off"
                      required
                      style={{
                        padding: "14px 16px",
                        borderRadius: "10px",
                        border: "1px solid #d7d2c7",
                        fontSize: "16px",
                      }}
                    />

                    <span
                      style={{
                        fontSize: "0.82rem",
                        opacity: 0.65,
                      }}
                    >
                      Use an email associated with the business, such as
                      management, info, payroll or accounts payable. This
                      cannot be your TenderFans account email.
                    </span>
                  </label>

                  <label
                    htmlFor="role-start-date"
                    style={{ display: "grid", gap: "6px" }}
                  >
                    <span>When did you begin this role?</span>

                    <input
                      id="role-start-date"
                      type="date"
                      value={roleStartDate}
                      onChange={(e) => setRoleStartDate(e.target.value)}
                      required
                      style={{
                        padding: "14px 16px",
                        borderRadius: "10px",
                        border: "1px solid #d7d2c7",
                        fontSize: "16px",
                      }}
                    />
                  </label>
                </div>
              )}

              {!userId && (
                <div
                  style={{
                    display: "grid",
                    gap: "12px",
                    marginTop: "18px",
                  }}
                >
                  <p style={{ margin: 0 }}>
                    <strong>Create your claimant account</strong>
                  </p>

                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Email"
                    autoComplete="email"
                    required
                    style={{
                      padding: "14px 16px",
                      borderRadius: "10px",
                      border: "1px solid #d7d2c7",
                      fontSize: "16px",
                    }}
                  />

                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Password"
                    autoComplete="new-password"
                    minLength={6}
                    required
                    style={{
                      padding: "14px 16px",
                      borderRadius: "10px",
                      border: "1px solid #d7d2c7",
                      fontSize: "16px",
                    }}
                  />
                </div>
              )}

              <button
                type="submit"
                className="landing-action"
                disabled={submitting}
                style={{
                  marginTop: "18px",
                  width: "100%",
                }}
              >
                {submitting
                  ? "Submitting..."
                  : userId
                  ? "Submit Claim"
                  : "Create Account & Submit Claim"}
              </button>

              {message && (
                <div
                  className="privacy-note"
                  style={{ marginTop: "14px" }}
                >
                  {message}
                </div>
              )}
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
