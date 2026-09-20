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
      <main style={{ padding: "40px 24px" }}>
        <p>Loading events...</p>
      </main>
    );
  }

  return (
    <main
      style={{
        maxWidth: "1100px",
        margin: "0 auto",
        padding: "42px 24px 70px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "20px",
          marginBottom: "26px",
        }}
      >
        <div>
          <div
            style={{
              fontSize: "0.76rem",
              fontWeight: 800,
              letterSpacing: "0.12em",
              opacity: 0.55,
              marginBottom: "5px",
            }}
          >
            TENDERFANS ADMIN
          </div>

          <h1 style={{ margin: 0 }}>Manage Events</h1>
        </div>

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

      <input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search by event name or Spot..."
        style={{
          width: "100%",
          padding: "13px 15px",
          borderRadius: "10px",
          border: "1px solid rgba(255,255,255,0.14)",
          background: "rgba(255,255,255,0.04)",
          color: "inherit",
          font: "inherit",
          marginBottom: "24px",
        }}
      />

      {message && (
        <p style={{ margin: "0 0 18px", opacity: 0.8 }}>
          {message}
        </p>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "minmax(240px, 1.6fr) minmax(190px, 1.25fr) 190px 110px 100px",
          gap: "18px",
          padding: "0 12px 10px",
          fontSize: "0.72rem",
          fontWeight: 800,
          letterSpacing: "0.08em",
          opacity: 0.5,
        }}
      >
        <div>EVENT</div>
        <div>SPOT</div>
        <div>DATE / TIME</div>
        <div>STATUS</div>
        <div />
      </div>

      <div
        style={{
          borderTop: "1px solid rgba(255,255,255,0.12)",
        }}
      >
        {visibleEvents.map((event) => (
          <div
            key={event.id}
            style={{
              display: "grid",
              gridTemplateColumns:
                "minmax(240px, 1.6fr) minmax(190px, 1.25fr) 190px 110px 100px",
              gap: "18px",
              alignItems: "center",
              padding: "15px 12px",
              borderBottom:
                "1px solid rgba(255,255,255,0.12)",
            }}
          >
            <div
              style={{
                minWidth: 0,
                fontWeight: 800,
                lineHeight: 1.25,
              }}
            >
              <a
                href={`/events?event=${event.id}`}
                style={{
                  color: "inherit",
                  textDecoration: "none",
                }}
              >
                {event.title}
              </a>
            </div>

            <div
              style={{
                minWidth: 0,
                fontSize: "0.88rem",
              }}
            >
              {event.venue_name}
            </div>

            <div
              style={{
                fontSize: "0.82rem",
                opacity: 0.72,
                whiteSpace: "nowrap",
              }}
            >
              {formatDateTime(event.starts_at)}
            </div>

            <div
              style={{
                fontSize: "0.76rem",
                fontWeight: 800,
              }}
            >
              {eventStatus(event)}
            </div>

            <button
              type="button"
              onClick={() => deleteEvent(event)}
              style={{
                justifySelf: "end",
                padding: "7px 12px",
                borderRadius: "7px",
                border: "1px solid rgba(255,255,255,0.18)",
                background: "transparent",
                color: "inherit",
                cursor: "pointer",
                fontWeight: 700,
              }}
            >
              Delete
            </button>
          </div>
        ))}

        {visibleEvents.length === 0 && (
          <div
            style={{
              padding: "28px 12px",
              opacity: 0.65,
            }}
          >
            No events found.
          </div>
        )}
      </div>

      <div style={{ marginTop: "30px" }}>
        <Link href="/admin">
          ← Back to Admin Dashboard
        </Link>
      </div>
    </main>
  );
}
