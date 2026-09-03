"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type ProfilePhoto = {
  id: string;
  storage_path: string;
};

export default function TenderPhotoPage() {
  const params = useParams();
  const bartenderId = params.bartenderId as string;

  const [photo, setPhoto] = useState<ProfilePhoto | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");

  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [message, setMessage] = useState("");

  async function loadPhoto() {
    const { data, error } = await supabase
      .from("media_assets")
      .select("id, storage_path")
      .eq("entity_kind", "bartender")
      .eq("bartender_id", bartenderId)
      .eq("is_hero", true)
      .eq("status", "published")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      setMessage(error.message);
      return;
    }

    setPhoto((data as ProfilePhoto | null) ?? null);
  }

  useEffect(() => {
    async function loadPage() {
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
          .select("bartender_id, can_manage_media")
          .eq("bartender_id", bartenderId)
          .eq("user_id", user.id)
          .maybeSingle();

      if (permissionError) {
        setMessage(permissionError.message);
        setLoading(false);
        return;
      }

      if (!permission?.can_manage_media) {
        setMessage(
          "You do not have permission to manage this Tender's photo."
        );
        setLoading(false);
        return;
      }

      const { data: bartender, error: bartenderError } =
        await supabase
          .from("bartenders")
          .select("display_name, slug")
          .eq("id", bartenderId)
          .single();

      if (bartenderError) {
        setMessage(bartenderError.message);
        setLoading(false);
        return;
      }

      setDisplayName(bartender.display_name);
      setSlug(bartender.slug);
      setAllowed(true);

      await loadPhoto();
      setLoading(false);
    }

    loadPage();
  }, [bartenderId]);

  async function removePhoto(item: ProfilePhoto) {
    const { error: storageError } = await supabase.storage
      .from("spot-media")
      .remove([item.storage_path]);

    if (storageError) {
      setMessage(storageError.message);
      return false;
    }

    const { error: dbError } = await supabase
      .from("media_assets")
      .delete()
      .eq("id", item.id);

    if (dbError) {
      setMessage(dbError.message);
      return false;
    }

    return true;
  }

  async function handleUpload(file: File) {
    if (!allowed || uploading) return;

    setMessage("");

    if (!file.type.startsWith("image/")) {
      setMessage("Profile photos must be image files.");
      return;
    }

    if (file.size > 8 * 1024 * 1024) {
      setMessage("Profile photos must be 8 MB or smaller.");
      return;
    }

    setUploading(true);

    /*
      Remove the existing profile photo first so V1 always has
      one active Tender hero image.
    */
    if (photo) {
      const removed = await removePhoto(photo);

      if (!removed) {
        setUploading(false);
        return;
      }

      setPhoto(null);
    }

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");

    const path =
      `${bartenderId}/profile/` +
      `${crypto.randomUUID()}-${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from("spot-media")
      .upload(path, file);

    if (uploadError) {
      setMessage(uploadError.message);
      setUploading(false);
      return;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      await supabase.storage
        .from("spot-media")
        .remove([path]);

      setMessage("You must be signed in.");
      setUploading(false);
      return;
    }

    const { data: inserted, error: insertError } = await supabase
      .from("media_assets")
      .insert({
        entity_kind: "bartender",
        bartender_id: bartenderId,
        venue_id: null,
        uploaded_by_user_id: user.id,
        storage_path: path,
        media_type: "photo",
        is_hero: true,
        status: "published",
      })
      .select("id, storage_path")
      .single();

    if (insertError) {
      await supabase.storage
        .from("spot-media")
        .remove([path]);

      setMessage(insertError.message);
      setUploading(false);
      return;
    }

    setPhoto(inserted as ProfilePhoto);
    setMessage("Profile photo saved.");
    setUploading(false);
  }

  async function handleDelete() {
    if (!photo || uploading) return;

    setMessage("");

    const removed = await removePhoto(photo);

    if (!removed) return;

    setPhoto(null);
    setMessage("Profile photo removed.");
  }

  const photoUrl = photo
    ? supabase.storage
        .from("spot-media")
        .getPublicUrl(photo.storage_path).data.publicUrl
    : null;

  return (
    <main className="flow-page">
      <div className="shell narrow">
        <div className="flow-card">
          <div className="eyebrow">Tender Account</div>
          <h1>Profile photo.</h1>

          <p className="lead-copy">
            Choose the photo shown on your public Tender profile.
          </p>

          {loading && <p>Loading your photo...</p>}

          {!loading && !allowed && message && (
            <p style={{ color: "crimson" }}>
              {message}
            </p>
          )}

          {!loading && allowed && (
            <>
              <div
                style={{
                  width: "220px",
                  height: "220px",
                  margin: "24px auto",
                  borderRadius: "18px",
                  overflow: "hidden",
                  background: "#eee8dc",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                {photoUrl ? (
                  <img
                    src={photoUrl}
                    alt={displayName}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                    }}
                  />
                ) : (
                  <span
                    style={{
                      fontSize: "72px",
                      fontWeight: 900,
                    }}
                  >
                    {displayName?.[0] ?? "T"}
                  </span>
                )}
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  gap: "10px",
                  flexWrap: "wrap",
                }}
              >
                <label
                  className="btn primary"
                  style={{
                    cursor: uploading
                      ? "default"
                      : "pointer",
                  }}
                >
                  {uploading
                    ? "Uploading..."
                    : photo
                      ? "Replace Photo"
                      : "Upload Photo"}

                  <input
                    type="file"
                    accept="image/*"
                    disabled={uploading}
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];

                      if (file) {
                        handleUpload(file);
                      }

                      e.currentTarget.value = "";
                    }}
                  />
                </label>

                {photo && (
                  <button
                    type="button"
                    className="btn outline"
                    disabled={uploading}
                    onClick={handleDelete}
                  >
                    Remove Photo
                  </button>
                )}
              </div>

              {message && (
                <p
                  style={{
                    marginTop: "16px",
                    textAlign: "center",
                    fontWeight: 700,
                  }}
                >
                  {message}
                </p>
              )}

              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  gap: "10px",
                  flexWrap: "wrap",
                  marginTop: "24px",
                }}
              >
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
            </>
          )}
        </div>
      </div>
    </main>
  );
}
