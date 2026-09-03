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

      const { data: bartender, error: bartenderError } =
        await supabase
          .from("bartenders")
          .select("display_name, bio, slug")
          .eq("id", bartenderId)
          .single();

      if (bartenderError) {
        setMessage(bartenderError.message);
        setLoading(false);
        return;
      }

      setDisplayName(bartender.display_name ?? "");
      setBio(bartender.bio ?? "");
      setSlug(bartender.slug ?? "");
      setAllowed(true);
      setLoading(false);
    }

    loadProfile();
  }, [bartenderId]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!allowed || saving) return;

    const cleanName = displayName.trim();
    const cleanBio = bio.trim();

    if (cleanName.length < 2) {
      setMessage("Enter your display name.");
      return;
    }

    setSaving(true);
    setMessage("");

    const { error } = await supabase
      .from("bartenders")
      .update({
        display_name: cleanName,
        bio: cleanBio || null,
      })
      .eq("id", bartenderId);

    if (error) {
      setMessage(error.message);
      setSaving(false);
      return;
    }

    setDisplayName(cleanName);
    setBio(cleanBio);
    setMessage("Profile saved.");
    setSaving(false);
  }

  return (
    <main className="flow-page">
      <div className="shell narrow">
        <div className="flow-card">
          <div className="eyebrow">Tender Account</div>
          <h1>Edit your profile.</h1>

          <p className="lead-copy">
            Update the information shown on your public Tender profile.
          </p>

          {loading && <p>Loading your profile...</p>}

          {!loading && message && !allowed && (
            <p style={{ color: "crimson" }}>{message}</p>
          )}

          {!loading && allowed && (
            <form onSubmit={handleSubmit}>
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
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={80}
                style={{
                  width: "100%",
                  padding: "14px",
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
                  marginTop: "22px",
                  marginBottom: "7px",
                }}
              >
                Bio
              </label>

              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                maxLength={500}
                rows={6}
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
                {bio.length}/500
              </div>

              {message && allowed && (
                <p
                  style={{
                    marginTop: "16px",
                    color:
                      message === "Profile saved."
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
                  marginTop: "22px",
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
