"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import GooglePlacePicker from "@/components/GooglePlacePicker";
import { supabase } from "@/lib/supabase";

type Venue = {
  id: string;
  name: string;
  city: string | null;
  state_region: string | null;
};

type ExistingEvent = {
  id: string;
  venue_id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  flyer_url: string | null;
  flyer_storage_path: string | null;
  status: string;
  venue_approval_status: string;
  admin_approval_status: string;
};

export default function EditPartnerEventPage() {
  const params = useParams<{ eventId: string }>();
  const router = useRouter();
  const eventId = params.eventId;

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  const [venues, setVenues] = useState<Venue[]>([]);
  const [query, setQuery] = useState("");
  const [selectedVenueId, setSelectedVenueId] = useState("");

  const [title, setTitle] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");

  const [currentFlyerUrl, setCurrentFlyerUrl] = useState("");
  const [currentFlyerPath, setCurrentFlyerPath] = useState("");
  const [replacementFlyer, setReplacementFlyer] =
    useState<File | null>(null);

  const selectedVenue = useMemo(
    () => venues.find((venue) => venue.id === selectedVenueId) || null,
    [venues, selectedVenueId]
  );

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();

    if (!q || selectedVenueId) return [];

    return venues
      .filter((venue) => {
        const haystack = [
          venue.name,
          venue.city,
          venue.state_region,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return haystack.includes(q);
      })
      .slice(0, 8);
  }, [venues, query, selectedVenueId]);

  useEffect(() => {
    async function loadPage() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        window.location.href = "/partners/login";
        return;
      }

      const { data: partner, error: partnerError } = await supabase
        .from("partner_profiles")
        .select("status")
        .eq("user_id", user.id)
        .maybeSingle();

      if (
        partnerError ||
        !partner ||
        partner.status !== "approved"
      ) {
        window.location.href = "/partners/apply";
        return;
      }

      const [venueResult, eventResult] = await Promise.all([
        supabase
          .from("venues")
          .select("id, name, city, state_region")
          .eq("status", "active")
          .order("name", { ascending: true }),

        supabase
          .from("events")
          .select(`
            id,
            venue_id,
            title,
            starts_at,
            ends_at,
            flyer_url,
            flyer_storage_path,
            status,
            venue_approval_status,
            admin_approval_status
          `)
          .eq("id", eventId)
          .eq("submitted_by", user.id)
          .maybeSingle(),
      ]);

      if (venueResult.error) {
        setMessage(venueResult.error.message);
        setLoading(false);
        return;
      }

      const event = eventResult.data as ExistingEvent | null;

      if (eventResult.error || !event) {
        setMessage(
          eventResult.error?.message ||
            "Event could not be found."
        );
        setLoading(false);
        return;
      }

      if (
        event.status !== "published" ||
        event.venue_approval_status !== "approved" ||
        event.admin_approval_status !== "approved"
      ) {
        setMessage(
          "Only approved events can be edited from this page."
        );
        setLoading(false);
        return;
      }

      const venueData = (venueResult.data as Venue[]) || [];
      setVenues(venueData);

      const venue = venueData.find(
        (item) => item.id === event.venue_id
      );

      const start = new Date(event.starts_at);
      const end = event.ends_at
        ? new Date(event.ends_at)
        : null;

      const localDate = [
        start.getFullYear(),
        String(start.getMonth() + 1).padStart(2, "0"),
        String(start.getDate()).padStart(2, "0"),
      ].join("-");

      const localStartTime = [
        String(start.getHours()).padStart(2, "0"),
        String(start.getMinutes()).padStart(2, "0"),
      ].join(":");

      const localEndDate = end
        ? [
            end.getFullYear(),
            String(end.getMonth() + 1).padStart(2, "0"),
            String(end.getDate()).padStart(2, "0"),
          ].join("-")
        : localDate;

      const localEndTime = end
        ? [
            String(end.getHours()).padStart(2, "0"),
            String(end.getMinutes()).padStart(2, "0"),
          ].join(":")
        : "";

      setSelectedVenueId(event.venue_id);
      setQuery(venue?.name || "");
      setTitle(event.title);
      setEventDate(localDate);
      setEndDate(localEndDate);
      setStartTime(localStartTime);
      setEndTime(localEndTime);

      setCurrentFlyerUrl(event.flyer_url || "");
      setCurrentFlyerPath(event.flyer_storage_path || "");

      setLoading(false);
    }

    loadPage();
  }, [eventId]);

  function validateFlyer(file: File) {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
    ];

    if (!allowedTypes.includes(file.type)) {
      return "Flyer must be a JPG, PNG, WebP or PDF.";
    }

    if (file.size > 10 * 1024 * 1024) {
      return "Flyer must be 10 MB or smaller.";
    }

    return "";
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setMessage("");

    if (!selectedVenueId) {
      setMessage("Select the hosting Spot.");
      return;
    }

    if (!title.trim()) {
      setMessage("Enter an event title.");
      return;
    }

    if (!eventDate || !startTime) {
      setMessage("Enter the event date and start time.");
      return;
    }

    if (!currentFlyerUrl || !currentFlyerPath) {
      setMessage("This event does not have a valid flyer.");
      return;
    }

    const start = new Date(`${eventDate}T${startTime}`);

    if (Number.isNaN(start.getTime())) {
      setMessage("Enter a valid event date and start time.");
      return;
    }

    let end: Date | null = null;

    if (endTime) {
      const effectiveEndDate = endDate || eventDate;
      end = new Date(`${effectiveEndDate}T${endTime}`);

      if (Number.isNaN(end.getTime())) {
        setMessage("Enter a valid end time.");
        return;
      }

      if (end < start && (!endDate || endDate === eventDate)) {
        end.setDate(end.getDate() + 1);
      }

      if (end <= start) {
        setMessage("Event end must be after the event start.");
        return;
      }
    }

    if (replacementFlyer) {
      const flyerError = validateFlyer(replacementFlyer);

      if (flyerError) {
        setMessage(flyerError);
        return;
      }
    }

    setSubmitting(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      setMessage("You must be signed in.");
      setSubmitting(false);
      return;
    }

    let nextFlyerUrl = currentFlyerUrl;
    let nextFlyerPath = currentFlyerPath;
    let newFlyerPath = "";

    if (replacementFlyer) {
      const safeName = replacementFlyer.name.replace(
        /[^a-zA-Z0-9._-]/g,
        "-"
      );

      newFlyerPath =
        `${user.id}/${crypto.randomUUID()}-${safeName}`;

      const { error: uploadError } = await supabase.storage
        .from("event-flyers")
        .upload(newFlyerPath, replacementFlyer);

      if (uploadError) {
        setMessage(uploadError.message);
        setSubmitting(false);
        return;
      }

      const { data: publicUrlData } = supabase.storage
        .from("event-flyers")
        .getPublicUrl(newFlyerPath);

      nextFlyerUrl = publicUrlData.publicUrl;
      nextFlyerPath = newFlyerPath;
    }

    const { error: updateError } = await supabase.rpc(
      "partner_update_approved_event",
      {
        p_event_id: eventId,
        p_venue_id: selectedVenueId,
        p_title: title.trim(),
        p_starts_at: start.toISOString(),
        p_ends_at: end ? end.toISOString() : null,
        p_flyer_url: nextFlyerUrl,
        p_flyer_storage_path: nextFlyerPath,
      }
    );

    if (updateError) {
      if (newFlyerPath) {
        await supabase.storage
          .from("event-flyers")
          .remove([newFlyerPath]);
      }

      setMessage(updateError.message);
      setSubmitting(false);
      return;
    }

    if (
      newFlyerPath &&
      currentFlyerPath &&
      currentFlyerPath !== newFlyerPath
    ) {
      await supabase.storage
        .from("event-flyers")
        .remove([currentFlyerPath]);
    }

    router.push("/account/partner");
  }

  if (loading) {
    return (
      <main className="flow-page">
        <div className="shell narrow">
          <div className="flow-card">
            <p>Loading event...</p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="flow-page">
      <div className="shell narrow">
        <section className="flow-card">
          <div className="eyebrow">PARTNER PORTAL</div>
          <h1>Edit Event</h1>

          {message ===
          "Only approved events can be edited from this page." ? (
            <>
              <div className="privacy-note">{message}</div>

              <button
                type="button"
                onClick={() => router.push("/account/partner")}
              >
                Back to My Events
              </button>
            </>
          ) : (
            <>
              <p className="lead-copy">
                Saving changes will return this event to Pending
                verification and temporarily remove it from the public
                calendar.
              </p>

              <form
                onSubmit={handleSubmit}
                className="partner-application-form"
              >
                <label>
                  <strong>Hosting Spot</strong>

                  <input
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setSelectedVenueId("");
                    }}
                    placeholder="Search Spot name or city..."
                  />
                </label>

                {searchResults.length > 0 && (
                  <div
                    style={{
                      border: "1px solid #d7d1c6",
                      borderRadius: "12px",
                      overflow: "hidden",
                      marginTop: "-10px",
                    }}
                  >
                    {searchResults.map((venue) => (
                      <button
                        key={venue.id}
                        type="button"
                        onClick={() => {
                          setSelectedVenueId(venue.id);
                          setQuery(venue.name);
                        }}
                        style={{
                          display: "block",
                          width: "100%",
                          padding: "12px 14px",
                          border: 0,
                          borderBottom: "1px solid #eee9df",
                          background: "#fff",
                          textAlign: "left",
                          cursor: "pointer",
                        }}
                      >
                        <strong>{venue.name}</strong>

                        {(venue.city || venue.state_region) && (
                          <div
                            style={{
                              marginTop: "2px",
                              color: "#697177",
                              fontSize: "0.8rem",
                            }}
                          >
                            {[venue.city, venue.state_region]
                              .filter(Boolean)
                              .join(", ")}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                )}

                {query.trim() &&
                  searchResults.length === 0 &&
                  !selectedVenueId && (
                    <div className="new-entity">
                      <strong>
                        We don&apos;t have this Spot yet.
                      </strong>

                      <span>
                        Search Google for the exact business.
                      </span>

                      <GooglePlacePicker
                        onSelect={async (place: any) => {
                          setMessage("");

                          try {
                            const response = await fetch(
                              "/api/google/place",
                              {
                                method: "POST",
                                headers: {
                                  "Content-Type":
                                    "application/json",
                                },
                                body: JSON.stringify({
                                  placeId: place.id,
                                }),
                              }
                            );

                            const result = await response.json();

                            if (!response.ok) {
                              setMessage(
                                result.error ||
                                  "Could not verify this Spot."
                              );
                              return;
                            }

                            const {
                              data: newVenue,
                              error: venueError,
                            } = await supabase
                              .from("venues")
                              .select(
                                "id, name, city, state_region"
                              )
                              .eq("id", result.venueId)
                              .single();

                            if (venueError || !newVenue) {
                              setMessage(
                                venueError?.message ||
                                  "Spot was added, but could not be selected."
                              );
                              return;
                            }

                            setVenues((current) => [
                              ...current.filter(
                                (venue) =>
                                  venue.id !== newVenue.id
                              ),
                              newVenue as Venue,
                            ]);

                            setSelectedVenueId(newVenue.id);
                            setQuery(newVenue.name);

                            setMessage(
                              `${newVenue.name} selected as the hosting Spot.`
                            );
                          } catch (error) {
                            console.error(
                              "Google Place selection failed:",
                              error
                            );

                            setMessage(
                              "Could not verify this Spot."
                            );
                          }
                        }}
                      />
                    </div>
                  )}

                {selectedVenue && (
                  <div
                    style={{
                      padding: "12px 14px",
                      borderRadius: "12px",
                      background: "#f2efe6",
                    }}
                  >
                    <strong>Hosting Spot:</strong>{" "}
                    {selectedVenue.name}
                  </div>
                )}

                <label>
                  <strong>Event Title</strong>

                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Event name"
                    maxLength={120}
                  />
                </label>

                <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "12px",
              }}
            >
              <label>
                <strong>Start Date</strong>
                <input                    type="date"
                    value={eventDate}
                    onChange={(e) =>
                      setEventDate(e.target.value)
                    }
                />
              </label>

              <label>
                <strong>End Date</strong>
                <input                    type="date"
                    value={endDate || eventDate}
                    onChange={(e) =>
                      setEventDate(e.target.value)
                    }
                />
              </label>
            </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "12px",
                  }}
                >
                  <label>
                    <strong>Start Time</strong>

                    <input
                      type="time"
                      value={startTime}
                      onChange={(e) =>
                        setStartTime(e.target.value)
                      }
                    />
                  </label>

                  <label>
                    <strong>End Time</strong>

                    <input
                      type="time"
                      value={endTime}
                      onChange={(e) =>
                        setEndTime(e.target.value)
                      }
                    />
                  </label>
                </div>

                <div>
                  <strong>Current Flyer</strong>

                  <div style={{ marginTop: "6px" }}>
                    <a
                      href={currentFlyerUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View current flyer
                    </a>
                  </div>
                </div>

                <label>
                  <strong>Replace Flyer</strong>

                  <input
                    type="file"
                    accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf"
                    onChange={(e) => {
                      const file = e.target.files?.[0] || null;

                      if (!file) {
                        setReplacementFlyer(null);
                        return;
                      }

                      const error = validateFlyer(file);

                      if (error) {
                        setReplacementFlyer(null);
                        setMessage(error);
                        e.target.value = "";
                        return;
                      }

                      setReplacementFlyer(file);
                      setMessage("");
                    }}
                  />

                  <span
                    style={{
                      color: "#697177",
                      fontSize: "0.8rem",
                    }}
                  >
                    Optional. Leave blank to keep the current flyer.
                  </span>
                </label>

                {message && (
                  <div className="privacy-note">
                    {message}
                  </div>
                )}

                <button
                  className="landing-action"
                  type="submit"
                  disabled={submitting}
                >
                  {submitting
                    ? "Saving Changes..."
                    : "Save Changes"}
                </button>

                <button
                  type="button"
                  disabled={submitting}
                  onClick={() =>
                    router.push("/account/partner")
                  }
                >
                  Cancel
                </button>
              </form>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
