"use client";

import { FormEvent, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

type Venue = {
  id: string;
  name: string;
  city: string | null;
  state_region: string | null;
};

export default function NewSpotEventPage() {
  const router = useRouter();
  const params = useParams();

  const venueId =
    typeof params?.venueId === "string"
      ? params.venueId
      : "";

  const [venue, setVenue] = useState<Venue | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  const [title, setTitle] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [flyer, setFlyer] = useState<File | null>(null);

  useEffect(() => {
    async function loadPage() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        window.location.href = "/login";
        return;
      }

      if (!venueId) {
        setMessage("Invalid Spot.");
        setLoading(false);
        return;
      }

      const { data: permission, error: permissionError } =
        await supabase
          .from("venue_permissions")
          .select("venue_id")
          .eq("user_id", user.id)
          .eq("venue_id", venueId)
          .maybeSingle();

      if (permissionError || !permission) {
        setMessage(
          "You do not have permission to submit events for this Spot."
        );
        setLoading(false);
        return;
      }

      const { data: venueData, error: venueError } =
        await supabase
          .from("venues")
          .select("id, name, city, state_region")
          .eq("id", venueId)
          .single();

      if (venueError || !venueData) {
        setMessage(
          venueError?.message || "Could not load this Spot."
        );
        setLoading(false);
        return;
      }

      setVenue(venueData as Venue);
      setLoading(false);
    }

    loadPage();
  }, [venueId]);

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

    if (!venue) {
      setMessage("Could not verify the hosting Spot.");
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

    // Reconfirm Spot ownership immediately before submission.
    const { data: permission, error: permissionError } =
      await supabase
        .from("venue_permissions")
        .select("venue_id")
        .eq("user_id", user.id)
        .eq("venue_id", venue.id)
        .maybeSingle();

    if (permissionError || !permission) {
      setMessage(
        "You do not have permission to submit events for this Spot."
      );
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
        venue_id: venue.id,
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

        // Spot ownership is already established.
        // Admin only needs to verify the event itself.
        venue_approval_status: "approved",
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

    router.push("/account/spot");
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

  if (!venue) {
    return (
      <main className="flow-page">
        <div className="shell narrow">
          <div className="flow-card">
            <div className="eyebrow">
              SPOT OWNER ACCOUNT
            </div>

            <h1>Submit Event</h1>

            <div className="privacy-note">
              {message || "Could not load this Spot."}
            </div>

            <button
              type="button"
              onClick={() => router.push("/account/spot")}
            >
              Back to Spots
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="flow-page">
      <div className="shell narrow">
        <section className="flow-card">
          <div className="eyebrow">
            SPOT OWNER ACCOUNT
          </div>

          <h1>Submit Event</h1>

          <p className="lead-copy">
            Submit an event for your Spot. Your Spot
            ownership is already verified, so the event
            will go directly to TenderFans event
            verification before appearing on the public
            calendar.
          </p>

          <form
            onSubmit={handleSubmit}
            className="partner-application-form"
          >
            <div
              style={{
                padding: "12px 14px",
                borderRadius: "12px",
                background: "#f2efe6",
              }}
            >
              <strong>Hosting Spot:</strong>{" "}
              {venue.name}

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
            </div>

            <label>
              <strong>Event Title</strong>
              <input
                value={title}
                onChange={(e) =>
                  setTitle(e.target.value)
                }
                placeholder="Event name"
                maxLength={120}
              />
            </label>

            <label>
              <strong>Event Date</strong>
              <input
                type="date"
                value={eventDate}
                onChange={(e) =>
                  setEventDate(e.target.value)
                }
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
                  const file =
                    e.target.files?.[0] || null;

                  if (!file) {
                    setFlyer(null);
                    return;
                  }

                  const error =
                    validateFlyer(file);

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
                Required. JPG, PNG, WebP or PDF.
                Maximum 10 MB.
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
                router.push("/account/spot")
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
