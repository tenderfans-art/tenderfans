/** County is the single display identity for a newly created geographic Market. */
export function countyMarketIdentity(value: string) {
  const name = value.trim().replace(/\s+/g, " ");
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return { name, key };
}

export function isMarketTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
