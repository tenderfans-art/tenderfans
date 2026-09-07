"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import GooglePlacePicker from "@/components/GooglePlacePicker";
import { supabase } from "@/lib/supabase";

type Venue = {
  id: string;
  name: string;
  city: string | null;
  state_region: string | null;
};

export default function NewPartnerEventPage() {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  const [venues, setVenues] = useState<Venue[]>([]);
  const [query, setQuery] = useState("");
  const [selectedVenueId, setSelectedVenueId] = useState("");

  const [title, setTitle] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [flyer, setFlyer] = useState<File | null>(null);

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
        .select("id, status")
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

      const { data: venueData, error: venueError } = await supabase
        .from("venues")
        .select("id, name, city, state_region")
        .eq("status", "active")
        .order("name", { ascending: true });

      if (venueError) {
        setMessage(venueError.message);
      } else {
        setVenues((venueData as Venue[]) || []);
      }

      setLoading(false);
    }

    loadPage();
  }, []);

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

    if (!flyer) {
      setMessage("An event flyer is required.");
      return;
    }

    const flyerError = validateFlyer(flyer);

    if (flyerError) {
      setMessage(flyerError);
      return;
    }

    const start = new Date(`${eventDate}T${startTime}`);

    if (Number.isNaN(start.getTime())) {
      setMessage("Enter a valid event date and start time.");
      return;
    }

    let end: Date | null = null;

    if (endTime) {
      end = new Date(`${eventDate}T${endTime}`);

      if (Number.isNaN(end.getTime())) {
        setMessage("Enter a valid end time.");
        return;
      }

      if (end <= start) {
        setMessage("End time must be after the start time.");
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

    const safeName = flyer.name.replace(
      /[^a-zA-Z0-9._-]/g,
      "-"
    );

    const storagePath =
      `${user.id}/${crypto.randomUUID()}-${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from("event-flyers")
      .upload(storagePath, flyer);

    if (uploadError) {
      setMessage(uploadError.message);
      setSubmitting(false);
      return;
    }

    const { data: publicUrlData } = supabase.storage
      .from("event-flyers")
      .getPublicUrl(storagePath);

    const flyerUrl = publicUrlData.publicUrl;

    const { error: insertError } = await supabase
      .from("events")
      .insert({
        venue_id: selectedVenueId,
        title: title.trim(),
        description: null,
        starts_at: start.toISOString(),
        ends_at: end ? end.toISOString() : null,
        status: "draft",
        submitted_by: user.id,
        reviewed_by: null,
        reviewed_at: null,
        flyer_url: flyerUrl,
        flyer_storage_path: storagePath,
        venue_approval_status: "pending",
        admin_approval_status: "pending",
      });

    if (insertError) {
      await supabase.storage
        .from("event-flyers")
        .remove([storagePath]);

      setMessage(insertError.message);
      setSubmitting(false);
      return;
    }

    router.push("/account/partner");
  }

  if (loading) {
    return (
      <main className="flow-page">
        <div className="shell narrow">
          <div className="flow-card">
            <p>Loading event submission...</p>
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
          <h1>Submit Event</h1>

          <p className="lead-copy">
            Submit an event for a hosting Spot. Events remain pending
            until the required verification and approval are complete.
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
                              "Content-Type": "application/json",
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

            <label>
              <strong>Event Date</strong>
              <input
                type="date"
                value={eventDate}
                onChange={(e) => setEventDate(e.target.value)}
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

            <label>
              <strong>Event Flyer</strong>

              <input
                type="file"
                accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf"
                onChange={(e) => {
                  const file = e.target.files?.[0] || null;

                  if (!file) {
                    setFlyer(null);
                    return;
                  }

                  const error = validateFlyer(file);

                  if (error) {
                    setFlyer(null);
                    setMessage(error);
                    e.target.value = "";
                    return;
                  }

                  setFlyer(file);
                  setMessage("");
                }}
              />

              <span
                style={{
                  color: "#697177",
                  fontSize: "0.8rem",
                }}
              >
                Required. JPG, PNG, WebP or PDF. Maximum 10 MB.
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
                ? "Submitting Event..."
                : "Submit Event"}
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
        </section>
      </div>
    </main>
  );
}
