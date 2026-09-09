"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase";

type SpotEvent = {
  id: string;
  venue_id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  status: string;
  venue_approval_status: "pending" | "approved" | "denied";
  admin_approval_status: "pending" | "approved" | "denied";
  flyer_url: string | null;
  flyer_storage_path: string | null;
};

type Venue = {
  id: string;
  name: string;
};

export default function SpotEventsPage() {
  const params = useParams<{ venueId: string }>();
  const venueId = params.venueId;

  const [loading, setLoading] = useState(true);
  const [venue, setVenue] = useState<Venue | null>(null);
  const [events, setEvents] = useState<SpotEvent[]>([]);
  const [selectedEvent, setSelectedEvent] =
    useState<SpotEvent | null>(null);
  const [message, setMessage] = useState("");

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
          .from("venue_permissions")
          .select("venue_id")
          .eq("user_id", user.id)
          .eq("venue_id", venueId)
          .maybeSingle();

      if (permissionError || !permission) {
        setMessage(
          "You do not have permission to manage events for this Spot."
        );
        setLoading(false);
        return;
      }

      const [venueResult, eventsResult] = await Promise.all([
        supabase
          .from("venues")
          .select("id, name")
          .eq("id", venueId)
          .maybeSingle(),

        supabase
          .from("events")
          .select(`
            id,
            venue_id,
            title,
            starts_at,
            ends_at,
            status,
            venue_approval_status,
            admin_approval_status,
            flyer_url,
            flyer_storage_path
          `)
          .eq("venue_id", venueId)
          .order("starts_at", { ascending: false }),
      ]);

      if (venueResult.error || !venueResult.data) {
        setMessage(
          venueResult.error?.message ||
            "Could not load this Spot."
        );
        setLoading(false);
        return;
      }

      if (eventsResult.error) {
        setMessage(eventsResult.error.message);
        setLoading(false);
        return;
      }

      setVenue(venueResult.data as Venue);
      setEvents((eventsResult.data as SpotEvent[]) || []);
      setLoading(false);
    }

    loadPage();
  }, [venueId]);

  function eventStatus(event: SpotEvent) {
    if (
      event.venue_approval_status === "denied" ||
      event.admin_approval_status === "denied"
    ) {
      return "DENIED";
    }

    if (
      event.status === "published" &&
      event.venue_approval_status === "approved" &&
      event.admin_approval_status === "approved"
    ) {
      return "APPROVED";
    }

    return "PENDING";
  }

  function formatDateTime(event: SpotEvent) {
    const start = new Date(event.starts_at);
    const end = event.ends_at
      ? new Date(event.ends_at)
      : null;

    const date = start
      .toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
      .toUpperCase();

    const startTime = start.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });

    if (!end) {
      return `${date} · ${startTime}`;
    }

    const endTime = end.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });

    const crossesDay =
      start.toDateString() !== end.toDateString();

    return crossesDay
      ? `${date} · ${startTime}–${endTime} NEXT DAY`
      : `${date} · ${startTime}–${endTime}`;
  }

  if (loading) {
    return (
      <main className="flow-page">
        <div className="shell">
          <section className="flow-card">
            <p>Loading events...</p>
          </section>
        </div>
      </main>
    );
  }

  if (!venue) {
    return (
      <main className="flow-page">
        <div className="shell narrow">
          <section className="flow-card">
            <p>{message || "Spot could not be loaded."}</p>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="flow-page">
      <div className="shell">
        <section
          className="flow-card"
          style={{ maxWidth: "1200px", margin: "0 auto" }}
        >
          <div className="eyebrow">SPOT OWNER PORTAL</div>

          <h1>Manage Events</h1>

          <p className="lead-copy">
            {venue.name}
          </p>

          <div
            className="partner-dashboard-tabs"
            style={{ marginBottom: "24px" }}
          >
            <Link
              className="landing-action"
              href={`/account/spot/${venueId}/events/new`}
            >
              Submit Event
            </Link>

            <Link href="/account/spot">
              Back to Spot Dashboard
            </Link>
          </div>

          <div className="partner-events-section">
            <div className="partner-events-heading">
              <div>
                <div className="eyebrow">SPOT EVENTS</div>
                <h2>Submitted Events</h2>
              </div>

              <span className="partner-event-count">
                {events.length}
              </span>
            </div>

            {events.length === 0 ? (
              <div className="privacy-note">
                No events have been submitted for this Spot yet.
              </div>
            ) : (
              <div className="partner-event-list">
                {events.map((event) => {
                  const status = eventStatus(event);

                  return (
                    <div
                      className="partner-event-row"
                      key={event.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "225px minmax(260px, 1fr) 110px 110px",
                        alignItems: "center",
                        gap: "16px",
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedEvent(event)}
                        style={{
                          display: "contents",
                          color: "inherit",
                        }}
                      >
                        <div
                          className="partner-event-when"
                          style={{
                            whiteSpace: "nowrap",
                            minWidth: 0,
                          }}
                        >
                          {formatDateTime(event)}
                        </div>

                        <div
                          className="partner-event-main"
                          style={{
                            minWidth: 0,
                            overflow: "hidden",
                          }}
                        >
                          <strong>{event.title}</strong>
                          <span>{venue.name}</span>
                        </div>

                        <div
                          className={`partner-event-status partner-event-status-${status.toLowerCase()}`}
                        >
                          {status}
                        </div>
                      </button>

                      <div className="partner-event-actions">
                        <button
                          type="button"
                          onClick={() => setSelectedEvent(event)}
                        >
                          View
                        </button>

                        <Link
                          href={`/account/spot/${venueId}/events/${event.id}/edit`}
                        >
                          Edit
                        </Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {message && (
            <div
              className="privacy-note"
              style={{ marginTop: "16px" }}
            >
              {message}
            </div>
          )}
        </section>
      </div>

      {selectedEvent && (
        <div
          role="presentation"
          onClick={() => setSelectedEvent(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 100,
            background: "rgba(5, 16, 24, .72)",
            display: "grid",
            placeItems: "center",
            padding: "20px",
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(560px, 100%)",
              maxHeight: "90vh",
              overflowY: "auto",
              background: "#fffdf8",
              borderRadius: "20px",
              padding: "24px",
              boxShadow: "0 24px 70px rgba(0,0,0,.3)",
              textAlign: "center",
            }}
          >
            <div className="eyebrow">
              {eventStatus(selectedEvent)}
            </div>

            <h2 style={{ marginBottom: "8px" }}>
              {selectedEvent.title}
            </h2>

            <p
              className="lead-copy"
              style={{ marginTop: 0 }}
            >
              {venue.name}
              <br />
              {formatDateTime(selectedEvent)}
            </p>

            {selectedEvent.flyer_url ? (
              <div
                style={{
                  margin: "18px auto",
                  borderRadius: "14px",
                  overflow: "hidden",
                  background: "#f3f1e8",
                }}
              >
                <img
                  src={selectedEvent.flyer_url}
                  alt={`${selectedEvent.title} flyer`}
                  style={{
                    display: "block",
                    width: "100%",
                    maxHeight: "520px",
                    objectFit: "contain",
                  }}
                />
              </div>
            ) : (
              <div className="privacy-note">
                No flyer is available for this event.
              </div>
            )}

            <div
              style={{
                display: "grid",
                gap: "10px",
                marginTop: "18px",
              }}
            >
              <Link
                className="landing-action"
                href={`/account/spot/${venueId}/events/${selectedEvent.id}/edit`}
              >
                Edit Event
              </Link>

              <button
                type="button"
                onClick={() => setSelectedEvent(null)}
                className="landing-action secondary"
              >
                Close
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
