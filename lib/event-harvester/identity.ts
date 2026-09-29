import { createHash } from "crypto";

export function normalizeTitle(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function eventFingerprint(input: {
  venueId: string;
  title: string;
  startsAt: string;
}) {
  return createHash("sha256")
    .update(
      [
        input.venueId,
        normalizeTitle(input.title),
        input.startsAt,
      ].join("|")
    )
    .digest("hex");
}
