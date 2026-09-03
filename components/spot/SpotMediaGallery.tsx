"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type MediaType = "menu" | "special" | "photo";

type MediaAsset = {
  id: string;
  storage_path: string;
  media_type: MediaType;
  created_at: string;
};

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

    setUploading(true);

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");
    const path = `${venueId}/${mediaType}/${crypto.randomUUID()}-${safeName}`;

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

    const { error: insertError } = await supabase
      .from("media_assets")
      .insert({
        entity_kind: "venue",
        venue_id: venueId,
        bartender_id: null,
        uploaded_by_user_id: user.id,
        storage_path: path,
        media_type: mediaType,
        status: "published",
      });

    if (insertError) {
      await supabase.storage.from("spot-media").remove([path]);
      setMessage(insertError.message);
      setUploading(false);
      return;
    }

    setUploading(false);
    await loadItems();
  }

  async function handleDelete(item: MediaAsset) {
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
  }

  const accept =
    mediaType === "photo"
      ? "image/*"
      : "image/*,application/pdf";

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
            if (file) handleUpload(file);
            e.currentTarget.value = "";
          }}
        />
      </label>

      {message && <p>{message}</p>}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
          gap: "14px",
        }}
      >
        {items.map((item) => {
          const { data } = supabase.storage
            .from("spot-media")
            .getPublicUrl(item.storage_path);

          const url = data.publicUrl;
          const isPdf = item.storage_path.toLowerCase().endsWith(".pdf");

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
                style={{ textDecoration: "none", color: "inherit" }}
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
