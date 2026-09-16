"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import NotificationSignup from "@/components/NotificationSignup";

type CalendarEvent = {
  id: string;
  venue_id: string;
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string | null;
  flyer_url: string | null;
  venue_name: string;
  venue_slug: string | null;
};

type CalendarWeek = {
  start: Date;
  end: Date;
};

function startOfWeek(date: Date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  result.setDate(result.getDate() - result.getDay());
  return result;
}

function endOfWeek(date: Date) {
  const result = startOfWeek(date);
  result.setDate(result.getDate() + 6);
  result.setHours(23, 59, 59, 999);
  return result;
}

function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function sameWeek(a: CalendarWeek, b: CalendarWeek) {
  return sameDay(a.start, b.start) && sameDay(a.end, b.end);
}

function weekLabel(week: CalendarWeek) {
  const startMonth = week.start.toLocaleDateString("en-US", {
    month: "short",
  });
  const endMonth = week.end.toLocaleDateString("en-US", {
    month: "short",
  });

  if (week.start.getMonth() === week.end.getMonth()) {
    return `${startMonth} ${week.start.getDate()}–${week.end.getDate()}`;
  }

  return `${startMonth} ${week.start.getDate()}–${endMonth} ${week.end.getDate()}`;
}

export default function EventsCalendar() {
  const [today, setToday] = useState<Date | null>(null);
  const [month, setMonth] = useState<Date | null>(null);
  const [selectedWeekStart, setSelectedWeekStart] = useState<Date | null>(null);

  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [selectedFlyer, setSelectedFlyer] = useState<CalendarEvent | null>(null);

  useEffect(() => {
    const now = new Date();

    setToday(now);
    setMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setSelectedWeekStart(startOfWeek(now));
  }, []);

  const calendarWeeks = useMemo<CalendarWeek[]>(() => {
    if (!month) return [];

    const year = month.getFullYear();
    const monthIndex = month.getMonth();

    const firstOfMonth = new Date(year, monthIndex, 1);
    const lastOfMonth = new Date(year, monthIndex + 1, 0);

    const firstWeekStart = startOfWeek(firstOfMonth);
    const lastWeekEnd = endOfWeek(lastOfMonth);

    const weeks: CalendarWeek[] = [];
    const cursor = new Date(firstWeekStart);

    while (cursor <= lastWeekEnd) {
      const start = new Date(cursor);
      const end = endOfWeek(start);

      weeks.push({ start, end });
      cursor.setDate(cursor.getDate() + 7);
    }

    return weeks;
  }, [month]);

  useEffect(() => {
    async function loadEvents() {
      if (!calendarWeeks.length) return;

      setLoading(true);

      const rangeStart = new Date(calendarWeeks[0].start);
      const rangeEnd = new Date(calendarWeeks[calendarWeeks.length - 1].end);

      const { data, error } = await supabase
        .from("events")
        .select(`
          id,
          venue_id,
          title,
          description,
          starts_at,
          ends_at,
          flyer_url,
          venues (
            name,
            slug
          )
        `)
        .eq("status", "published")
        .gte("starts_at", rangeStart.toISOString())
        .lte("starts_at", rangeEnd.toISOString())
        .order("starts_at", { ascending: true });

      if (error) {
        console.error("Unable to load events:", error);
        setEvents([]);
        setLoading(false);
        return;
      }

      const normalized: CalendarEvent[] = (data ?? []).map((event: any) => ({
        id: event.id,
        venue_id: event.venue_id,
        title: event.title,
        description: event.description,
        starts_at: event.starts_at,
        ends_at: event.ends_at,
        flyer_url: event.flyer_url ?? null,
        venue_name: event.venues?.name ?? "TenderFans Spot",
        venue_slug: event.venues?.slug ?? null,
      }));

      setEvents(normalized);
      setLoading(false);
    }

    loadEvents();
  }, [calendarWeeks]);

  const selectedWeek = useMemo<CalendarWeek | null>(() => {
    if (!calendarWeeks.length) return null;

    if (selectedWeekStart) {
      const match = calendarWeeks.find((week) =>
        sameDay(week.start, selectedWeekStart)
      );

      if (match) return match;
    }

    return calendarWeeks[0];
  }, [calendarWeeks, selectedWeekStart]);

  const selectedWeekEvents = useMemo(() => {
    if (!selectedWeek) return [];

    return events.filter((event) => {
      const eventDate = new Date(event.starts_at);
      return eventDate >= selectedWeek.start && eventDate <= selectedWeek.end;
    });
  }, [events, selectedWeek]);

  function selectMonth(nextMonth: Date) {
    setMonth(nextMonth);

    const firstOfMonth = new Date(
      nextMonth.getFullYear(),
      nextMonth.getMonth(),
      1
    );

    setSelectedWeekStart(startOfWeek(firstOfMonth));
  }

  function previousMonth() {
    if (!month) return;

    selectMonth(
      new Date(month.getFullYear(), month.getMonth() - 1, 1)
    );
  }

  function nextMonth() {
    if (!month) return;

    selectMonth(
      new Date(month.getFullYear(), month.getMonth() + 1, 1)
    );
  }

  function goToday() {
    if (!today) return;

    setMonth(new Date(today.getFullYear(), today.getMonth(), 1));
    setSelectedWeekStart(startOfWeek(today));
  }

  function eventTime(startsAt: string) {
    return new Date(startsAt).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function eventDate(startsAt: string) {
    return new Date(startsAt).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }

  const monthLabel = month
    ? month.toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
      })
    : "";

  return (
    <section className="events-calendar-card">
      <div className="events-calendar-toolbar">
        <button
          type="button"
          className="events-nav-button"
          onClick={previousMonth}
          aria-label="Previous month"
        >
          ‹
        </button>

        <div className="events-calendar-title">
          <h2>{monthLabel}</h2>
          <button type="button" className="events-today" onClick={goToday}>
            Today
          </button>
        </div>

        <button
          type="button"
          className="events-nav-button"
          onClick={nextMonth}
          aria-label="Next month"
        >
          ›
        </button>
      </div>

      <nav className="events-week-selector" aria-label="Select event week">
        {calendarWeeks.map((week) => {
          const active = !!selectedWeek && sameWeek(week, selectedWeek);

          return (
            <button
              type="button"
              key={week.start.toISOString()}
              className={[
                "events-week-link",
                active ? "events-week-link-active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => setSelectedWeekStart(new Date(week.start))}
              aria-pressed={active}
            >
              {weekLabel(week)}
            </button>
          );
        })}
      </nav>

      <div className="events-week-list">
        {loading && (
          <div className="events-empty">
            <span>Loading events...</span>
          </div>
        )}

        {!loading && selectedWeekEvents.length === 0 && (
          <div className="events-empty">
            <strong>No events posted for this week.</strong>
            <span>Try another week or check back soon.</span>
          </div>
        )}

        {!loading &&
          selectedWeekEvents.map((event) => (
            <article className="events-list-row" key={event.id}>
              <button
                type="button"
                className="events-list-row-main"
                onClick={() => setSelectedEvent(event)}
                aria-label={`View ${event.title} event details`}
              >
                <span className="events-list-row-top">
                  <strong>{event.title}</strong>
                  <span aria-hidden="true">·</span>
                  <span>{event.venue_name}</span>
                </span>

                <span className="events-list-row-bottom">
                  <span>{eventDate(event.starts_at)}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {eventTime(event.starts_at)}
                    {event.ends_at && (
                      <>
                        {" – "}
                        {eventTime(event.ends_at)}
                      </>
                    )}
                  </span>
                </span>
              </button>

              <div
                className="events-list-reminder"
                onClick={(event) => event.stopPropagation()}
              >
                <NotificationSignup
                  mode="reminder"
                  eventId={event.id}
                  eventName={event.title}
                />
              </div>

              {event.flyer_url ? (
                <button
                  type="button"
                  className="events-list-flyer-button"
                  onClick={() => setSelectedFlyer(event)}
                  aria-label={`Enlarge ${event.title} flyer`}
                >
                  <img
                    src={event.flyer_url}
                    alt={`${event.title} event flyer`}
                    className="events-list-flyer"
                  />
                </button>
              ) : (
                <div
                  className="events-list-flyer-placeholder"
                  aria-hidden="true"
                >
                  Event
                </div>
              )}
            </article>
          ))}
      </div>

      {selectedFlyer?.flyer_url && (
        <div
          className="events-modal-backdrop events-flyer-backdrop"
          role="presentation"
          onClick={() => setSelectedFlyer(null)}
        >
          <div
            className="events-flyer-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`${selectedFlyer.title} flyer`}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="events-modal-close"
              aria-label="Close flyer"
              onClick={() => setSelectedFlyer(null)}
            >
              ×
            </button>

            <img
              src={selectedFlyer.flyer_url}
              alt={`${selectedFlyer.title} event flyer`}
            />
          </div>
        </div>
      )}

      {selectedEvent && (
        <div
          className="events-modal-backdrop"
          role="presentation"
          onClick={() => setSelectedEvent(null)}
        >
          <div
            className="events-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="events-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="events-modal-close"
              aria-label="Close event details"
              onClick={() => setSelectedEvent(null)}
            >
              ×
            </button>

            <div className="events-modal-header">
              <div className="events-detail-group">
                <span className="events-detail-label">Why</span>
                <h2 id="events-modal-title">{selectedEvent.title}</h2>
              </div>

              <div className="events-detail-group">
                <span className="events-detail-label">Where</span>
                <div className="events-detail-value events-detail-venue">
                  {selectedEvent.venue_name}
                </div>
              </div>

              <div className="events-detail-group">
                <span className="events-detail-label">When</span>
                <div className="events-detail-value">
                  {new Date(selectedEvent.starts_at).toLocaleDateString(
                    "en-US",
                    {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                    }
                  )}
                  {" · "}
                  {eventTime(selectedEvent.starts_at)}
                  {selectedEvent.ends_at && (
                    <>
                      {" – "}
                      {eventTime(selectedEvent.ends_at)}
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="events-flyer-placeholder">
              {selectedEvent.flyer_url ? (
                <img
                  src={selectedEvent.flyer_url}
                  alt={`${selectedEvent.title} event flyer`}
                  style={{
                    display: "block",
                    width: "100%",
                    height: "100%",
                    objectFit: "contain",
                    borderRadius: "inherit",
                  }}
                />
              ) : (
                <span>Event flyer</span>
              )}
            </div>

            <div className="events-modal-actions">
              <NotificationSignup
                mode="reminder"
                eventId={selectedEvent.id}
                eventName={selectedEvent.title}
              />

              {selectedEvent.venue_slug && (
                <a
                  className="btn primary events-modal-spot"
                  href={`/s/${selectedEvent.venue_slug}`}
                >
                  View Spot
                </a>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
