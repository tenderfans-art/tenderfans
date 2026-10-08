export const DEFAULT_DISCOVERY_RADIUS = 15;
export const DISCOVERY_RADIUS_KEY = "tenderfans.discoveryRadius";
export const DISCOVERY_RADIUS_OPTIONS = [1, 5, 10, 15, 20, 25, 50];

export function readDiscoveryRadius(): number | null {
  if (typeof window === "undefined") return DEFAULT_DISCOVERY_RADIUS;

  try {
    const saved = window.localStorage.getItem(DISCOVERY_RADIUS_KEY);
    if (saved === "all") return null;
    const parsed = Number(saved);
    return saved && DISCOVERY_RADIUS_OPTIONS.includes(parsed)
      ? parsed
      : DEFAULT_DISCOVERY_RADIUS;
  } catch {
    return DEFAULT_DISCOVERY_RADIUS;
  }
}

export function saveDiscoveryRadius(value: number | null) {
  try {
    window.localStorage.setItem(
      DISCOVERY_RADIUS_KEY,
      value === null ? "all" : String(value)
    );
  } catch {
    // Browser storage may be unavailable.
  }
}
