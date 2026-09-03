"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type MediaType = "menu" | "special" | "photo";

type MediaAsset = {
  id: string;
  storage_path: string;
  media_type: MediaType;
};

export default function PublicSpotMedia({
  venueId,
}: {
  venueId: string;
}) {
  const [active, setActive] = useState<MediaType | null>(null);
  const [items, setItems] = useState<MediaAsset[]>([]);
  const [loading, setLoading] = useState(false);

  async function openGallery(type: MediaType) {
    if (active === type) {
      setActive(null);
      setItems([]);
      return;
    }

    setActive(type);
    setLoading(true);

    const { data, error } = await supabase
      .from("media_assets")
      .select("id, storage_path, media_type")
      .eq("entity_kind", "venue")
      .eq("venue_id", venueId)
      .eq("media_type", type)
      .eq("status", "published")
      .order("sort_order", { ascending: true });

    setLoading(false);

    if (error) {
      setItems([]);
      return;
    }

    setItems((data ?? []) as MediaAsset[]);
  }

  return (
    <section className="full spot-media-section">
      <div className="future-strip spot-media-strip">
        <span>Explore:</span>

        <button
          type="button"
          onClick={() => openGallery("menu")}
          style={buttonStyle}
        >
          Menus
        </button>

        <button
          type="button"
          onClick={() => openGallery("special")}
          style={buttonStyle}
        >
          Specials
        </button>

        <button
          type="button"
          onClick={() => openGallery("photo")}
          style={buttonStyle}
        >
          Photos
        </button>

        <Link href={`/s/${venueId}/awards`} style={buttonStyle}>
          Awards
        </Link>

        <Link href={`/s/${venueId}/events`} style={buttonStyle}>
          Events
        </Link>
      </div>

      {active && (
        <div style={{ marginTop: "18px" }}>
          <div className="section-title" style={{ marginBottom: "18px" }}>
            <div>
              <span className="eyebrow">
                {active === "menu"
                  ? "Menus"
                  : active === "special"
                  ? "Specials"
                  : "Photos"}
              </span>
            </div>
          </div>

          {loading ? (
            <p className="muted">Loading...</p>
          ) : items.length === 0 ? (
            <div className="gallery-empty">
              Nothing has been added here yet.
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "repeat(auto-fill, minmax(180px, 1fr))",
                gap: "14px",
              }}
            >
              {items.map((item) => {
                const { data } = supabase.storage
                  .from("spot-media")
                  .getPublicUrl(item.storage_path);

                const url = data.publicUrl;
                const isPdf = item.storage_path
                  .toLowerCase()
                  .endsWith(".pdf");

                return (
                  <a
                    key={item.id}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: "block",
                      border: "1px solid #d7d1c6",
                      borderRadius: "12px",
                      overflow: "hidden",
                      background: "#fff",
                    }}
                  >
                    {isPdf ? (
                      <div
                        style={{
                          minHeight: "160px",
                          display: "grid",
                          placeItems: "center",
                          fontWeight: 800,
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
                          height: "180px",
                          objectFit: "cover",
                          display: "block",
                        }}
                      />
                    )}
                  </a>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const buttonStyle = {
  border: 0,
  background: "rgba(255,255,255,.1)",
  color: "#fff",
  padding: "5px 9px",
  borderRadius: "999px",
  fontSize: "12px",
  fontWeight: 700,
  cursor: "pointer",
};
