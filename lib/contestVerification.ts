import crypto from "crypto";

const COOKIE_NAME = "tf_contest_verified";
const TOKEN_LIFETIME_SECONDS = 60 * 60 * 24 * 90;

function getSecret() {
  const secret = process.env.CONTEST_VERIFICATION_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error(
      "CONTEST_VERIFICATION_SECRET is not configured."
    );
  }

  return secret;
}

export function normalizeContestPhone(value: unknown) {
  if (typeof value !== "string") return null;

  const raw = value.trim();

  if (!raw) return null;

  if (raw.startsWith("+")) {
    const digits = raw.slice(1).replace(/\D/g, "");

    if (digits.length >= 8 && digits.length <= 15) {
      return `+${digits}`;
    }

    return null;
  }

  const digits = raw.replace(/\D/g, "");

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (
    digits.length === 11 &&
    digits.startsWith("1")
  ) {
    return `+${digits}`;
  }

  return null;
}

export function createPhoneHash(phone: string) {
  return crypto
    .createHmac("sha256", getSecret())
    .update(`phone:${phone}`)
    .digest("hex");
}

export function createCodeHash(
  challengeId: string,
  code: string
) {
  return crypto
    .createHmac("sha256", getSecret())
    .update(`code:${challengeId}:${code}`)
    .digest("hex");
}

export function timingSafeMatch(
  left: string,
  right: string
) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);

  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

type ContestVerificationToken = {
  identityId: string;
  phoneHash: string;
  expiresAt: number;
};

export function createVerificationToken(
  identityId: string,
  phoneHash: string
) {
  const payload: ContestVerificationToken = {
    identityId,
    phoneHash,
    expiresAt:
      Math.floor(Date.now() / 1000) +
      TOKEN_LIFETIME_SECONDS,
  };

  const encoded = Buffer.from(
    JSON.stringify(payload)
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", getSecret())
    .update(`token:${encoded}`)
    .digest("base64url");

  return `${encoded}.${signature}`;
}

export function verifyVerificationToken(
  token: string
): ContestVerificationToken | null {
  try {
    const [encoded, suppliedSignature] =
      token.split(".");

    if (!encoded || !suppliedSignature) {
      return null;
    }

    const expectedSignature = crypto
      .createHmac("sha256", getSecret())
      .update(`token:${encoded}`)
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
    ) as ContestVerificationToken;

    if (
      !payload.identityId ||
      !payload.phoneHash ||
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

    return payload;
  } catch {
    return null;
  }
}

export function getContestVerificationCookieName() {
  return COOKIE_NAME;
}

export function getContestVerificationCookieMaxAge() {
  return TOKEN_LIFETIME_SECONDS;
}
