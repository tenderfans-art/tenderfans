"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type MediaPhoto = {
  id: string;
  storage_path: string;
  created_at?: string;
};

const MAX_GALLERY_PHOTOS = 6;
const MAX_FILE_SIZE = 8 * 1024 * 1024;

export default function TenderPhotoPage() {
  const params = useParams();
  const bartenderId = params.bartenderId as string;

  const [profilePhoto, setProfilePhoto] =
    useState<MediaPhoto | null>(null);

  const [galleryPhotos, setGalleryPhotos] =
    useState<MediaPhoto[]>([]);

  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");

  const [loading, setLoading] = useState(true);
  const [uploadingProfile, setUploadingProfile] = useState(false);
  const [uploadingGallery, setUploadingGallery] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [message, setMessage] = useState("");

  async function loadPhotos() {
    const { data: heroData, error: heroError } = await supabase
      .from("media_assets")
      .select("id, storage_path, created_at")
      .eq("entity_kind", "bartender")
      .eq("bartender_id", bartenderId)
      .eq("media_type", "photo")
      .eq("is_hero", true)
      .eq("status", "published")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (heroError) {
      setMessage(heroError.message);
      return;
    }

    const { data: galleryData, error: galleryError } =
      await supabase
        .from("media_assets")
        .select("id, storage_path, created_at")
        .eq("entity_kind", "bartender")
        .eq("bartender_id", bartenderId)
        .eq("media_type", "photo")
        .eq("is_hero", false)
        .eq("status", "published")
        .order("created_at", { ascending: false });

    if (galleryError) {
      setMessage(galleryError.message);
      return;
    }

    setProfilePhoto((heroData as MediaPhoto | null) ?? null);
    setGalleryPhotos((galleryData ?? []) as MediaPhoto[]);
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
          "You do not have permission to manage this Tender's photos."
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

      await loadPhotos();

      setLoading(false);
    }

    loadPage();
  }, [bartenderId]);

  function validateImage(file: File) {
    if (!file.type.startsWith("image/")) {
      setMessage("Photos must be image files.");
      return false;
    }

    if (file.size > MAX_FILE_SIZE) {
      setMessage("Photos must be 8 MB or smaller.");
      return false;
    }

    return true;
  }

  async function removePhoto(item: MediaPhoto) {
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

  async function handleProfileUpload(file: File) {
    if (!allowed || uploadingProfile) return;

    setMessage("");

    if (!validateImage(file)) return;

    setUploadingProfile(true);

    if (profilePhoto) {
      const removed = await removePhoto(profilePhoto);

      if (!removed) {
        setUploadingProfile(false);
        return;
      }

      setProfilePhoto(null);
    }

    const safeName = file.name.replace(
      /[^a-zA-Z0-9._-]/g,
      "-"
    );

    const path =
      `${bartenderId}/profile/` +
      `${crypto.randomUUID()}-${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from("spot-media")
      .upload(path, file);

    if (uploadError) {
      setMessage(uploadError.message);
      setUploadingProfile(false);
      return;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      await supabase.storage.from("spot-media").remove([path]);

      setMessage("You must be signed in.");
      setUploadingProfile(false);
      return;
    }

    const { data: inserted, error: insertError } =
      await supabase
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
        .select("id, storage_path, created_at")
        .single();

    if (insertError) {
      await supabase.storage.from("spot-media").remove([path]);

      setMessage(insertError.message);
      setUploadingProfile(false);
      return;
    }

    setProfilePhoto(inserted as MediaPhoto);
    setMessage("Profile photo saved.");
    setUploadingProfile(false);
  }

  async function handleGalleryUpload(file: File) {
    if (!allowed || uploadingGallery) return;

    setMessage("");

    if (!validateImage(file)) return;

    /*
      Check the DB, not just React state, so the 6-photo
      limit cannot be bypassed with repeated fast uploads.
    */
    const { count, error: countError } = await supabase
      .from("media_assets")
      .select("id", { count: "exact", head: true })
      .eq("entity_kind", "bartender")
      .eq("bartender_id", bartenderId)
      .eq("media_type", "photo")
      .eq("is_hero", false)
      .eq("status", "published");

    if (countError) {
      setMessage(countError.message);
      return;
    }

    if ((count ?? 0) >= MAX_GALLERY_PHOTOS) {
      setMessage(
        "Gallery is full. Remove a photo before uploading another."
      );
      return;
    }

    setUploadingGallery(true);

    const safeName = file.name.replace(
      /[^a-zA-Z0-9._-]/g,
      "-"
    );

    const path =
      `${bartenderId}/gallery/` +
      `${crypto.randomUUID()}-${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from("spot-media")
      .upload(path, file);

    if (uploadError) {
      setMessage(uploadError.message);
      setUploadingGallery(false);
      return;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      await supabase.storage.from("spot-media").remove([path]);

      setMessage("You must be signed in.");
      setUploadingGallery(false);
      return;
    }

    const { data: inserted, error: insertError } =
      await supabase
        .from("media_assets")
        .insert({
          entity_kind: "bartender",
          bartender_id: bartenderId,
          venue_id: null,
          uploaded_by_user_id: user.id,
          storage_path: path,
          media_type: "photo",
          is_hero: false,
          status: "published",
        })
        .select("id, storage_path, created_at")
        .single();

    if (insertError) {
      await supabase.storage.from("spot-media").remove([path]);

      setMessage(insertError.message);
      setUploadingGallery(false);
      return;
    }

    setGalleryPhotos((current) => [
      inserted as MediaPhoto,
      ...current,
    ]);

    setMessage("Gallery photo added.");
    setUploadingGallery(false);
  }

  async function handleDeleteProfile() {
    if (!profilePhoto || uploadingProfile) return;

    setMessage("");

    const removed = await removePhoto(profilePhoto);

    if (!removed) return;

    setProfilePhoto(null);
    setMessage("Profile photo removed.");
  }

  async function handleDeleteGallery(item: MediaPhoto) {
    if (uploadingGallery) return;

    setMessage("");

    const removed = await removePhoto(item);

    if (!removed) return;

    setGalleryPhotos((current) =>
      current.filter((photo) => photo.id !== item.id)
    );

    setMessage("Gallery photo removed.");
  }

  const profilePhotoUrl = profilePhoto
    ? supabase.storage
        .from("spot-media")
        .getPublicUrl(profilePhoto.storage_path).data.publicUrl
    : null;

  return (
    <main
      className="flow-page"
      style={{
        paddingTop: "18px",
        paddingBottom: "24px",
      }}
    >
      <div className="shell narrow">
        <div
          className="flow-card"
          style={{
            paddingTop: "24px",
            paddingBottom: "24px",
          }}
        >
          <div
            className="eyebrow"
            style={{ marginBottom: "4px" }}
          >
            Tender Account
          </div>

          <h1
            style={{
              marginTop: "4px",
              marginBottom: "8px",
            }}
          >
            Photos.
          </h1>

          <p
            className="lead-copy"
            style={{
              marginTop: 0,
              marginBottom: "12px",
            }}
          >
            Manage your profile photo and up to six photos shown
            in your Tender gallery.
          </p>

          {loading && <p>Loading your photos...</p>}

          {!loading && !allowed && message && (
            <p style={{ color: "crimson" }}>{message}</p>
          )}

          {!loading && allowed && (
            <>
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "flex-start",
                  gap: "42px",
                  flexWrap: "wrap",
                  marginTop: "12px",
                }}
              >
                {/* PROFILE PHOTO */}
                <section
                  style={{
                    width: "220px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: "8px",
                      marginBottom: "10px",
                    }}
                  >
                    <h2
                      style={{
                        margin: 0,
                        fontSize: "1.15rem",
                      }}
                    >
                      Profile Photo
                    </h2>
                  </div>

                  <div
                    style={{
                      width: "220px",
                      height: "220px",
                      borderRadius: "18px",
                      overflow: "hidden",
                      background: "#eee8dc",
                      display: "grid",
                      placeItems: "center",
                    }}
                  >
                    {profilePhotoUrl ? (
                      <img
                        src={profilePhotoUrl}
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
                      gap: "8px",
                      flexWrap: "wrap",
                      marginTop: "14px",
                    }}
                  >
                    <label
                      className="btn primary"
                      style={{
                        cursor: uploadingProfile
                          ? "default"
                          : "pointer",
                      }}
                    >
                      {uploadingProfile
                        ? "Uploading..."
                        : profilePhoto
                          ? "Replace"
                          : "Upload Photo"}

                      <input
                        type="file"
                        accept="image/*"
                        disabled={uploadingProfile}
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const file = e.target.files?.[0];

                          if (file) {
                            handleProfileUpload(file);
                          }

                          e.currentTarget.value = "";
                        }}
                      />
                    </label>

                    {profilePhoto && (
                      <button
                        type="button"
                        className="btn outline"
                        disabled={uploadingProfile}
                        onClick={handleDeleteProfile}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </section>

                {/* GALLERY PHOTOS */}
                <section
                  style={{
                    width: "220px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: "8px",
                      marginBottom: "10px",
                    }}
                  >
                    <h2
                      style={{
                        margin: 0,
                        fontSize: "1.15rem",
                      }}
                    >
                      Gallery Photos
                    </h2>

                    <strong
                      style={{
                        fontSize: "0.9rem",
                        color: "#697177",
                      }}
                    >
                      {galleryPhotos.length}/{MAX_GALLERY_PHOTOS}
                    </strong>
                  </div>

                  <div
                    style={{
                      width: "220px",
                      height: "220px",
                      display: "grid",
                      gridTemplateColumns: "repeat(2, 1fr)",
                      gridTemplateRows: "repeat(3, 1fr)",
                      gap: "6px",
                      padding: "6px",
                      boxSizing: "border-box",
                      borderRadius: "18px",
                      border: "1px solid #ded8cc",
                      background: "#eee8dc",
                      overflow: "hidden",
                    }}
                  >
                    {Array.from({
                      length: MAX_GALLERY_PHOTOS,
                    }).map((_, index) => {
                      const item = galleryPhotos[index];

                      if (!item) {
                        return (
                          <div
                            key={`empty-${index}`}
                            style={{
                              borderRadius: "9px",
                              border:
                                "1px dashed rgba(23,39,53,.18)",
                              background:
                                "rgba(255,255,255,.38)",
                            }}
                          />
                        );
                      }

                      const url = supabase.storage
                        .from("spot-media")
                        .getPublicUrl(item.storage_path)
                        .data.publicUrl;

                      return (
                        <div
                          key={item.id}
                          style={{
                            position: "relative",
                            minWidth: 0,
                            minHeight: 0,
                            borderRadius: "9px",
                            overflow: "hidden",
                            background: "#172735",
                          }}
                        >
                          <img
                            src={url}
                            alt={`${displayName} gallery`}
                            style={{
                              display: "block",
                              width: "100%",
                              height: "100%",
                              objectFit: "cover",
                            }}
                          />

                          <button
                            type="button"
                            disabled={uploadingGallery}
                            onClick={() =>
                              handleDeleteGallery(item)
                            }
                            aria-label="Remove gallery photo"
                            title="Remove photo"
                            style={{
                              position: "absolute",
                              top: "4px",
                              right: "4px",
                              width: "22px",
                              height: "22px",
                              padding: 0,
                              borderRadius: "999px",
                              border:
                                "1px solid rgba(255,255,255,.7)",
                              background:
                                "rgba(5,21,31,.78)",
                              color: "#fff",
                              fontSize: "15px",
                              fontWeight: 900,
                              lineHeight: 1,
                              display: "grid",
                              placeItems: "center",
                              cursor: uploadingGallery
                                ? "default"
                                : "pointer",
                            }}
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      justifyContent: "center",
                      marginTop: "14px",
                    }}
                  >
                    <label
                      className={
                        galleryPhotos.length >=
                        MAX_GALLERY_PHOTOS
                          ? "btn outline"
                          : "btn primary"
                      }
                      style={{
                        cursor:
                          uploadingGallery ||
                          galleryPhotos.length >=
                            MAX_GALLERY_PHOTOS
                            ? "default"
                            : "pointer",
                        opacity:
                          galleryPhotos.length >=
                          MAX_GALLERY_PHOTOS
                            ? 0.55
                            : 1,
                      }}
                    >
                      {uploadingGallery
                        ? "Uploading..."
                        : galleryPhotos.length >=
                            MAX_GALLERY_PHOTOS
                          ? "Gallery Full"
                          : "Add Gallery Photo"}

                      <input
                        type="file"
                        accept="image/*"
                        disabled={
                          uploadingGallery ||
                          galleryPhotos.length >=
                            MAX_GALLERY_PHOTOS
                        }
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const file = e.target.files?.[0];

                          if (file) {
                            handleGalleryUpload(file);
                          }

                          e.currentTarget.value = "";
                        }}
                      />
                    </label>
                  </div>
                </section>
              </div>

              {message && (
                <p
                  style={{
                    marginTop: "20px",
                    fontWeight: 700,
                    color: message
                      .toLowerCase()
                      .includes("error")
                      ? "crimson"
                      : "#6f8420",
                  }}
                >
                  {message}
                </p>
              )}

              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                  gap: "10px",
                  flexWrap: "wrap",
                  width: "100%",
                  marginTop: "22px",
                }}
              >
                {slug && (
                  <Link
                    href={`/t/${slug}`}
                    className="btn primary"
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
