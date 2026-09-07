"use client";

import { FormEvent, useState } from "react";

type FollowProps = {
  mode: "follow";
  entityKind: "bartender" | "venue";
  entityId: string;
  entityName: string;
};

type ReminderProps = {
  mode: "reminder";
  eventId: string;
  eventName: string;
};

type Props = FollowProps | ReminderProps;

export default function NotificationSignup(props: Props) {
  const [open, setOpen] = useState(false);
  const [wantsEmail, setWantsEmail] = useState(true);
  const [wantsSms, setWantsSms] = useState(false);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [smsConsent, setSmsConsent] = useState(false);
  const [reminderMinutesBefore, setReminderMinutesBefore] = useState(1440);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const displayName =
    props.mode === "follow"
      ? props.entityName
      : props.eventName;

  async function submit(event: FormEvent) {
    event.preventDefault();

    setMessage("");
    setSuccess(false);

    if (!wantsEmail && !wantsSms) {
      setMessage("Choose email, text, or both.");
      return;
    }

    if (wantsSms && !smsConsent) {
      setMessage("Please confirm consent for text notifications.");
      return;
    }

    setSubmitting(true);

    try {
      const response = await fetch(
        props.mode === "follow"
          ? "/api/follow"
          : "/api/remind",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            props.mode === "follow"
              ? {
                  entityKind: props.entityKind,
                  entityId: props.entityId,
                  email,
                  phone,
                  wantsEmail,
                  wantsSms,
                  smsConsent,
                }
              : {
                  eventId: props.eventId,
                  reminderMinutesBefore,
                  email,
                  phone,
                  wantsEmail,
                  wantsSms,
                  smsConsent,
                }
          ),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        setMessage(
          data.error ||
            (props.mode === "follow"
              ? "Could not save your follow request."
              : "Could not save your reminder.")
        );
        return;
      }

      setSuccess(true);

      setMessage(
        props.mode === "follow"
          ? "You're almost following — verification is next."
          : "Your reminder is almost ready — verification is next."
      );
    } catch {
      setMessage(
        props.mode === "follow"
          ? "Could not save your follow request."
          : "Could not save your reminder."
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="notification-signup">
      <button
        type="button"
        className="notification-trigger"
        onClick={() => {
          setOpen(true);
          setMessage("");
          setSuccess(false);
        }}
      >
        <span aria-hidden="true">
          {props.mode === "follow" ? "♡" : "🔔"}
        </span>

        <span>
          {props.mode === "follow"
            ? "Follow"
            : "Remind Me"}
        </span>
      </button>

      {open && (
        <div
          className="notification-modal-backdrop"
          onClick={() => setOpen(false)}
        >
          <div
            className="notification-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="notification-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="notification-modal-close"
              onClick={() => setOpen(false)}
              aria-label="Close"
            >
              ×
            </button>

            <div className="eyebrow">
              {props.mode === "follow"
                ? "Stay in the loop"
                : "Event reminder"}
            </div>

            <h2 id="notification-modal-title">
              {props.mode === "follow"
                ? `Follow ${displayName}`
                : `Remind me about ${displayName}`}
            </h2>

            <p className="notification-modal-intro">
              {props.mode === "follow"
                ? `Get notified when ${displayName} posts something new.`
                : "Choose when and how you want to be reminded."}
            </p>

            <form
              onSubmit={submit}
              className="notification-form"
            >
              {props.mode === "reminder" && (
                <div className="notification-reminder-options">
                  <label>
                    <span>Remind me</span>

                    <select
                      value={reminderMinutesBefore}
                      onChange={(event) =>
                        setReminderMinutesBefore(
                          Number(event.target.value)
                        )
                      }
                    >
                      <option value={1440}>
                        1 day before
                      </option>

                      <option value={180}>
                        3 hours before
                      </option>

                      <option value={60}>
                        1 hour before
                      </option>
                    </select>
                  </label>
                </div>
              )}

              <label className="notification-channel">
                <input
                  type="checkbox"
                  checked={wantsEmail}
                  onChange={(event) =>
                    setWantsEmail(event.target.checked)
                  }
                />
                <span>Email</span>
              </label>

              {wantsEmail && (
                <input
                  type="email"
                  value={email}
                  onChange={(event) =>
                    setEmail(event.target.value)
                  }
                  placeholder="Email address"
                  autoComplete="email"
                />
              )}

              <label className="notification-channel">
                <input
                  type="checkbox"
                  checked={wantsSms}
                  onChange={(event) => {
                    setWantsSms(event.target.checked);

                    if (!event.target.checked) {
                      setSmsConsent(false);
                    }
                  }}
                />
                <span>Text</span>
              </label>

              {wantsSms && (
                <>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(event) =>
                      setPhone(event.target.value)
                    }
                    placeholder="Mobile number"
                    autoComplete="tel"
                  />

                  <label className="notification-sms-consent">
                    <input
                      type="checkbox"
                      checked={smsConsent}
                      onChange={(event) =>
                        setSmsConsent(event.target.checked)
                      }
                    />

                    <span>
                      I agree to receive text notifications
                      from TenderFans. Message and data rates
                      may apply. Reply STOP to unsubscribe.
                    </span>
                  </label>
                </>
              )}

              {message && (
                <div
                  className={[
                    "notification-message",
                    success
                      ? "notification-message-success"
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {message}
                </div>
              )}

              <button
                type="submit"
                className="btn primary"
                disabled={submitting}
              >
                {submitting
                  ? "Saving..."
                  : props.mode === "follow"
                  ? "Follow"
                  : "Set Reminder"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
