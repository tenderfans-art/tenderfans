"use client";

import Link from "next/link";
import {
  FormEvent,
  useEffect,
  useState,
} from "react";
import {
  useParams,
  useRouter,
} from "next/navigation";
import { supabase } from "@/lib/supabase";

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

type Venue = {
  id: string;
  name: string;
};

export default function EditSpotEventPage() {
  const params =
    useParams<{
      venueId: string;
      eventId: string;
    }>();

  const router = useRouter();

  const venueId = params.venueId;
  const eventId = params.eventId;

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  const [venue, setVenue] = useState<Venue | null>(null);

  const [title, setTitle] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");

  const [currentFlyerUrl, setCurrentFlyerUrl] =
    useState("");

  const [currentFlyerPath, setCurrentFlyerPath] =
    useState("");

  const [replacementFlyer, setReplacementFlyer] =
    useState<File | null>(null);

  useEffect(() => {
    async function loadPage() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        window.location.href = "/login";
        return;
      }

      const { data: permission, error: permissionError } =
        await supabase
          .from("venue_permissions")
          .select("venue_id")
          .eq("user_id", user.id)
          .eq("venue_id", venueId)
          .eq("can_edit", true)
          .maybeSingle();

      if (permissionError || !permission) {
        setMessage(
          "You do not have permission to edit events for this Spot."
        );
        setLoading(false);
        return;
      }

      const [venueResult, eventResult] =
        await Promise.all([
          supabase
            .from("venues")
            .select("id, name")
            .eq("id", venueId)
            .maybeSingle(),

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
            .eq("venue_id", venueId)
            .maybeSingle(),
        ]);

      if (
        venueResult.error ||
        !venueResult.data
      ) {
        setMessage(
          venueResult.error?.message ||
            "Spot could not be found."
        );
        setLoading(false);
        return;
      }

      const event =
        eventResult.data as ExistingEvent | null;

      if (eventResult.error || !event) {
        setMessage(
          eventResult.error?.message ||
            "Event could not be found."
        );
        setLoading(false);
        return;
      }

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

      const localEndTime = end
        ? [
            String(end.getHours()).padStart(2, "0"),
            String(end.getMinutes()).padStart(2, "0"),
          ].join(":")
        : "";

      setVenue(venueResult.data as Venue);
      setTitle(event.title);
      setEventDate(localDate);
      setStartTime(localStartTime);
      setEndTime(localEndTime);
      setCurrentFlyerUrl(event.flyer_url || "");
      setCurrentFlyerPath(
        event.flyer_storage_path || ""
      );

      setLoading(false);
    }

    loadPage();
  }, [eventId, venueId]);

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

  async function handleSubmit(
    e: FormEvent<HTMLFormElement>
  ) {
    e.preventDefault();
    setMessage("");

    if (!title.trim()) {
      setMessage("Enter an event title.");
      return;
    }

    if (!eventDate || !startTime) {
      setMessage(
        "Enter the event date and start time."
      );
      return;
    }

    if (
      !currentFlyerUrl ||
      !currentFlyerPath
    ) {
      setMessage(
        "This event does not have a valid flyer."
      );
      return;
    }

    const start =
      new Date(`${eventDate}T${startTime}`);

    if (Number.isNaN(start.getTime())) {
      setMessage(
        "Enter a valid event date and start time."
      );
      return;
    }

    let end: Date | null = null;

    if (endTime) {
      end =
        new Date(`${eventDate}T${endTime}`);

      if (Number.isNaN(end.getTime())) {
        setMessage("Enter a valid end time.");
        return;
      }

      // Early-morning end times belong to the
      // following calendar day.
      if (end < start) {
        end.setDate(end.getDate() + 1);
      }

      if (end.getTime() === start.getTime()) {
        setMessage(
          "End time must be different from the start time."
        );
        return;
      }
    }

    if (replacementFlyer) {
      const flyerError =
        validateFlyer(replacementFlyer);

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
      const safeName =
        replacementFlyer.name.replace(
          /[^a-zA-Z0-9._-]/g,
          "-"
        );

      newFlyerPath =
        `${user.id}/${crypto.randomUUID()}-${safeName}`;

      const { error: uploadError } =
        await supabase.storage
          .from("event-flyers")
          .upload(
            newFlyerPath,
            replacementFlyer
          );

      if (uploadError) {
        setMessage(uploadError.message);
        setSubmitting(false);
        return;
      }

      const { data: publicUrlData } =
        supabase.storage
          .from("event-flyers")
          .getPublicUrl(newFlyerPath);

      nextFlyerUrl =
        publicUrlData.publicUrl;

      nextFlyerPath = newFlyerPath;
    }

    const { error: updateError } =
      await supabase.rpc(
        "spot_owner_update_event",
        {
          p_event_id: eventId,
          p_venue_id: venueId,
          p_title: title.trim(),
          p_starts_at: start.toISOString(),
          p_ends_at:
            end ? end.toISOString() : null,
          p_flyer_url: nextFlyerUrl,
          p_flyer_storage_path:
            nextFlyerPath,
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

    /*
     * Only attempt old-file cleanup if this
     * user originally owns that storage path.
     * Partner-submitted flyers live under the
     * Partner's folder and must not cause the
     * Owner edit to fail.
     */
    if (
      newFlyerPath &&
      currentFlyerPath &&
      currentFlyerPath !== newFlyerPath &&
      currentFlyerPath.startsWith(
        `${user.id}/`
      )
    ) {
      const { error: cleanupError } =
        await supabase.storage
          .from("event-flyers")
          .remove([currentFlyerPath]);

      if (cleanupError) {
        console.error(
          "Old event flyer cleanup failed:",
          cleanupError
        );
      }
    }

    router.push(
      `/account/spot/${venueId}/events`
    );
  }

  if (loading) {
    return (
      <main className="flow-page">
        <div className="shell narrow">
          <section className="flow-card">
            <p>Loading event...</p>
          </section>
        </div>
      </main>
    );
  }

  if (!venue) {
    return (
      <main className="flow-page">
        <div className="shell narrow">
          <section className="flow-card">
            <p>{message}</p>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="flow-page">
      <div className="shell narrow">
        <section className="flow-card">
          <div className="eyebrow">
            SPOT OWNER PORTAL
          </div>

          <h1>Edit Event</h1>

          <p className="lead-copy">
            {venue.name}
          </p>

          <div
            className="privacy-note"
            style={{ marginBottom: "20px" }}
          >
            Saving changes sends this event back
            to TenderFans for verification. If it
            is currently live on the calendar, it
            will be temporarily removed until the
            updated event is approved.
          </div>

          <form
            onSubmit={handleSubmit}
            style={{
              display: "grid",
              gap: "16px",
            }}
          >
            <label>
              <strong>Event Title</strong>
              <input
                className="field"
                value={title}
                onChange={(e) =>
                  setTitle(e.target.value)
                }
                required
              />
            </label>

            <label>
              <strong>Event Date</strong>
              <input
                className="field"
                type="date"
                value={eventDate}
                onChange={(e) =>
                  setEventDate(e.target.value)
                }
                required
              />
            </label>

            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "1fr 1fr",
                gap: "12px",
              }}
            >
              <label>
                <strong>Start Time</strong>
                <input
                  className="field"
                  type="time"
                  value={startTime}
                  onChange={(e) =>
                    setStartTime(
                      e.target.value
                    )
                  }
                  required
                />
              </label>

              <label>
                <strong>End Time</strong>
                <input
                  className="field"
                  type="time"
                  value={endTime}
                  onChange={(e) =>
                    setEndTime(
                      e.target.value
                    )
                  }
                />
              </label>
            </div>

            {currentFlyerUrl && (
              <div>
                <strong>Current Flyer</strong>

                <div
                  style={{
                    marginTop: "10px",
                    borderRadius: "14px",
                    overflow: "hidden",
                    background: "#f3f1e8",
                  }}
                >
                  <img
                    src={currentFlyerUrl}
                    alt={`${title} flyer`}
                    style={{
                      display: "block",
                      width: "100%",
                      maxHeight: "420px",
                      objectFit: "contain",
                    }}
                  />
                </div>
              </div>
            )}

            <label>
              <strong>
                Replace Flyer
              </strong>

              <input
                className="field"
                type="file"
                accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf"
                onChange={(e) => {
                  const file =
                    e.target.files?.[0] ||
                    null;

                  if (!file) {
                    setReplacementFlyer(
                      null
                    );
                    return;
                  }

                  const error =
                    validateFlyer(file);

                  if (error) {
                    setReplacementFlyer(
                      null
                    );
                    setMessage(error);
                    e.target.value = "";
                    return;
                  }

                  setReplacementFlyer(
                    file
                  );
                  setMessage("");
                }}
              />
            </label>

            <button
              type="submit"
              className="landing-action"
              disabled={submitting}
            >
              {submitting
                ? "Submitting..."
                : "Save Changes & Resubmit"}
            </button>

            <Link
              href={`/account/spot/${venueId}/events`}
              style={{ textAlign: "center" }}
            >
              Cancel
            </Link>

            {message && (
              <div className="privacy-note">
                {message}
              </div>
            )}
          </form>
        </section>
      </div>
    </main>
  );
}
