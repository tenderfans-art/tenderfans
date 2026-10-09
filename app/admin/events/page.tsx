"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type AdminEvent = {
  id: string;
  venue_id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  status: string;
  venue_approval_status: string;
  admin_approval_status: string;
  flyer_storage_path: string | null;
  venue_name: string;
};

export default function AdminEventsPage() {
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    async function initialize() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        window.location.href = "/login";
        return;
      }

      const { data: admin } = await supabase
        .from("platform_admins")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!admin) {
        window.location.href = "/account";
        return;
      }

      await loadEvents();
      setLoading(false);
    }

    initialize();
  }, []);

  async function loadEvents() {
    const { data, error } = await supabase.rpc("admin_list_events");

    if (error) {
      setMessage(error.message);
      return;
    }

    setEvents((data as AdminEvent[]) || []);
  }

  function eventStatus(event: AdminEvent) {
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

  function formatDateTime(value: string) {
    const date = new Date(value);

    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  const visibleEvents = useMemo(() => {
    const term = search.trim().toLowerCase();

    const filtered = term
      ? events.filter((event) => {
          const title = event.title.toLowerCase();
          const venue = event.venue_name.toLowerCase();

          return title.includes(term) || venue.includes(term);
        })
      : events;

    return filtered.slice(0, 5);
  }, [events, search]);

  async function deleteEvent(event: AdminEvent) {
    const confirmed = window.confirm(
      `Delete "${event.title}" at ${event.venue_name}?\n\nThis will permanently remove the event from TenderFans.`
    );

    if (!confirmed) return;

    setMessage("");

    const { data: flyerPath, error } = await supabase.rpc(
      "admin_delete_event",
      {
        p_event_id: event.id,
      }
    );

    if (error) {
      setMessage(error.message);
      return;
    }

    if (flyerPath) {
      const { error: storageError } = await supabase.storage
        .from("event-flyers")
        .remove([flyerPath]);

      if (storageError) {
        console.error(
          "Event deleted but flyer cleanup failed:",
          storageError
        );

        setMessage(
          "Event deleted, but its flyer file could not be removed."
        );
      }
    }

    setEvents((current) =>
      current.filter((item) => item.id !== event.id)
    );
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

  return (
    <main className="flow-page">
      <div className="shell">
        <section
          className="flow-card"
          style={{ maxWidth: "1200px", margin: "0 auto" }}
        >
          <Link
            href="/admin"
            style={{
              display: "inline-block",
              marginBottom: "22px",
              color: "inherit",
            }}
          >
            ← Admin Dashboard
          </Link>

          <div className="eyebrow">TENDERFANS ADMIN</div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "14px",
              marginBottom: "8px",
            }}
          >
            <h1 style={{ margin: 0 }}>Event Management</h1>

            <Link
              href="/partners/events/new"
              className="button"
              style={{
                textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >
              + Add Event
            </Link>
          </div>

          <p
            className="lead-copy"
            style={{
              marginTop: 0,
              marginBottom: "24px",
            }}
          >
            Search for and manage events across TenderFans.
          </p>

          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by event name or Spot..."
            aria-label="Search events"
            style={{
              width: "100%",
              padding: "10px 12px",
              marginBottom: "20px",
              font: "inherit",
              borderRadius: "10px",
              border: "1px solid rgba(20,35,45,0.18)",
            }}
          />

          {message && (
            <div
              style={{
                marginBottom: "20px",
                padding: "14px 16px",
                border: "1px solid rgba(20,35,45,0.12)",
                borderRadius: "12px",
              }}
            >
              {message}
            </div>
          )}

          <div className="admin-event-list">
            <div className="admin-event-head">
              <span>Event</span>
              <span>Spot</span>
              <span>Date / Time</span>
              <span>Status</span>
              <span style={{ textAlign: "center" }}>Action</span>
            </div>

            {visibleEvents.map((event) => (
              <div className="admin-event-row" key={event.id}>
                <div className="admin-event-title">
                  <a
                    href={`/events?event=${event.id}`}
                    title={event.title}
                  >
                    {event.title}
                  </a>
                </div>

                <div
                  className="admin-event-spot"
                  title={event.venue_name}
                >
                  {event.venue_name}
                </div>

                <div className="admin-event-date">
                  {formatDateTime(event.starts_at)}
                </div>

                <div className="admin-event-status">
                  {eventStatus(event)}
                </div>

                <button
                  type="button"
                  className="admin-event-delete"
                  onClick={() => deleteEvent(event)}
                >
                  Delete
                </button>
              </div>
            ))}

            {visibleEvents.length === 0 && (
              <div className="admin-event-empty">
                No events found.
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
