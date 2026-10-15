export type SpotDisplayRecord = {
  id: string;
  name: string;
  street_address: string | null;
  city: string | null;
  state_region: string | null;
};

function normalized(value: string | null | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

function streetLabel(address: string | null): string {
  if (!address) return "";

  return address
    .trim()
    .replace(/^\d+[A-Za-z]?\s+/, "")
    .replace(/\s+(?:North|South|East|West|N|S|E|W)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildSpotDisplayNames(
  spots: SpotDisplayRecord[],
): Record<string, string> {
  const groups = new Map<string, SpotDisplayRecord[]>();

  for (const spot of spots) {
    const key = [
      normalized(spot.name),
      normalized(spot.city),
      normalized(spot.state_region),
    ].join("|");

    const group = groups.get(key) ?? [];
    group.push(spot);
    groups.set(key, group);
  }

  const labels: Record<string, string> = {};

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const shortLabels = group.map(spot =>
      streetLabel(spot.street_address)
    );

    for (let i = 0; i < group.length; i++) {
      const spot = group[i];
      const short = shortLabels[i];

      const unique =
        short &&
        shortLabels.filter(label =>
          normalized(label) === normalized(short)
        ).length === 1;

      const location = unique
        ? short
        : spot.street_address?.trim();

      if (location) {
        labels[spot.id] = `${spot.name} — ${location}`;
      }
    }
  }

  return labels;
}
