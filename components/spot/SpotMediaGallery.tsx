"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type MediaType = "menu" | "special" | "photo";

type MediaAsset = {
  id: string;
  storage_path: string;
  media_type: MediaType;
  created_at: string;
};

const MAX_GALLERY_PHOTOS = 6;
const MAX_FILE_SIZE = 8 * 1024 * 1024;

export default function SpotMediaGallery({
  venueId,
  mediaType,
}: {
  venueId: string;
  mediaType: MediaType;
}) {
  const [items, setItems] = useState<MediaAsset[]>([]);
  const [message, setMessage] = useState("");
  const [uploading, setUploading] = useState(false);

  async function loadItems() {
    const { data, error } = await supabase
      .from("media_assets")
      .select("id, storage_path, media_type, created_at")
      .eq("venue_id", venueId)
      .eq("entity_kind", "venue")
      .eq("media_type", mediaType)
      .eq("status", "published")
      .order("created_at", { ascending: false });

    if (error) {
      setMessage(error.message);
      return;
    }

    setItems((data ?? []) as MediaAsset[]);
  }

  useEffect(() => {
    loadItems();
  }, [venueId, mediaType]);

  async function handleUpload(file: File) {
    if (uploading) return;

    setMessage("");

    const isPdf = file.type === "application/pdf";
    const isImage = file.type.startsWith("image/");

    if (mediaType === "photo" && !isImage) {
      setMessage("Photos must be image files.");
      return;
    }

    if (
      (mediaType === "menu" || mediaType === "special") &&
      !isImage &&
      !isPdf
    ) {
      setMessage("Menus and specials must be an image or PDF.");
      return;
    }

    if (file.size > MAX_FILE_SIZE) {
      setMessage("Files must be 8 MB or smaller.");
      return;
    }

    /*
      Check the DB for Spot photos rather than relying only on
      React state, matching the Tender gallery's 6-photo limit.
    */
    if (mediaType === "photo") {
      const { count, error: countError } = await supabase
        .from("media_assets")
        .select("id", { count: "exact", head: true })
        .eq("entity_kind", "venue")
        .eq("venue_id", venueId)
        .eq("media_type", "photo")
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
    }

    setUploading(true);

    const safeName = file.name.replace(
      /[^a-zA-Z0-9._-]/g,
      "-"
    );

    const path =
      `${venueId}/${mediaType}/` +
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
      await supabase.storage.from("spot-media").remove([path]);
      setMessage("You must be signed in.");
      setUploading(false);
      return;
    }

    const { data: inserted, error: insertError } =
      await supabase
        .from("media_assets")
        .insert({
          entity_kind: "venue",
          venue_id: venueId,
          bartender_id: null,
          uploaded_by_user_id: user.id,
          storage_path: path,
          media_type: mediaType,
          status: "published",
        })
        .select("id, storage_path, media_type, created_at")
        .single();

    if (insertError) {
      await supabase.storage.from("spot-media").remove([path]);
      setMessage(insertError.message);
      setUploading(false);
      return;
    }

    setItems((current) => [
      inserted as MediaAsset,
      ...current,
    ]);

    setMessage(
      mediaType === "photo"
        ? "Gallery photo added."
        : "Upload complete."
    );

    setUploading(false);
  }

  async function handleDelete(item: MediaAsset) {
    if (uploading) return;

    setMessage("");

    const { error: storageError } = await supabase.storage
      .from("spot-media")
      .remove([item.storage_path]);

    if (storageError) {
      setMessage(storageError.message);
      return;
    }

    const { error: dbError } = await supabase
      .from("media_assets")
      .delete()
      .eq("id", item.id);

    if (dbError) {
      setMessage(dbError.message);
      return;
    }

    setItems((current) =>
      current.filter((existing) => existing.id !== item.id)
    );

    setMessage(
      mediaType === "photo"
        ? "Gallery photo removed."
        : "Item removed."
    );
  }

  /*
    Spot Photos intentionally mirror the Tender gallery.
    Menus and Specials retain their existing presentation.
  */
  if (mediaType === "photo") {
    return (
      <div>
        <section
          style={{
            width: "220px",
            margin: "12px auto 0",
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
              {items.length}/{MAX_GALLERY_PHOTOS}
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
              const item = items[index];

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
                    alt="Spot gallery"
                    style={{
                      display: "block",
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                    }}
                  />

                  <button
                    type="button"
                    disabled={uploading}
                    onClick={() => handleDelete(item)}
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
                      cursor: uploading
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
              alignItems: "center",
              gap: "10px",
              flexWrap: "wrap",
              marginTop: "14px",
            }}
          >
            <label
              className={
                items.length >= MAX_GALLERY_PHOTOS
                  ? "btn outline"
                  : "btn primary"
              }
              style={{
                cursor:
                  uploading ||
                  items.length >= MAX_GALLERY_PHOTOS
                    ? "default"
                    : "pointer",
                opacity:
                  items.length >= MAX_GALLERY_PHOTOS
                    ? 0.55
                    : 1,
              }}
            >
              {uploading
                ? "Uploading..."
                : items.length >= MAX_GALLERY_PHOTOS
                  ? "Gallery Full"
                  : "Add Gallery Photo"}

              <input
                type="file"
                accept="image/*"
                disabled={
                  uploading ||
                  items.length >= MAX_GALLERY_PHOTOS
                }
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

            <Link
              href="/account/spot"
              className="btn outline"
            >
              Back to Account
            </Link>
          </div>
        </section>

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
      </div>
    );
  }

  const accept = "image/*,application/pdf";

  return (
    <div>
      <label
        style={{
          display: "inline-block",
          padding: "10px 14px",
          border: "1px solid #d7d1c6",
          borderRadius: "10px",
          cursor: "pointer",
          fontWeight: 700,
          marginBottom: "18px",
        }}
      >
        {uploading ? "Uploading..." : "+ Upload"}

        <input
          type="file"
          accept={accept}
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

      {message && <p>{message}</p>}

      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fill, minmax(160px, 1fr))",
          gap: "14px",
        }}
      >
        {items.map((item) => {
          const { data } = supabase.storage
            .from("spot-media")
            .getPublicUrl(item.storage_path);

          const url = data.publicUrl;
          const isPdf =
            item.storage_path.toLowerCase().endsWith(".pdf");

          return (
            <div
              key={item.id}
              style={{
                border: "1px solid #d7d1c6",
                borderRadius: "12px",
                padding: "10px",
              }}
            >
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  textDecoration: "none",
                  color: "inherit",
                }}
              >
                {isPdf ? (
                  <div
                    style={{
                      minHeight: "130px",
                      display: "grid",
                      placeItems: "center",
                      fontWeight: 700,
                    }}
                  >
                    View PDF
                  </div>
                ) : (
                  <img
                    src={url}
                    alt=""
                    style={{
                      width: "100%",
                      height: "130px",
                      objectFit: "cover",
                      borderRadius: "8px",
                    }}
                  />
                )}
              </a>

              <button
                type="button"
                onClick={() => handleDelete(item)}
                style={{
                  width: "100%",
                  marginTop: "8px",
                  padding: "7px",
                  cursor: "pointer",
                }}
              >
                Delete
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
