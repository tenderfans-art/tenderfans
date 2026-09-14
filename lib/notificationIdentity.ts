import crypto from "crypto";

const COOKIE_NAME = "tf_notification_identity";
const TOKEN_LIFETIME_SECONDS =
  60 * 60 * 24 * 180;

const MAX_SUBSCRIPTIONS = 60;

function getSecret() {
  const secret =
    process.env.CONTEST_VERIFICATION_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error(
      "CONTEST_VERIFICATION_SECRET is not configured."
    );
  }

  return secret;
}

function timingSafeMatch(
  left: string,
  right: string
) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

export type NotificationIdentityToken = {
  subscriptionIds: string[];
  expiresAt: number;
};

export function createNotificationIdentityToken(
  subscriptionIds: string[]
) {
  const uniqueIds = [
    ...new Set(
      subscriptionIds.filter(Boolean)
    ),
  ].slice(-MAX_SUBSCRIPTIONS);

  const payload: NotificationIdentityToken = {
    subscriptionIds: uniqueIds,
    expiresAt:
      Math.floor(Date.now() / 1000) +
      TOKEN_LIFETIME_SECONDS,
  };

  const encoded = Buffer.from(
    JSON.stringify(payload)
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", getSecret())
    .update(
      `notification-identity:${encoded}`
    )
    .digest("base64url");

  return `${encoded}.${signature}`;
}

export function verifyNotificationIdentityToken(
  token: string
): NotificationIdentityToken | null {
  try {
    const [
      encoded,
      suppliedSignature,
    ] = token.split(".");

    if (
      !encoded ||
      !suppliedSignature
    ) {
      return null;
    }

    const expectedSignature = crypto
      .createHmac(
        "sha256",
        getSecret()
      )
      .update(
        `notification-identity:${encoded}`
      )
      .digest("base64url");

    if (
      !timingSafeMatch(
        suppliedSignature,
        expectedSignature
      )
    ) {
      return null;
    }

    const payload = JSON.parse(
      Buffer.from(
        encoded,
        "base64url"
      ).toString("utf8")
    ) as NotificationIdentityToken;

    if (
      !Array.isArray(
        payload.subscriptionIds
      ) ||
      !payload.expiresAt
    ) {
      return null;
    }

    if (
      payload.expiresAt <
      Math.floor(Date.now() / 1000)
    ) {
      return null;
    }

    return {
      subscriptionIds:
        payload.subscriptionIds
          .filter(
            (id) =>
              typeof id === "string" &&
              id.length > 0
          )
          .slice(-MAX_SUBSCRIPTIONS),
      expiresAt:
        payload.expiresAt,
    };
  } catch {
    return null;
  }
}

export function getNotificationIdentityCookieName() {
  return COOKIE_NAME;
}

export function getNotificationIdentityCookieMaxAge() {
  return TOKEN_LIFETIME_SECONDS;
}
