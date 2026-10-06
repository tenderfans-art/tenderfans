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
  is_all_day: boolean;
  flyer_url: string | null;
  venue_name: string;
  venue_slug: string | null;
  venue_city: string;
  venue_state_region: string;
  venue_postal_code: string;
  venue_latitude: number | null;
  venue_longitude: number | null;
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

function eventCalendarDate(event: CalendarEvent) {
  const instant = new Date(event.starts_at);

  if (!event.is_all_day) {
    return instant;
  }

  return new Date(
    instant.getUTCFullYear(),
    instant.getUTCMonth(),
    instant.getUTCDate()
  );
}

function eventOccurrenceEnd(event: CalendarEvent) {
  if (!event.is_all_day) {
    return new Date(event.ends_at ?? event.starts_at);
  }

  if (event.ends_at) {
    const exclusiveEnd = new Date(event.ends_at);

    const end = new Date(
      exclusiveEnd.getUTCFullYear(),
      exclusiveEnd.getUTCMonth(),
      exclusiveEnd.getUTCDate()
    );

    end.setMilliseconds(-1);
    return end;
  }

  const end = eventCalendarDate(event);
  end.setHours(23, 59, 59, 999);
  return end;
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

export default function EventsCalendar({
  venueId,
  upcomingOnly = false,
  limit,
}: {
  venueId?: string;
  upcomingOnly?: boolean;
  limit?: number;
}) {
  const [requestedEventId, setRequestedEventId] = useState<string | null>(null);
  const [today, setToday] = useState<Date | null>(null);
  const [month, setMonth] = useState<Date | null>(null);
  const [selectedWeekStart, setSelectedWeekStart] = useState<Date | null>(null);

  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [selectedFlyer, setSelectedFlyer] = useState<CalendarEvent | null>(null);
  const [eventSearch, setEventSearch] = useState("");
  const [selectedWeekday, setSelectedWeekday] = useState<number | null>(null);
  const [userLocation, setUserLocation] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [locationStatus, setLocationStatus] = useState<
    "idle" | "loading" | "ready" | "denied" | "unsupported"
  >("idle");

  useEffect(() => {
    const now = new Date();

    setToday(now);
    setMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setSelectedWeekStart(startOfWeek(now));

    const params = new URLSearchParams(window.location.search);
    setRequestedEventId(params.get("event"));
  }, []);

  useEffect(() => {
    if (venueId) return;

    if (!navigator.geolocation) {
      setLocationStatus("unsupported");
      return;
    }

    setLocationStatus("loading");

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
        setLocationStatus("ready");
      },
      () => {
        setLocationStatus("denied");
      }
    );
  }, [venueId]);

  useEffect(() => {
    async function loadRequestedEvent() {
      if (!requestedEventId) return;

      const { data, error } = await supabase
        .from("events")
        .select(`
          id,
          venue_id,
          title,
          description,
          starts_at,
          ends_at,
          is_all_day,
          flyer_url,
          venues (
            name,
            slug,
            city,
            state_region,
            postal_code,
            latitude,
            longitude
          )
        `)
        .eq("id", requestedEventId)
        .eq("status", "published")
        .maybeSingle();

      if (error || !data) return;

      const event: CalendarEvent = {
        id: data.id,
        venue_id: data.venue_id,
        title: data.title,
        description: data.description,
        starts_at: data.starts_at,
        ends_at: data.ends_at,
        is_all_day: data.is_all_day ?? false,
        flyer_url: data.flyer_url ?? null,
        venue_name: (data.venues as any)?.name ?? "TenderFans Spot",
        venue_slug: (data.venues as any)?.slug ?? null,
        venue_city: (data.venues as any)?.city ?? "",
        venue_state_region: (data.venues as any)?.state_region ?? "",
        venue_postal_code: (data.venues as any)?.postal_code ?? "",
        venue_latitude: (data.venues as any)?.latitude ?? null,
        venue_longitude: (data.venues as any)?.longitude ?? null,
      };

      const eventDate = eventCalendarDate(event);

      setMonth(
        new Date(eventDate.getFullYear(), eventDate.getMonth(), 1)
      );
      setSelectedWeekStart(startOfWeek(eventDate));
      setSelectedEvent(event);
    }

    loadRequestedEvent();
  }, [requestedEventId]);

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
      rangeStart.setDate(rangeStart.getDate() - 1);

      const rangeEnd = new Date(calendarWeeks[calendarWeeks.length - 1].end);
      rangeEnd.setDate(rangeEnd.getDate() + 1);

      let query = supabase
        .from("events")
        .select(`
          id,
          venue_id,
          title,
          description,
          starts_at,
          ends_at,
          is_all_day,
          flyer_url,
          venues (
            name,
            slug,
            city,
            state_region,
            postal_code,
            latitude,
            longitude
          )
        `)
        .eq("status", "published")
        .order("starts_at", { ascending: true });

      if (venueId) {
        query = query.eq("venue_id", venueId);
      } else {
        query = query
          .gte("starts_at", rangeStart.toISOString())
          .lte("starts_at", rangeEnd.toISOString());
      }

      const { data, error } = await query;

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
        is_all_day: event.is_all_day ?? false,
        flyer_url: event.flyer_url ?? null,
        venue_name: event.venues?.name ?? "TenderFans Spot",
        venue_slug: event.venues?.slug ?? null,
        venue_city: event.venues?.city ?? "",
        venue_state_region: event.venues?.state_region ?? "",
        venue_postal_code: event.venues?.postal_code ?? "",
        venue_latitude: event.venues?.latitude ?? null,
        venue_longitude: event.venues?.longitude ?? null,
      }));

      setEvents(normalized);
      setLoading(false);
    }

    loadEvents();
  }, [calendarWeeks, venueId]);

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

  const selectedWeekIsCurrent = useMemo(() => {
    if (!selectedWeek || !today) return false;

    return sameWeek(
      selectedWeek,
      {
        start: startOfWeek(today),
        end: endOfWeek(today),
      }
    );
  }, [selectedWeek, today]);

  const selectedWeekEvents = useMemo(() => {
    if (!selectedWeek) return [];

    return events.filter((event) => {
      const eventDate = eventCalendarDate(event);

      if (
        eventDate < selectedWeek.start ||
        eventDate > selectedWeek.end
      ) {
        return false;
      }

      /*
       * Current Week is forward-looking from the current local
       * calendar day. Completed days remain stored and become
       * visible again when this week is viewed historically.
       */
      if (
        selectedWeekIsCurrent &&
        today &&
        eventDate < new Date(
          today.getFullYear(),
          today.getMonth(),
          today.getDate()
        )
      ) {
        return false;
      }

      return true;
    });
  }, [
    events,
    selectedWeek,
    selectedWeekIsCurrent,
    today,
  ]);

  useEffect(() => {
    if (
      !selectedWeekIsCurrent ||
      !today ||
      selectedWeekday === null
    ) {
      return;
    }

    if (selectedWeekday < today.getDay()) {
      setSelectedWeekday(null);
    }
  }, [
    selectedWeekIsCurrent,
    selectedWeekday,
    today,
  ]);

  const visibleEvents = useMemo(() => {
    if (!venueId) {
      /*
       * Geolocation is the default discovery view, not a hard search
       * boundary. An active search can discover matching events
       * outside the default 10-mile radius.
       */
      if (eventSearch.trim()) {
        return selectedWeekEvents;
      }

      if (
        locationStatus === "idle" ||
        locationStatus === "loading"
      ) {
        return [];
      }

      if (locationStatus !== "ready" || !userLocation) {
        return selectedWeekEvents;
      }

      const toRad = (value: number) => (value * Math.PI) / 180;

      return selectedWeekEvents.filter((event) => {
        if (
          event.venue_latitude == null ||
          event.venue_longitude == null
        ) {
          return false;
        }

        const earthRadiusMiles = 3958.8;
        const dLat = toRad(event.venue_latitude - userLocation.latitude);
        const dLng = toRad(event.venue_longitude - userLocation.longitude);
        const lat1 = toRad(userLocation.latitude);
        const lat2 = toRad(event.venue_latitude);

        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(lat1) *
            Math.cos(lat2) *
            Math.sin(dLng / 2) ** 2;

        const distance =
          2 * earthRadiusMiles * Math.asin(Math.sqrt(a));

        return distance <= 10;
      });
    }

    if (!upcomingOnly) {
      return limit ? events.slice(0, limit) : events;
    }

    const now = new Date();

    const upcoming = events.filter((event) => {
      return eventOccurrenceEnd(event) >= now;
    });

    return limit ? upcoming.slice(0, limit) : upcoming;
  }, [
    events,
    selectedWeekEvents,
    venueId,
    upcomingOnly,
    limit,
    eventSearch,
    locationStatus,
    userLocation,
  ]);

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

    setMonth(
      new Date(
        today.getFullYear(),
        today.getMonth(),
        1
      )
    );
    setSelectedWeekStart(startOfWeek(today));
    setSelectedWeekday(today.getDay());
  }

  function eventTime(value: string) {
    return new Date(value).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function eventDateLabel(event: CalendarEvent) {
    return eventCalendarDate(event).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }

  function eventDayLabel(event: CalendarEvent) {
    return eventCalendarDate(event).toLocaleDateString("en-US", {
      weekday: "long",
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

  const filteredEvents = useMemo(() => {
    const search = eventSearch.trim().toLowerCase();

    return visibleEvents.filter((event) => {
      const eventDate = eventCalendarDate(event);

      if (
        selectedWeekday !== null &&
        eventDate.getDay() !== selectedWeekday
      ) {
        return false;
      }

      if (search) {
        const normalize = (value: string) =>
          value
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, " ")
            .replace(/\bsaint\b/g, "st")
            .replace(/\s+/g, " ")
            .trim();

        const normalizedSearch = normalize(search);
        const searchableText = normalize(
          [
            event.title,
            event.description ?? "",
            event.venue_name,
            event.venue_city,
            event.venue_state_region,
            event.venue_postal_code,
          ].join(" ")
        );

        if (!searchableText.includes(normalizedSearch)) {
          return false;
        }
      }

      return true;
    });
  }, [visibleEvents, eventSearch, selectedWeekday]);

  const eventsByDay = useMemo(() => {
    const groups = new Map<string, CalendarEvent[]>();

    for (const event of filteredEvents) {
      const date = eventCalendarDate(event);
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

      const existing = groups.get(key) ?? [];
      existing.push(event);
      groups.set(key, existing);
    }

    return Array.from(groups.values());
  }, [filteredEvents]);

  return (
    <section className="events-calendar-card">
      {!venueId && (
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
      )}

      {!venueId && (
      <div className="events-date-filters">
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
                <span>{weekLabel(week)}</span>
                <span
                  className="events-week-count"
                  aria-label={`${events.filter((event) => {
                    const eventDate = eventCalendarDate(event);
                    return eventDate >= week.start && eventDate <= week.end;
                  }).length} events`}
                >
                  {events.filter((event) => {
                    const eventDate = eventCalendarDate(event);
                    return eventDate >= week.start && eventDate <= week.end;
                  }).length}
                </span>
              </button>
            );
          })}
        </nav>

        <nav
          className="events-weekday-selector"
          aria-label="Filter events by day of week"
        >
          {[
            { label: "All", value: null },
            { label: "Sun", value: 0 },
            { label: "Mon", value: 1 },
            { label: "Tue", value: 2 },
            { label: "Wed", value: 3 },
            { label: "Thu", value: 4 },
            { label: "Fri", value: 5 },
            { label: "Sat", value: 6 },
          ]
            .filter((day) => {
              if (
                day.value === null ||
                !selectedWeekIsCurrent ||
                !today
              ) {
                return true;
              }

              return day.value >= today.getDay();
            })
            .map((day) => {
            const active = selectedWeekday === day.value;

            return (
              <button
                type="button"
                key={day.label}
                className={[
                  "events-weekday-link",
                  active ? "events-weekday-link-active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => setSelectedWeekday(day.value)}
                aria-pressed={active}
              >
                {day.label}
              </button>
            );
          })}
        </nav>
      </div>
      )}

      {!venueId && (
        <div className="events-calendar-filters">
          <input
            type="search"
            className="events-search-input"
            placeholder="Search events, Spots, keywords or ZIP..."
            value={eventSearch}
            onChange={(event) => setEventSearch(event.target.value)}
            aria-label="Search events or spots"
          />
        </div>
      )}

      <div className="events-week-list">
        {loading && (
          <div className="events-empty">
            <span>Loading events...</span>
          </div>
        )}

        {!loading &&
          !venueId &&
          !eventSearch.trim() &&
          (locationStatus === "idle" || locationStatus === "loading") && (
            <div className="events-empty">
              <strong>Finding events near you...</strong>
              <span>Checking for events within 10 miles.</span>
            </div>
          )}

        {!loading &&
          !(
            !venueId &&
            !eventSearch.trim() &&
            (locationStatus === "idle" || locationStatus === "loading")
          ) &&
          filteredEvents.length === 0 && (
            <div className="events-empty">
              <strong>
                {venueId
                  ? "No upcoming events posted."
                  : eventSearch || selectedWeekday !== null
                    ? "No events match these filters."
                    : locationStatus === "ready"
                      ? "No events within 10 miles this week."
                      : "No events posted for this week."}
              </strong>
              <span>
                {venueId
                  ? "Check back soon."
                  : eventSearch || selectedWeekday !== null
                    ? "Try another search or day."
                    : locationStatus === "ready"
                      ? "Try another week or search for events outside your area."
                      : "Try another week or check back soon."}
              </span>
            </div>
          )}

        {!loading &&
          eventsByDay.map((dayEvents) => (
            <section
              className="events-day-group"
              key={eventDayLabel(dayEvents[0])}
            >
              <div className="events-day-heading">
                {eventDayLabel(dayEvents[0])}
              </div>

              <div className="events-day-events">
                {dayEvents.map((event) => (
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
                        <span>
                          {event.is_all_day ? (
                            "All day"
                          ) : (
                            <>
                              {eventTime(event.starts_at)}
                              {event.ends_at && (
                                <>
                                  {" – "}
                                  {eventTime(event.ends_at)}
                                </>
                              )}
                            </>
                          )}
                        </span>

                        <span
                          className="events-list-reminder"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <NotificationSignup
                            mode="reminder"
                            eventId={event.id}
                            eventName={event.title}
                          />
                        </span>
                      </span>
                    </button>

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
            </section>
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
                  {eventDateLabel(selectedEvent)}
                  {" · "}
                  {selectedEvent.is_all_day ? (
                    "All day"
                  ) : (
                    <>
                      {eventTime(selectedEvent.starts_at)}
                      {selectedEvent.ends_at && (
                        <>
                          {" – "}
                          {eventTime(selectedEvent.ends_at)}
                        </>
                      )}
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
