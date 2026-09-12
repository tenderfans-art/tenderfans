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

  const [smsConsent, setSmsConsent] =
    useState(false);

  const [
    reminderMinutesBefore,
    setReminderMinutesBefore,
  ] = useState(1440);

  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [verificationId, setVerificationId] =
    useState("");

  const [verificationCode, setVerificationCode] =
    useState("");

  const [awaitingSmsVerification, setAwaitingSmsVerification] =
    useState(false);

  const [verifyingSms, setVerifyingSms] =
    useState(false);

  const displayName =
    props.mode === "follow"
      ? props.entityName
      : props.eventName;

  async function sendSmsVerification(
    id: string
  ) {
    const response = await fetch(
      "/api/notifications/verification/send",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: props.mode,
          id,
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
          "Could not send the verification code."
      );
    }

    setVerificationId(id);
    setAwaitingSmsVerification(true);

    setMessage(
      "We sent a 6-digit verification code to your mobile number."
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();

    setMessage("");
    setSuccess(false);

    if (!wantsEmail && !wantsSms) {
      setMessage("Choose email, text, or both.");
      return;
    }

    if (wantsSms && !smsConsent) {
      setMessage(
        "Please confirm consent for text notifications."
      );
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

      if (
        wantsSms &&
        data.id
      ) {
        await sendSmsVerification(data.id);
        return;
      }

      setSuccess(true);

      setMessage(
        wantsEmail
          ? props.mode === "follow"
            ? "Check your email to verify your follow."
            : "Check your email to verify your reminder."
          : props.mode === "follow"
            ? "You're following."
            : "Your reminder is set."
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : props.mode === "follow"
            ? "Could not save your follow request."
            : "Could not save your reminder."
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function verifySms(
    event: FormEvent
  ) {
    event.preventDefault();

    if (
      !verificationId ||
      !/^\d{6}$/.test(verificationCode.trim())
    ) {
      setMessage(
        "Enter the 6-digit verification code."
      );
      return;
    }

    setVerifyingSms(true);
    setMessage("");

    try {
      const response = await fetch(
        "/api/notifications/verification/check",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: props.mode,
            id: verificationId,
            code: verificationCode.trim(),
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        setMessage(
          data.error ||
            "That verification code could not be confirmed."
        );
        return;
      }

      setSuccess(true);
      setAwaitingSmsVerification(false);

      if (data.emailPending) {
        setMessage(
          props.mode === "follow"
            ? `Text notifications are active for ${displayName}. Check your email to enable email notifications too.`
            : "Text reminders are active. Check your email to enable email reminders too."
        );
      } else {
        setMessage(
          props.mode === "follow"
            ? `You're following ${displayName}.`
            : "Your event reminder is ready."
        );
      }
    } catch {
      setMessage(
        "Could not verify that phone number."
      );
    } finally {
      setVerifyingSms(false);
    }
  }

  function resetModal() {
    setMessage("");
    setSuccess(false);
    setVerificationCode("");
    setVerificationId("");
    setAwaitingSmsVerification(false);
  }

  return (
    <div className="notification-signup">
      <button
        type="button"
        className="notification-trigger"
        onClick={() => {
          resetModal();
          setOpen(true);
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
            onClick={(event) =>
              event.stopPropagation()
            }
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
              {awaitingSmsVerification
                ? "Mobile verification"
                : props.mode === "follow"
                  ? "Stay in the loop"
                  : "Event reminder"}
            </div>

            <h2 id="notification-modal-title">
              {awaitingSmsVerification
                ? "Verify your number"
                : props.mode === "follow"
                  ? `Follow ${displayName}`
                  : `Remind me about ${displayName}`}
            </h2>

            {awaitingSmsVerification ? (
              <>
                <p className="notification-modal-intro">
                  Enter the 6-digit code we sent to
                  your mobile number.
                </p>

                <form
                  onSubmit={verifySms}
                  className="notification-form"
                >
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={verificationCode}
                    onChange={(event) =>
                      setVerificationCode(
                        event.target.value.replace(
                          /\D/g,
                          ""
                        )
                      )
                    }
                    placeholder="6-digit code"
                  />

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
                    disabled={verifyingSms}
                  >
                    {verifyingSms
                      ? "Verifying..."
                      : "Verify Number"}
                  </button>
                </form>
              </>
            ) : (
              <>
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
                              Number(
                                event.target.value
                              )
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
                        setWantsEmail(
                          event.target.checked
                        )
                      }
                    />

                    <span>Email</span>
                  </label>

                  {wantsEmail && (
                    <input
                      type="email"
                      value={email}
                      onChange={(event) =>
                        setEmail(
                          event.target.value
                        )
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
                        setWantsSms(
                          event.target.checked
                        );

                        if (
                          !event.target.checked
                        ) {
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
                          setPhone(
                            event.target.value
                          )
                        }
                        placeholder="Mobile number"
                        autoComplete="tel"
                      />

                      <label className="notification-sms-consent">
                        <input
                          type="checkbox"
                          checked={smsConsent}
                          onChange={(event) =>
                            setSmsConsent(
                              event.target.checked
                            )
                          }
                        />

                        <span>
                          I agree to receive text
                          notifications from TenderFans.
                          Message and data rates may apply.
                          Reply STOP to unsubscribe.
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
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
