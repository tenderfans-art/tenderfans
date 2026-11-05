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
  status: string | null;
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
  const [marketKey, setMarketKey] = useState("");
  const [marketName, setMarketName] = useState("");
  const [displayLimit, setDisplayLimit] = useState(100);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    async function initialize() {
      const key = new URLSearchParams(
        window.location.search
      ).get("market") ?? "";

      setMarketKey(key);

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

      await loadEvents(key);
      setLoading(false);
    }

    initialize();
  }, []);

  async function loadEvents(key = marketKey) {
    setMessage("");
    setLoadFailed(false);

    if (key) {
      try {
        const { data: { session } } =
          await supabase.auth.getSession();

        if (!session?.access_token)
          throw new Error("Administrator sign-in required.");

        const response = await fetch(
          `/api/admin/markets/events?market=${encodeURIComponent(key)}`,
          {
            headers: {
              Authorization: `Bearer ${session.access_token}`,
            },
            cache: "no-store",
          }
        );

        const result = await response.json();

        if (!response.ok)
          throw new Error(result.error || "Could not load events.");

        setMarketName(result.market?.display_name ?? "");
        setEvents((result.events ?? []) as AdminEvent[]);
      } catch (error) {
        setEvents([]);
        setLoadFailed(true);
        setMessage(
          error instanceof Error ? error.message : "Load failed."
        );
      }
      return;
    }

    /*
     * Global Events is an Admin approval queue, not a
     * duplicate of the full Market event inventory.
     *
     * Use the existing Admin-only pending-event RPC.
     * Page through every result so the global review
     * queue is not truncated at Supabase's row limit.
     */
    const pending: AdminEvent[] = [];

    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase
        .rpc("admin_pending_events")
        .range(offset, offset + 999);

      if (error) {
        setEvents([]);
        setMessage(error.message);
        setLoadFailed(true);
        return;
      }

      const rows = (data ?? []) as AdminEvent[];

      pending.push(
        ...rows.map(row => ({
          ...row,
          status: null,
          flyer_storage_path: null,
        }))
      );

      if (rows.length < 1000) break;
    }

    setEvents(pending);
  }

  function eventStatus(event: AdminEvent) {
    // Cancelled is not a pending review.
    if (event.status === "cancelled") {
      return "CANCELLED";
    }

    if (
      event.venue_approval_status === "denied" ||
      event.admin_approval_status === "denied"
    ) {
      return "DENIED";
    }

    if (event.admin_approval_status === "pending") {
      return "IN REVIEW";
    }

    if (
      event.status === "published" &&
      event.venue_approval_status === "approved" &&
      event.admin_approval_status === "approved"
    ) {
      return "APPROVED";
    }

    return event.status?.toUpperCase() ?? "UNKNOWN";
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

    return filtered.slice(0, displayLimit);
  }, [events, search, displayLimit]);

  const matchingCount = events.filter(event => {
    const term = search.trim().toLowerCase();
    return !term ||
      event.title.toLowerCase().includes(term) ||
      event.venue_name.toLowerCase().includes(term);
  }).length;

  async function deleteEvent(event: AdminEvent) {
    const confirmed = window.confirm(
      `Delete "${event.title}" at ${event.venue_name}?\n\nThis will permanently remove the event from TenderFans.`
    );

    if (!confirmed) return;

    setMessage("");

    let flyerPath: string | null = null;

    if (marketKey) {
      try {
        const { data: { session } } =
          await supabase.auth.getSession();

        if (!session?.access_token)
          throw new Error("Administrator sign-in required.");

        const response = await fetch(
          `/api/admin/markets/events?market=${encodeURIComponent(marketKey)}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              action: "delete",
              eventId: event.id,
            }),
          }
        );

        const result = await response.json();

        if (!response.ok)
          throw new Error(result.error || "Deletion failed.");

        flyerPath = result.flyerPath ?? null;
      } catch (error) {
        setMessage(
          error instanceof Error ? error.message : "Deletion failed."
        );
        return;
      }
    } else {
      const { data, error } = await supabase.rpc(
        "admin_delete_event",
        { p_event_id: event.id }
      );

      if (error) {
        setMessage(error.message);
        return;
      }

      flyerPath = data;
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
            href={marketKey
              ? `/admin/markets/${encodeURIComponent(marketKey)}`
              : "/admin"}
            style={{
              display: "inline-block",
              marginBottom: "22px",
              color: "inherit",
            }}
          >
            {marketKey
              ? `← ${marketName || "Market"} Dashboard`
              : "← Admin Dashboard"}
          </Link>

          <div className="eyebrow">
            {marketKey ? "TENDERFANS MARKET" : "TENDERFANS ADMIN"}
          </div>

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
            <h1 style={{ margin: 0 }}>
              {marketKey && marketName
                ? `${marketName} Event Management`
                : "Global Event Review"}
            </h1>

            {!marketKey && (
              <Link
                href="/admin/claims"
                className="button"
                style={{
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                }}
              >
                Review Requests
              </Link>
            )}
          </div>

          <p
            className="lead-copy"
            style={{
              marginTop: 0,
              marginBottom: "24px",
            }}
          >
            {marketKey
              ? "Search events belonging to publishing Spots in this Market. Event submissions remain available through the authorized Spot and Partner portals."
              : "Events awaiting Admin approval across all Markets. Harvester Event Review remains under each Market's Harvester Management."}
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
                    href={marketKey
                      ? `/events?event=${event.id}`
                      : "/admin/claims"}
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

                {marketKey ? (
                  <button
                    type="button"
                    className="admin-event-delete"
                    onClick={() => deleteEvent(event)}
                  >
                    Delete
                  </button>
                ) : (
                  <Link
                    href="/admin/claims"
                    className="btn outline"
                  >
                    Review
                  </Link>
                )}
              </div>
            ))}

            {!loadFailed && visibleEvents.length === 0 && (
              <div className="admin-event-empty">
                No events found.
              </div>
            )}
          </div>

          {visibleEvents.length < matchingCount && (
            <button
              type="button"
              className="btn outline"
              style={{ marginTop: 20 }}
              onClick={() => setDisplayLimit(value => value + 100)}
            >
              Show more events
              ({matchingCount - visibleEvents.length} remaining)
            </button>
          )}
        </section>
      </div>
    </main>
  );
}
