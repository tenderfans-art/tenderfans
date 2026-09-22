"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function TenderEditProfilePage() {
  const params = useParams();
  const bartenderId = params.bartenderId as string;

  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [slug, setSlug] = useState("");

  const [userId, setUserId] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [showEmailUpdate, setShowEmailUpdate] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [updatingEmail, setUpdatingEmail] = useState(false);

  const [preferenceId, setPreferenceId] = useState<string | null>(null);
  const [wantsEmail, setWantsEmail] = useState(true);
  const [wantsSms, setWantsSms] = useState(false);
  const [phone, setPhone] = useState("");
  const [savedPhone, setSavedPhone] = useState("");
  const [phoneVerified, setPhoneVerified] = useState(false);

  const [verificationCode, setVerificationCode] = useState("");
  const [verificationSent, setVerificationSent] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [verifyingCode, setVerifyingCode] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    async function loadProfile() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        window.location.href = "/login";
        return;
      }

      setUserId(user.id);
      setAccountEmail(user.email ?? "");

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
        setMessage("You do not have permission to edit this Tender profile.");
        setLoading(false);
        return;
      }

      const [bartenderResult, preferenceResult] =
        await Promise.all([
          supabase
            .from("bartenders")
            .select("display_name, bio, slug")
            .eq("id", bartenderId)
            .single(),

          supabase
            .from("tender_notification_preferences")
            .select(
              "id, wants_email, wants_sms, phone_e164, phone_verified"
            )
            .eq("bartender_id", bartenderId)
            .eq("user_id", user.id)
            .maybeSingle(),
        ]);

      if (bartenderResult.error) {
        setMessage(bartenderResult.error.message);
        setLoading(false);
        return;
      }

      if (preferenceResult.error) {
        setMessage(preferenceResult.error.message);
        setLoading(false);
        return;
      }

      const bartender = bartenderResult.data;
      const preferences = preferenceResult.data;

      setDisplayName(bartender.display_name ?? "");
      setBio(bartender.bio ?? "");
      setSlug(bartender.slug ?? "");

      if (preferences) {
        setPreferenceId(preferences.id);
        setWantsEmail(preferences.wants_email);
        setWantsSms(preferences.wants_sms);
        setPhone(preferences.phone_e164 ?? "");
        setSavedPhone(preferences.phone_e164 ?? "");
        setPhoneVerified(preferences.phone_verified);
      }

      setAllowed(true);
      setLoading(false);
    }

    loadProfile();
  }, [bartenderId]);

  function normalizePhone(value: string) {
    const digits = value.replace(/\D/g, "");

    if (digits.length === 10) {
      return `+1${digits}`;
    }

    if (digits.length === 11 && digits.startsWith("1")) {
      return `+${digits}`;
    }

    if (value.trim().startsWith("+") && digits.length >= 10) {
      return `+${digits}`;
    }

    return "";
  }

  async function savePreferences() {
    const normalizedPhone = phone.trim()
      ? normalizePhone(phone)
      : "";

    if (wantsSms && !normalizedPhone) {
      throw new Error(
        "Enter a valid mobile number before enabling SMS notifications."
      );
    }

    const phoneChanged =
      normalizedPhone !== normalizePhone(savedPhone);

    const payload = {
      bartender_id: bartenderId,
      user_id: userId,
      wants_email: wantsEmail,
      wants_sms: wantsSms,
      phone_e164: normalizedPhone || null,
      phone_verified:
        wantsSms && !phoneChanged
          ? phoneVerified
          : false,
      sms_consent_at: wantsSms
        ? new Date().toISOString()
        : null,
      sms_consent_source: wantsSms
        ? "tender_edit_profile"
        : null,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("tender_notification_preferences")
      .upsert(payload, {
        onConflict: "bartender_id,user_id",
      })
      .select("id, phone_verified")
      .single();

    if (error) {
      throw error;
    }

    setPreferenceId(data.id);
    setPhone(normalizedPhone);
    setSavedPhone(normalizedPhone);
    setPhoneVerified(data.phone_verified);
    return data.id as string;
  }

  async function updateAccountEmail() {
    const cleanEmail = newEmail.trim().toLowerCase();

    if (!cleanEmail || !cleanEmail.includes("@")) {
      setMessage("Enter a valid email address.");
      return;
    }

    if (cleanEmail === accountEmail.toLowerCase()) {
      setMessage("That is already your account email.");
      return;
    }

    setUpdatingEmail(true);
    setMessage("");

    const { error } = await supabase.auth.updateUser({
      email: cleanEmail,
    });

    if (error) {
      setMessage(error.message);
      setUpdatingEmail(false);
      return;
    }

    setNewEmail("");
    setShowEmailUpdate(false);
    setMessage(
      "Email update requested. Check your email to confirm the change."
    );
    setUpdatingEmail(false);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!allowed || saving) return;

    const cleanName = displayName.trim();
    const cleanBio = bio.trim();

    if (cleanName.length < 2) {
      setMessage("Enter your display name.");
      return;
    }

    if (!wantsEmail && !wantsSms) {
      setMessage("Choose at least one notification method.");
      return;
    }

    setSaving(true);
    setMessage("");

    try {
      await savePreferences();

      const { error } = await supabase
        .from("bartenders")
        .update({
          display_name: cleanName,
          bio: cleanBio || null,
        })
        .eq("id", bartenderId);

      if (error) {
        throw error;
      }

      setDisplayName(cleanName);
      setBio(cleanBio);
      setMessage("Profile saved.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not save your profile."
      );
    } finally {
      setSaving(false);
    }
  }

  async function sendVerificationCode() {
    if (sendingCode) return;

    const normalizedPhone = normalizePhone(phone);

    if (!normalizedPhone) {
      setMessage("Enter a valid mobile number.");
      return;
    }

    setSendingCode(true);
    setMessage("");

    try {
      const { data, error } = await supabase
        .from("tender_notification_preferences")
        .upsert(
          {
            bartender_id: bartenderId,
            user_id: userId,
            wants_email: wantsEmail,
            wants_sms: true,
            phone_e164: normalizedPhone,
            phone_verified: false,
            sms_consent_at: new Date().toISOString(),
            sms_consent_source: "tender_edit_profile",
            updated_at: new Date().toISOString(),
          },
          {
            onConflict: "bartender_id,user_id",
          }
        )
        .select("id")
        .single();

      if (error) {
        throw error;
      }

      setPreferenceId(data.id);
      setWantsSms(true);
      setPhone(normalizedPhone);
      setSavedPhone(normalizedPhone);
      setPhoneVerified(false);

      const response = await fetch(
        "/api/notifications/verification/send",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "tender",
            id: data.id,
          }),
        }
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(
          result.error || "Could not send verification code."
        );
      }

      setVerificationSent(true);
      setMessage("Verification code sent.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not send verification code."
      );
    } finally {
      setSendingCode(false);
    }
  }

  async function verifyPhone() {
    if (!preferenceId || verifyingCode) return;

    if (!/^\d{6}$/.test(verificationCode.trim())) {
      setMessage("Enter the 6-digit verification code.");
      return;
    }

    setVerifyingCode(true);
    setMessage("");

    try {
      const response = await fetch(
        "/api/notifications/verification/check",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "tender",
            id: preferenceId,
            code: verificationCode.trim(),
          }),
        }
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(
          result.error || "Could not verify that phone number."
        );
      }

      setPhoneVerified(true);
      setVerificationSent(false);
      setVerificationCode("");
      setMessage("Mobile number verified.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not verify that phone number."
      );
    } finally {
      setVerifyingCode(false);
    }
  }

  return (
    <main className="flow-page">
      <div
        className="shell narrow"
        style={{ maxWidth: "680px" }}
      >
        <div
          className="flow-card"
          style={{ padding: "18px 24px 24px" }}
        >
          <h1 style={{ marginTop: 0 }}>Edit your profile.</h1>

          {loading && <p>Loading your profile...</p>}

          {!loading && message && !allowed && (
            <p style={{ color: "crimson" }}>{message}</p>
          )}

          {!loading && allowed && (
            <form onSubmit={handleSubmit}>
              <section style={{ marginTop: "14px" }}>
                <h2
                  style={{
                    margin: "0 0 6px",
                    fontSize: "1.15rem",
                  }}
                >
                  Notification preferences
                </h2>

                <p
                  style={{
                    margin: "0 0 12px",
                    color: "#697177",
                    fontSize: "0.9rem",
                    lineHeight: 1.5,
                  }}
                >
                  This information is private and is only visible to
                  you in Edit Profile. It is not displayed anywhere
                  on your public Tender profile.
                </p>

                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "9px",
                    fontWeight: 800,
                    marginBottom: "8px",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={wantsEmail}
                    onChange={(e) =>
                      setWantsEmail(e.target.checked)
                    }
                  />
                  Email
                </label>

                <div
                  style={{
                    display: "flex",
                    gap: "10px",
                    alignItems: "stretch",
                  }}
                >
                  <input
                    type="email"
                    value={accountEmail}
                    readOnly
                    aria-label="Account email"
                    style={{
                      flex: "1 1 auto",
                      minWidth: 0,
                      padding: "10px 12px",
                      border: "1px solid #d7d1c6",
                      borderRadius: "12px",
                      font: "inherit",
                      boxSizing: "border-box",
                      background: "#f5f3ee",
                      color: "#697177",
                    }}
                  />

                  <button
                    type="button"
                    className="btn outline"
                    onClick={() => {
                      setShowEmailUpdate((current) => !current);
                      setNewEmail("");
                    }}
                    style={{
                      flex: "0 0 150px",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {showEmailUpdate ? "Cancel" : "Update Email"}
                  </button>
                </div>

                {showEmailUpdate && (
                  <div
                    style={{
                      display: "flex",
                      gap: "10px",
                      marginTop: "8px",
                    }}
                  >
                    <input
                      type="email"
                      value={newEmail}
                      onChange={(e) => setNewEmail(e.target.value)}
                      placeholder="New email address"
                      autoComplete="email"
                      style={{
                        flex: "1 1 auto",
                        minWidth: 0,
                        padding: "10px 12px",
                        border: "1px solid #d7d1c6",
                        borderRadius: "12px",
                        font: "inherit",
                        boxSizing: "border-box",
                      }}
                    />

                    <button
                      type="button"
                      className="btn primary"
                      onClick={updateAccountEmail}
                      disabled={updatingEmail}
                      style={{
                        flex: "0 0 150px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {updatingEmail ? "Updating..." : "Save Email"}
                    </button>
                  </div>
                )}

                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "9px",
                    fontWeight: 800,
                    marginTop: "12px",
                    marginBottom: "6px",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={wantsSms}
                    onChange={(e) => {
                      setWantsSms(e.target.checked);

                      if (!e.target.checked) {
                        setVerificationSent(false);
                        setVerificationCode("");
                      }
                    }}
                  />
                  SMS
                </label>

                <div
                  style={{
                    display: "flex",
                    gap: "10px",
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => {
                      setPhone(e.target.value);
                      setPhoneVerified(false);
                      setVerificationSent(false);
                    }}
                    placeholder="Mobile number"
                    style={{
                      flex: "1 1 240px",
                      padding: "10px 12px",
                      border: "1px solid #d7d1c6",
                      borderRadius: "12px",
                      font: "inherit",
                      boxSizing: "border-box",
                    }}
                  />

                  <button
                    type="button"
                    className="btn outline"
                    onClick={() => {
                      if (phoneVerified) {
                        setPhone("");
                        setPhoneVerified(false);
                        setVerificationSent(false);
                        setVerificationCode("");
                        setMessage("");
                        return;
                      }

                      sendVerificationCode();
                    }}
                    disabled={
                      sendingCode ||
                      (!phoneVerified && !phone.trim())
                    }
                    style={{
                      flex: "0 0 150px",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {sendingCode
                      ? "Sending..."
                      : phoneVerified
                        ? "Update Number"
                        : "Verify Number"}
                  </button>
                </div>

                {verificationSent && !phoneVerified && (
                  <div
                    style={{
                      display: "flex",
                      gap: "10px",
                      alignItems: "center",
                      flexWrap: "wrap",
                      marginTop: "8px",
                    }}
                  >
                    <input
                      inputMode="numeric"
                      value={verificationCode}
                      onChange={(e) =>
                        setVerificationCode(
                          e.target.value
                            .replace(/\D/g, "")
                            .slice(0, 6)
                        )
                      }
                      placeholder="6-digit code"
                      maxLength={6}
                      style={{
                        width: "180px",
                        padding: "10px 12px",
                        border: "1px solid #d7d1c6",
                        borderRadius: "12px",
                        font: "inherit",
                        boxSizing: "border-box",
                      }}
                    />

                    <button
                      type="button"
                      className="btn outline"
                      onClick={verifyPhone}
                      disabled={
                        verifyingCode ||
                        verificationCode.length !== 6
                      }
                    >
                      {verifyingCode
                        ? "Verifying..."
                        : "Confirm Code"}
                    </button>
                  </div>
                )}
              </section>

              <hr
                style={{
                  border: 0,
                  borderTop: "1px solid #e2ddd3",
                  margin: "20px 0 18px",
                }}
              />

              <section>
                <h2
                  style={{
                    margin: "0 0 6px",
                    fontSize: "1.15rem",
                    fontWeight: 800,
                  }}
                >
                  Update your public Tender profile
                </h2>

                <p
                  style={{
                    margin: "0 0 14px",
                    color: "#697177",
                  }}
                >
                  The information below is displayed on your public
                  Tender profile.
                </p>

                <label
                  style={{
                    display: "block",
                    fontWeight: 800,
                    marginBottom: "7px",
                  }}
                >
                  Display name
                </label>

                <input
                  value={displayName}
                  onChange={(e) =>
                    setDisplayName(e.target.value)
                  }
                  maxLength={80}
                  style={{
                    width: "100%",
                    padding: "11px 12px",
                    border: "1px solid #d7d1c6",
                    borderRadius: "12px",
                    font: "inherit",
                    boxSizing: "border-box",
                  }}
                />

                <label
                  style={{
                    display: "block",
                    fontWeight: 800,
                    marginTop: "15px",
                    marginBottom: "6px",
                  }}
                >
                  Bio
                </label>

                <textarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  maxLength={300}
                  rows={4}
                  placeholder="Tell your guests a little about yourself..."
                  style={{
                    width: "100%",
                    padding: "14px",
                    border: "1px solid #d7d1c6",
                    borderRadius: "12px",
                    font: "inherit",
                    lineHeight: 1.5,
                    resize: "vertical",
                    boxSizing: "border-box",
                  }}
                />

                <div
                  style={{
                    marginTop: "6px",
                    textAlign: "right",
                    color: "#697177",
                    fontSize: "0.8rem",
                  }}
                >
                  {bio.length}/300
                </div>
              </section>

              {message && (
                <p
                  style={{
                    marginTop: "16px",
                    color:
                      message === "Profile saved." ||
                      message === "Verification code sent." ||
                      message === "Mobile number verified." ||
                      message ===
                        "Email update requested. Check your email to confirm the change."
                        ? "#6f8420"
                        : "crimson",
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
                  flexWrap: "wrap",
                  marginTop: "16px",
                }}
              >
                <button
                  type="submit"
                  className="btn primary"
                  disabled={saving}
                >
                  {saving ? "Saving..." : "Save Profile"}
                </button>

                {slug && (
                  <Link
                    href={`/t/${slug}`}
                    className="btn outline"
                  >
                    View Public Profile
                  </Link>
                )}

                <Link
                  href="/account/tender"
                  className="btn outline"
                >
                  Back to Account
                </Link>
              </div>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
