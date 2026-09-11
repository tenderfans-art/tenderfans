"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";
import { supabase } from "@/lib/supabase";

type TenderProfile = {
  id: string;
  slug: string;
  display_name: string;
  bio: string | null;
};

type TenderSpot = {
  name: string;
  slug: string;
};

export default function TenderAccountPage() {
  const [tender, setTender] = useState<TenderProfile | null>(null);
  const [spots, setSpots] = useState<(TenderSpot & { is_primary: boolean })[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [contestUrl, setContestUrl] = useState("");
  const [contestActionMessage, setContestActionMessage] = useState("");
  const [showContestTools, setShowContestTools] = useState(false);

  const [instagramHandle, setInstagramHandle] = useState("");
  const [facebookHandle, setFacebookHandle] = useState("");
  const [tiktokHandle, setTiktokHandle] = useState("");
  const [socialTagConsent, setSocialTagConsent] = useState(false);
  const [socialMessage, setSocialMessage] = useState("");

  const contestQrRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    async function loadTender() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        window.location.href = "/login";
        return;
      }

      const { data: permissions, error: permissionError } = await supabase
        .from("bartender_permissions")
        .select("bartender_id")
        .eq("user_id", user.id);

      if (permissionError) {
        setMessage(permissionError.message);
        setLoading(false);
        return;
      }

      const bartenderId = permissions?.[0]?.bartender_id;

      if (!bartenderId) {
        setLoading(false);
        return;
      }

      const { data: bartender, error: bartenderError } = await supabase
        .from("bartenders")
        .select("id, slug, display_name, bio")
        .eq("id", bartenderId)
        .single();

      if (bartenderError) {
        setMessage(bartenderError.message);
        setLoading(false);
        return;
      }

      setTender(bartender as TenderProfile);

      const { data: socialRows, error: socialError } =
        await supabase
          .from("tender_social_permissions")
          .select("platform, social_handle, tag_permission")
          .eq("bartender_id", bartenderId);

      if (socialError) {
        setMessage(socialError.message);
        setLoading(false);
        return;
      }

      for (const row of socialRows ?? []) {
        if (row.platform === "instagram") {
          setInstagramHandle(row.social_handle ?? "");
        }

        if (row.platform === "facebook") {
          setFacebookHandle(row.social_handle ?? "");
        }

        if (row.platform === "tiktok") {
          setTiktokHandle(row.social_handle ?? "");
        }

        if (row.tag_permission === true) {
          setSocialTagConsent(true);
        }
      }

      const { data: relationships, error: relationshipError } =
        await supabase
          .from("bartender_venues")
          .select("venue_id, is_primary")
          .eq("bartender_id", bartenderId)
          .eq("is_current", true)
          .order("is_primary", { ascending: false });

      if (relationshipError) {
        setMessage(relationshipError.message);
        setLoading(false);
        return;
      }

      if (relationships && relationships.length > 0) {
        const venueIds = relationships.map(
          (relationship) => relationship.venue_id
        );

        const { data: venueRows, error: venueError } =
          await supabase
            .from("venues")
            .select("id, name, slug")
            .in("id", venueIds);

        if (venueError) {
          setMessage(venueError.message);
          setLoading(false);
          return;
        }

        const venueMap = new Map(
          (venueRows ?? []).map((venue) => [venue.id, venue])
        );

        setSpots(
          relationships
            .map((relationship) => {
              const venue = venueMap.get(relationship.venue_id);

              if (!venue) return null;

              return {
                ...venue,
                is_primary: relationship.is_primary,
              };
            })
            .filter(Boolean) as (TenderSpot & {
              is_primary: boolean;
            })[]
        );
      }

      setLoading(false);
    }

    loadTender();
  }, []);

  useEffect(() => {
    if (!tender) {
      setContestUrl("");
      return;
    }

    setContestUrl(
      `${window.location.origin}/contest/t/${tender.slug}`
    );
  }, [tender]);

  async function copyContestLink() {
    if (!contestUrl) return;

    try {
      await navigator.clipboard.writeText(contestUrl);
      setContestActionMessage("Contest link copied.");
    } catch {
      setContestActionMessage(
        "Could not copy automatically. You can copy the link above."
      );
    }
  }

  async function shareContestLink() {
    if (!contestUrl || !tender) return;

    if (navigator.share) {
      try {
        await navigator.share({
          title: `${tender.display_name} on TenderFans`,
          text: `Give ${tender.display_name} a Shout on TenderFans.`,
          url: contestUrl,
        });
        return;
      } catch (error) {
        if (
          error instanceof DOMException &&
          error.name === "AbortError"
        ) {
          return;
        }
      }
    }

    await copyContestLink();
  }

  function downloadContestQr() {
    const canvas = contestQrRef.current;

    if (!canvas || !tender) return;

    const pngUrl = canvas.toDataURL("image/png");

    const link = document.createElement("a");
    link.href = pngUrl;
    link.download = `${tender.slug}-tenderfans-contest-qr.png`;
    link.click();
  }

  async function saveSocialPermissions() {
    if (!tender) return;

    setSocialMessage("");

    const entries = [
      {
        platform: "instagram",
        social_handle: instagramHandle.trim(),
      },
      {
        platform: "facebook",
        social_handle: facebookHandle.trim(),
      },
      {
        platform: "tiktok",
        social_handle: tiktokHandle.trim(),
      },
    ].filter((entry) => entry.social_handle);

    if (entries.length === 0) {
      setSocialMessage(
        "Add at least one social account before saving."
      );
      return;
    }

    if (!socialTagConsent) {
      setSocialMessage(
        "Please confirm permission for TenderFans to tag the account(s) you provide."
      );
      return;
    }

    const consentedAt = new Date().toISOString();

    const { error: deleteError } = await supabase
      .from("tender_social_permissions")
      .delete()
      .eq("bartender_id", tender.id);

    if (deleteError) {
      setSocialMessage(deleteError.message);
      return;
    }

    const { error: insertError } = await supabase
      .from("tender_social_permissions")
      .insert(
        entries.map((entry) => ({
          bartender_id: tender.id,
          platform: entry.platform,
          social_handle: entry.social_handle,
          tag_permission: true,
          consented_at: consentedAt,
        }))
      );

    if (insertError) {
      setSocialMessage(insertError.message);
      return;
    }

    setSocialMessage("Social tagging preferences saved.");
  }

  async function removeSocialPermissions() {
    if (!tender) return;

    const { error } = await supabase
      .from("tender_social_permissions")
      .delete()
      .eq("bartender_id", tender.id);

    if (error) {
      setSocialMessage(error.message);
      return;
    }

    setInstagramHandle("");
    setFacebookHandle("");
    setTiktokHandle("");
    setSocialTagConsent(false);
    setSocialMessage("Social tagging permission removed.");
  }

  const cardStyle = {
    display: "block",
    padding: "13px 12px",
    border: "1px solid #d7d1c6",
    borderRadius: "14px",
    textDecoration: "none",
    color: "inherit",
    textAlign: "center" as const,
  };

  const descriptionStyle = {
    marginTop: "4px",
    fontSize: "0.78rem",
    color: "#697177",
  };

  return (
    <main className="flow-page">
      <div className="shell">
        <div className="flow-card">
          <div className="eyebrow">Tender Account</div>
          <h1>Manage your Tender profile.</h1>

          <p className="lead-copy">
            Keep your profile current and manage your TenderFans presence.
          </p>

          {loading && <p>Loading your Tender profile...</p>}

          {message && (
            <p style={{ color: "crimson" }}>
              {message}
            </p>
          )}

          {!loading && !message && !tender && (
            <div
              style={{
                marginTop: "22px",
                padding: "18px",
                border: "1px solid #ddd",
                borderRadius: "14px",
              }}
            >
              <strong>No approved Tender profile yet.</strong>
              <p style={{ marginBottom: 0 }}>
                Once your Tender claim is approved, your profile will appear here.
              </p>
            </div>
          )}

          {!loading && !message && tender && (
            <section style={{ marginTop: "26px" }}>
              <div style={{ marginBottom: "16px" }}>
                <h2 style={{ margin: "0 0 4px" }}>
                  {tender.display_name}
                </h2>

                {spots.length > 0 && (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      gap: "6px 10px",
                      color: "#697177",
                    }}
                  >
                    <span>
                      Current Tender at
                    </span>

                    {spots.map((spot, index) => (
                      <span
                        key={spot.slug}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "5px",
                        }}
                      >
                        <strong
                          style={{
                            color: "#172735",
                            fontWeight: 700,
                          }}
                        >
                          {spot.name}
                        </strong>

                        {spot.is_primary && (
                          <span
                            style={{
                              fontSize: "0.68rem",
                              fontWeight: 800,
                              padding: "3px 7px",
                              borderRadius: "999px",
                              background: "#172735",
                              color: "#fff",
                            }}
                          >
                            Primary
                          </span>
                        )}

                        {index < spots.length - 1 && (
                          <span style={{ color: "#a19d94" }}>
                            ·
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(5, minmax(0, 1fr))",
                  gap: "10px",
                }}
              >
                <Link
                  href={`/account/tender/${tender.id}/profile`}
                  style={cardStyle}
                >
                  <strong>Edit Profile</strong>
                  <div style={descriptionStyle}>
                    Name & bio
                  </div>
                </Link>

                <Link
                  href={`/account/tender/${tender.id}/photo`}
                  style={cardStyle}
                >
                  <strong>Photo</strong>
                  <div style={descriptionStyle}>
                    Profile photo
                  </div>
                </Link>

                <Link
                  href={`/account/tender/${tender.id}/spot`}
                  style={cardStyle}
                >
                  <strong>Manage Spots</strong>
                  <div style={descriptionStyle}>
                    Verified workplaces
                  </div>
                </Link>

                <Link
                  href={`/t/${tender.slug}`}
                  style={cardStyle}
                >
                  <strong>View Profile</strong>
                  <div style={descriptionStyle}>
                    View public Tender page
                  </div>
                </Link>

                <button
                  type="button"
                  onClick={() => setShowContestTools(true)}
                  style={{
                    ...cardStyle,
                    background: "#fff",
                    font: "inherit",
                    cursor: "pointer",
                    width: "100%",
                  }}
                >
                  <strong>Contest</strong>
                  <div style={descriptionStyle}>
                    QR code &amp; share tools
                  </div>
                </button>
              </div>

              {showContestTools && (
              <div
                id="contest-tools"
                style={{
                  marginTop: "28px",
                  padding: "24px",
                  border: "1px solid #d7d1c6",
                  borderRadius: "18px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "12px",
                  }}
                >
                  <div className="eyebrow">Contest Tools</div>

                  <button
                    type="button"
                    className="back"
                    onClick={() => setShowContestTools(false)}
                    style={{ padding: 0 }}
                  >
                    Close
                  </button>
                </div>

                <h2 style={{ margin: "6px 0 8px" }}>
                  Share your TenderFans contest link.
                </h2>

                <p
                  style={{
                    margin: "0 0 20px",
                    color: "#697177",
                    lineHeight: 1.55,
                  }}
                >
                  Your contest link and QR code are created automatically
                  and can be reused for future TenderFans contests.
                </p>

                {contestUrl && (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "minmax(190px, 230px) minmax(0, 1fr)",
                      gap: "24px",
                      alignItems: "center",
                    }}
                  >
                    <div
                      style={{
                        background: "#fff",
                        border: "1px solid #d7d1c6",
                        borderRadius: "16px",
                        padding: "16px",
                        display: "grid",
                        placeItems: "center",
                      }}
                    >
                      <QRCodeCanvas
                        ref={contestQrRef}
                        value={contestUrl}
                        size={200}
                        marginSize={1}
                      />
                    </div>

                    <div>
                      <strong>Your permanent contest link</strong>

                      <div
                        style={{
                          marginTop: "8px",
                          padding: "12px 14px",
                          border: "1px solid #d7d1c6",
                          borderRadius: "10px",
                          overflowWrap: "anywhere",
                          fontSize: "0.9rem",
                        }}
                      >
                        {contestUrl}
                      </div>

                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "10px",
                          marginTop: "16px",
                        }}
                      >
                        <button
                          type="button"
                          className="btn primary"
                          onClick={copyContestLink}
                        >
                          Copy Link
                        </button>

                        <button
                          type="button"
                          className="btn outline"
                          onClick={shareContestLink}
                        >
                          Share
                        </button>

                        <button
                          type="button"
                          className="btn outline"
                          onClick={downloadContestQr}
                        >
                          Download QR
                        </button>

                        <Link
                          className="btn outline"
                          href={`/contest/t/${tender.slug}`}
                        >
                          Open Contest Page
                        </Link>
                      </div>

                      {contestActionMessage && (
                        <p
                          style={{
                            margin: "12px 0 0",
                            color: "#697177",
                            fontSize: "0.85rem",
                          }}
                        >
                          {contestActionMessage}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                <div
                  style={{
                    marginTop: "28px",
                    paddingTop: "24px",
                    borderTop: "1px solid #d7d1c6",
                  }}
                >
                  <div className="eyebrow">
                    Social Sharing Permissions
                  </div>

                  <h3 style={{ margin: "6px 0 8px" }}>
                    Let TenderFans tag you in contest promotions.
                  </h3>

                  <p
                    style={{
                      margin: "0 0 18px",
                      color: "#697177",
                      lineHeight: 1.55,
                    }}
                  >
                    Social account information is optional and private.
                    It is used only by TenderFans staff for authorized
                    social-media tagging and will never be displayed on
                    your public Tender profile.
                  </p>

                  <div
                    style={{
                      display: "grid",
                      gap: "12px",
                    }}
                  >
                    <label>
                      <strong>Instagram</strong>
                      <input
                        className="field"
                        type="text"
                        value={instagramHandle}
                        onChange={(e) =>
                          setInstagramHandle(e.target.value)
                        }
                        placeholder="@handle or profile URL"
                      />
                    </label>

                    <label>
                      <strong>Facebook</strong>
                      <input
                        className="field"
                        type="text"
                        value={facebookHandle}
                        onChange={(e) =>
                          setFacebookHandle(e.target.value)
                        }
                        placeholder="Profile or page URL"
                      />
                    </label>

                    <label>
                      <strong>TikTok</strong>
                      <input
                        className="field"
                        type="text"
                        value={tiktokHandle}
                        onChange={(e) =>
                          setTiktokHandle(e.target.value)
                        }
                        placeholder="@handle or profile URL"
                      />
                    </label>

                    <label
                      style={{
                        display: "flex",
                        gap: "10px",
                        alignItems: "flex-start",
                        lineHeight: 1.5,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={socialTagConsent}
                        onChange={(e) =>
                          setSocialTagConsent(e.target.checked)
                        }
                        style={{ marginTop: "4px" }}
                      />

                      <span>
                        I give TenderFans permission to tag or mention the
                        social account(s) I provide in TenderFans contest
                        standings, Tender spotlights, milestones, winner
                        announcements and other TenderFans promotional posts.
                      </span>
                    </label>

                    <p
                      style={{
                        margin: 0,
                        fontSize: "0.82rem",
                        color: "#697177",
                        lineHeight: 1.5,
                      }}
                    >
                      Providing social information is optional and is not
                      required to participate in contests. You may remove
                      your social information and revoke future tagging
                      permission at any time.
                    </p>

                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: "10px",
                        marginTop: "6px",
                      }}
                    >
                      <button
                        type="button"
                        className="btn primary"
                        onClick={saveSocialPermissions}
                      >
                        Save Social Permissions
                      </button>

                      <button
                        type="button"
                        className="btn outline"
                        onClick={removeSocialPermissions}
                      >
                        Remove Social Information
                      </button>
                    </div>

                    {socialMessage && (
                      <p
                        style={{
                          margin: "4px 0 0",
                          color: "#697177",
                          fontSize: "0.85rem",
                        }}
                      >
                        {socialMessage}
                      </p>
                    )}
                  </div>
                </div>
              </div>
              )}
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
