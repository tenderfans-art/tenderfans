"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type PartnerEvent = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  status: string;
  venue_approval_status: "pending" | "approved" | "denied";
  admin_approval_status: "pending" | "approved" | "denied";
  venues:
    | {
        name: string;
      }
    | {
        name: string;
      }[]
    | null;
};

export default function PartnerAccountPage() {
  const [loading, setLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [displayName, setDisplayName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [events, setEvents] = useState<PartnerEvent[]>([]);
  const [message, setMessage] = useState("");

  async function loadEvents(userId: string) {
    setEventsLoading(true);

    const { data, error } = await supabase
      .from("events")
      .select(`
        id,
        title,
        starts_at,
        ends_at,
        status,
        venue_approval_status,
        admin_approval_status,
        venues (
          name
        )
      `)
      .eq("submitted_by", userId)
      .order("starts_at", { ascending: false });

    if (error) {
      setMessage(error.message);
      setEvents([]);
    } else {
      setEvents((data as PartnerEvent[]) || []);
    }

    setEventsLoading(false);
  }

  useEffect(() => {
    async function loadPartner() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        window.location.href = "/partners/login";
        return;
      }

      const { data, error } = await supabase
        .from("partner_profiles")
        .select("display_name, company_name, status")
        .eq("user_id", user.id)
        .maybeSingle();

      if (error || !data) {
        window.location.href = "/partners/apply";
        return;
      }

      if (data.status !== "approved") {
        window.location.href = "/partners/apply";
        return;
      }

      setDisplayName(data.display_name || "");
      setCompanyName(data.company_name || "");

      await loadEvents(user.id);
      setLoading(false);
    }

    loadPartner();
  }, []);

  function eventStatus(event: PartnerEvent) {
    if (
      event.venue_approval_status === "denied" ||
      event.admin_approval_status === "denied"
    ) {
      return "DENIED";
    }

    if (
      event.venue_approval_status === "approved" &&
      event.admin_approval_status === "approved"
    ) {
      return "APPROVED";
    }

    return "PENDING";
  }

  function formatDateTime(event: PartnerEvent) {
    const start = new Date(event.starts_at);
    const end = event.ends_at ? new Date(event.ends_at) : null;

    const date = start
      .toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
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

    return `${date} · ${startTime}–${endTime}`;
  }

  async function deleteEvent(event: PartnerEvent) {
    if (eventStatus(event) !== "APPROVED") return;

    const confirmed = window.confirm(
      `Delete "${event.title}"? This will remove it from TenderFans.`
    );

    if (!confirmed) return;

    setMessage("");

    const { data: flyerPath, error } = await supabase.rpc(
      "partner_delete_approved_event",
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

    if (!flyerPath) {
      setMessage("Event deleted.");
    } else {
      setMessage("Event and flyer deleted.");
    }
  }

  async function deletePartnerAccess() {
    const confirmed = window.confirm(
      "Delete your Partner access? You will need to reapply if you want Partner access again."
    );

    if (!confirmed) return;

    setMessage("Deleting Partner access...");

    const { error } = await supabase.rpc(
      "delete_my_partner_access"
    );

    if (error) {
      setMessage(error.message);
      return;
    }

    window.location.href = "/account";
  }

  if (loading) {
    return (
      <main className="flow-page">
        <div className="shell">
          <div className="flow-card">
            <p>Loading Partner portal...</p>
          </div>
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
          <div className="eyebrow">PARTNER PORTAL</div>
          <h1>Partner Dashboard</h1>

          <p className="lead-copy">
            {displayName}
            {companyName ? ` · ${companyName}` : ""}
          </p>

          <div className="partner-dashboard-tabs">
            <Link
              className="landing-action"
              href="/partners/events/new"
            >
              Submit Event
            </Link>

            <span className="partner-dashboard-tab-active">
              My Events
            </span>
          </div>

          <div className="partner-events-section">
            <div className="partner-events-heading">
              <div>
                <div className="eyebrow">MY EVENTS</div>
                <h2>Submitted Events</h2>
              </div>

              <span className="partner-event-count">
                {events.length}
              </span>
            </div>

            {eventsLoading ? (
              <p>Loading events...</p>
            ) : events.length === 0 ? (
              <div className="privacy-note">
                You haven't submitted any events yet.
              </div>
            ) : (
              <div className="partner-event-list">
                {events.map((event) => {
                  const status = eventStatus(event);
                  const approved = status === "APPROVED";

                  return (
                    <div
                      className="partner-event-row"
                      key={event.id}
                    >
                      <div className="partner-event-when">
                        {formatDateTime(event)}
                      </div>

                      <div className="partner-event-main">
                        <strong>{event.title}</strong>
                        <span>
                          {(Array.isArray(event.venues)
  ? event.venues[0]?.name
  : event.venues?.name) || "Unknown Spot"}
                        </span>
                      </div>

                      <div
                        className={`partner-event-status partner-event-status-${status.toLowerCase()}`}
                      >
                        {status}
                      </div>

                      <div className="partner-event-actions">
                        {approved ? (
                          <>
                            <Link
                              href={`/partners/events/${event.id}/edit`}
                            >
                              Edit
                            </Link>

                            <button
                              type="button"
                              onClick={() => deleteEvent(event)}
                            >
                              Delete
                            </button>
                          </>
                        ) : (
                          <span className="partner-event-awaiting">
                            Awaiting review
                          </span>
                        )}
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

          <div className="partner-access-footer">
            <button
              type="button"
              onClick={deletePartnerAccess}
            >
              Delete Partner Access
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
