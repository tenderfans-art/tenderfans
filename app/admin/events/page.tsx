"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type AdminEvent = {
  id: string;
  venue_id: string;
  title: string;
  starts_at: string | null;
  ends_at: string | null;
  status: string | null;
  venue_approval_status: string;
  admin_approval_status: string;
  flyer_storage_path: string | null;
  venue_name: string;
  reviewType?: string;
  reviewHref?: string;
};

type HarvesterReviewRow = {
  id: string;
  event_title?: string | null;
  raw_title?: string | null;
  publisher_venue_name?: string | null;
  venue_name?: string | null;
  venue_id?: string | null;
  starts_at: string | null;
  ends_at?: string | null;
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
     * Cross-Market oversight combines the same actionable queues
     * already used by Verification Requests and HM Event Review.
     *
     * All reads use the existing Admin-authorized RPCs.
     * No review decisions or publishing operations occur here.
     */
    const harvesterQueues = [
      {
        name: "admin_pending_event_harvest_unresolved_venues",
        label: "Publisher Match",
      },
      {
        name: "admin_list_calendar_event_verifications",
        label: "Calendar Verification",
      },
      {
        name: "admin_list_event_occurrence_reviews",
        label: "Occurrence Review",
      },
    ] as const;

    async function readQueue(name: string) {
      const rows: HarvesterReviewRow[] = [];

      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await supabase
          .rpc(name as never, {} as never)
          .range(offset, offset + 999);

        if (error) {
          throw new Error(`${name}: ${error.message}`);
        }

        const page = (data ?? []) as unknown as HarvesterReviewRow[];
        rows.push(...page);

        if (page.length < 1000) break;
      }

      return rows;
    }

    function stillNeedsReview(
      startsAt: string | null,
      endsAt?: string | null
    ) {
      if (!startsAt) return true;

      const start = Date.parse(startsAt);
      if (!Number.isFinite(start)) return true;

      const end = endsAt ? Date.parse(endsAt) : NaN;
      const completion =
        Number.isFinite(end) && end > start ? end : start;

      return completion >= Date.now();
    }

    try {
      const [approvals, ...harvested] = await Promise.all([
        readQueue("admin_pending_events"),
        ...harvesterQueues.map(queue => readQueue(queue.name)),
      ]);

      const combined: AdminEvent[] = approvals.map(row => ({
        id: row.id,
        title: row.event_title ?? (row as HarvesterReviewRow & {
          title?: string;
        }).title ?? "Untitled event",
        venue_id: row.venue_id ?? "",
        venue_name: row.venue_name ?? "Unknown Spot",
        starts_at: row.starts_at,
        ends_at: row.ends_at ?? null,
        status: null,
        venue_approval_status: "pending",
        admin_approval_status: "pending",
        flyer_storage_path: null,
        reviewType: "Admin Approval",
        reviewHref: "/admin/claims",
      }));

      harvesterQueues.forEach((queue, index) => {
        for (const row of harvested[index]) {
          if (!stillNeedsReview(row.starts_at, row.ends_at)) {
            continue;
          }

          combined.push({
            id: row.id,
            title:
              row.event_title ??
              row.raw_title ??
              "Untitled harvested event",
            venue_id: row.venue_id ?? "",
            venue_name:
              row.publisher_venue_name ??
              row.venue_name ??
              "Publisher awaiting identification",
            starts_at: row.starts_at,
            ends_at: row.ends_at ?? null,
            status: "needs_review",
            venue_approval_status: "pending",
            admin_approval_status: "pending",
            flyer_storage_path: null,
            reviewType: queue.label,
            reviewHref: "/admin/venue-matches",
          });
        }
      });

      combined.sort((a, b) => {
        const aDate = a.starts_at
          ? Date.parse(a.starts_at) : NaN;
        const bDate = b.starts_at
          ? Date.parse(b.starts_at) : NaN;

        return (
          (Number.isFinite(aDate) ? aDate : Infinity) -
          (Number.isFinite(bDate) ? bDate : Infinity)
        );
      });

      setEvents(combined);
    } catch (cause) {
      setEvents([]);
      setLoadFailed(true);
      setMessage(
        cause instanceof Error
          ? cause.message
          : "Could not load global event reviews."
      );
    }
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

  function formatDateTime(value: string | null) {
    if (!value) return "Date to be verified";

    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
      return "Date to be verified";
    }

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
              : "Outstanding Admin approvals and Harvester Event Reviews across all Markets. Review decisions remain available through the established review workflows."}
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

          {!marketKey && !loadFailed && (
            <p role="status" style={{ marginBottom: 16 }}>
              <strong>{events.length}</strong>{" "}
              outstanding event review
              {events.length === 1 ? "" : "s"} across all Markets
            </p>
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
              <div
                className="admin-event-row"
                key={`${event.reviewType ?? "market"}:${event.id}`}
              >
                <div className="admin-event-title">
                  <a
                    href={marketKey
                      ? `/events?event=${event.id}`
                      : event.reviewHref ?? "/admin/claims"}
                    title={event.title}
                  >
                    {event.title}
                  </a>
                  {!marketKey && event.reviewType && (
                    <div style={{
                      fontSize: 11,
                      opacity: 0.7,
                      marginTop: 4,
                    }}>
                      {event.reviewType}
                    </div>
                  )}
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
                    href={event.reviewHref ?? "/admin/claims"}
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
