"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type CalendarEvent = {
  id: string;
  venue_id: string;
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string | null;
  venue_name: string;
  venue_slug: string | null;
};

export default function EventsCalendar() {
  const today = new Date();

  const [month, setMonth] = useState(
    new Date(today.getFullYear(), today.getMonth(), 1)
  );

  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);

  const calendarDays = useMemo(() => {
    const year = month.getFullYear();
    const monthIndex = month.getMonth();

    const firstDay = new Date(year, monthIndex, 1).getDay();
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    const previousMonthDays = new Date(year, monthIndex, 0).getDate();

    const cells = [];

    for (let i = firstDay - 1; i >= 0; i--) {
      cells.push({
        date: new Date(year, monthIndex - 1, previousMonthDays - i),
        currentMonth: false,
      });
    }

    for (let day = 1; day <= daysInMonth; day++) {
      cells.push({
        date: new Date(year, monthIndex, day),
        currentMonth: true,
      });
    }

    let nextDay = 1;
    while (cells.length < 42) {
      cells.push({
        date: new Date(year, monthIndex + 1, nextDay++),
        currentMonth: false,
      });
    }

    return cells;
  }, [month]);

  useEffect(() => {
    async function loadEvents() {
      if (!calendarDays.length) return;

      setLoading(true);

      const rangeStart = new Date(calendarDays[0].date);
      rangeStart.setHours(0, 0, 0, 0);

      const rangeEnd = new Date(calendarDays[calendarDays.length - 1].date);
      rangeEnd.setHours(23, 59, 59, 999);

      const { data, error } = await supabase
        .from("events")
        .select(`
          id,
          venue_id,
          title,
          description,
          starts_at,
          ends_at,
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
        venue_name: event.venues?.name ?? "TenderFans Spot",
        venue_slug: event.venues?.slug ?? null,
      }));

      setEvents(normalized);
      setLoading(false);
    }

    loadEvents();
  }, [calendarDays]);

  function previousMonth() {
    setMonth(
      (current) =>
        new Date(current.getFullYear(), current.getMonth() - 1, 1)
    );
  }

  function nextMonth() {
    setMonth(
      (current) =>
        new Date(current.getFullYear(), current.getMonth() + 1, 1)
    );
  }

  function goToday() {
    setMonth(new Date(today.getFullYear(), today.getMonth(), 1));
  }

  function eventsForDate(date: Date) {
    return events.filter((event) => {
      const eventDate = new Date(event.starts_at);

      return (
        eventDate.getFullYear() === date.getFullYear() &&
        eventDate.getMonth() === date.getMonth() &&
        eventDate.getDate() === date.getDate()
      );
    });
  }

  function eventTime(startsAt: string) {
    return new Date(startsAt).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  const monthLabel = month.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

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

      <div className="events-weekdays">
        {weekdayNames.map((day) => (
          <div key={day}>{day}</div>
        ))}
      </div>

      <div className="events-calendar-grid">
        {calendarDays.map(({ date, currentMonth }) => {
          const isToday =
            date.getFullYear() === today.getFullYear() &&
            date.getMonth() === today.getMonth() &&
            date.getDate() === today.getDate();

          const dayEvents = eventsForDate(date);

          return (
            <div
              key={date.toISOString()}
              className={[
                "events-day",
                currentMonth ? "" : "events-day-muted",
                isToday ? "events-day-today" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <span className="events-day-number">{date.getDate()}</span>

              <div className="events-day-items">
                {dayEvents.map((event) => (
                  <button
                    type="button"
                    className="events-calendar-event"
                    key={event.id}
                    onClick={() => setSelectedEvent(event)}
                  >
                    <span className="events-calendar-event-time">
                      {eventTime(event.starts_at)}
                    </span>
                    <strong>{event.title}</strong>
                    <small>{event.venue_name}</small>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {!loading && events.length === 0 && (
        <div className="events-empty">
          <strong>No events posted yet.</strong>
          <span>Check back soon for events from TenderFans Spots.</span>
        </div>
      )}

      {loading && (
        <div className="events-empty">
          <span>Loading events...</span>
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
                  {new Date(selectedEvent.starts_at).toLocaleDateString("en-US", {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  })}
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
              <span>Event flyer</span>
            </div>

            {selectedEvent.venue_slug && (
              <div className="events-modal-actions">
                <a
                  className="btn primary events-modal-spot"
                  href={`/v/${selectedEvent.venue_slug}`}
                >
                  View Spot
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
