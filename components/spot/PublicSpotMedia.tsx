"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import SpotTenderList from "@/components/SpotTenderList";
import EventsCalendar from "@/components/EventsCalendar";

type MediaType = "menu" | "special" | "photo";

type Tender = {
  id: string;
  slug: string;
  display_name: string;
  bio: string | null;
};

type ActiveSection = MediaType | "events" | "tenders";

type MediaAsset = {
  id: string;
  storage_path: string;
  media_type: MediaType;
};

export default function PublicSpotMedia({
  venueId,
  venueName,
  tenders,
}: {
  venueId: string;
  venueName: string;
  tenders: Tender[];
}) {
  const [active, setActive] = useState<ActiveSection | null>(null);
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

  function openSection(section: "events" | "tenders") {
    setItems([]);
    setLoading(false);
    setActive((current) =>
      current === section ? null : section
    );
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

        <button
          type="button"
          onClick={() => openSection("events")}
          style={buttonStyle}
        >
          Events
        </button>

        <button
          type="button"
          onClick={() => openSection("tenders")}
          style={buttonStyle}
        >
          Tenders
        </button>
      </div>

      {active && (
        <div style={{ marginTop: "18px" }}>
          {active === "tenders" ? (
            <>
              <div
                className="section-title spot-tender-heading"
                style={{ marginBottom: "12px" }}
              >
                <div>
                  <span className="eyebrow">Behind the bar</span>
                </div>
              </div>

              <SpotTenderList tenders={tenders} />
            </>
          ) : active === "events" ? (
            <>
              <div
                className="section-title"
                style={{
                  marginBottom: "18px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div>
                  <span className="eyebrow">Upcoming Events</span>
                </div>

                <Link
                  href={`/s/${venueId}/events`}
                  className="button secondary-button"
                >
                  View All Events
                </Link>
              </div>

              <EventsCalendar
                venueId={venueId}
                upcomingOnly
                limit={5}
              />
            </>
          ) : (
            <>
              <div
                className="section-title"
                style={{ marginBottom: "18px" }}
              >
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
            </>
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
