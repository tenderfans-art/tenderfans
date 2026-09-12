import { Resend } from "resend";
import twilio from "twilio";

export type NotificationChannel = "email" | "sms";

type EmailInput = {
  to: string;
  subject: string;
  text: string;
  url?: string | null;
};

type SmsInput = {
  to: string;
  text: string;
  url?: string | null;
};

function getSiteUrl() {
  return (
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ||
    "https://tenderfans.com"
  );
}

export function absoluteTenderFansUrl(
  path?: string | null
) {
  const base = getSiteUrl();

  if (!path) {
    return base;
  }

  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export function outboundSmsEnabled() {
  return process.env.OUTBOUND_SMS_ENABLED === "true";
}

export async function sendNotificationEmail(
  input: EmailInput
) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;

  if (!apiKey || !from) {
    throw new Error(
      "Resend notification delivery is not configured."
    );
  }

  const resend = new Resend(apiKey);

  const url = input.url
    ? absoluteTenderFansUrl(input.url)
    : null;

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.55;color:#222;">
      <p>${escapeHtml(input.text)}</p>
      ${
        url
          ? `<p>
              <a
                href="${escapeHtml(url)}"
                style="
                  display:inline-block;
                  padding:10px 16px;
                  background:#222;
                  color:#fff;
                  text-decoration:none;
                  border-radius:8px;
                  font-weight:700;
                "
              >
                View on TenderFans
              </a>
            </p>`
          : ""
      }
      <p style="font-size:12px;color:#666;">
        You requested this notification from TenderFans.
      </p>
    </div>
  `;

  const { data, error } = await resend.emails.send({
    from,
    to: input.to,
    subject: input.subject,
    text: url
      ? `${input.text}\n\n${url}`
      : input.text,
    html,
  });

  if (error) {
    throw new Error(
      typeof error.message === "string"
        ? error.message
        : "Resend notification delivery failed."
    );
  }

  return {
    providerReference: data?.id ?? null,
  };
}

export async function sendNotificationSms(
  input: SmsInput
) {
  if (!outboundSmsEnabled()) {
    throw new Error(
      "Outbound SMS notifications are disabled."
    );
  }

  const accountSid =
    process.env.TWILIO_ACCOUNT_SID;

  const authToken =
    process.env.TWILIO_AUTH_TOKEN;

  const messagingServiceSid =
    process.env.TWILIO_MESSAGING_SERVICE_SID;

  if (
    !accountSid ||
    !authToken ||
    !messagingServiceSid
  ) {
    throw new Error(
      "Twilio outbound messaging is not configured."
    );
  }

  const client = twilio(accountSid, authToken);

  const url = input.url
    ? absoluteTenderFansUrl(input.url)
    : null;

  const body = url
    ? `${input.text} ${url}`
    : input.text;

  const message = await client.messages.create({
    to: input.to,
    messagingServiceSid,
    body,
  });

  return {
    providerReference: message.sid ?? null,
  };
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
