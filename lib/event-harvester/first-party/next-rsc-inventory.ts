export type RscEvent = {
  id?: unknown;
  slug?: unknown;
  title?: unknown;
  description?: unknown;
  date?: unknown;
  venueName?: unknown;
  city?: unknown;
  state?: unknown;
  flyerImage?: unknown;
  status?: unknown;
  isDraft?: unknown;
  startsAtIso?: unknown;
  endsAtIso?: unknown;
  eventbriteUrl?: unknown;
  facebookEventUrl?: unknown;
  gratefultixSlug?: unknown;
  [key: string]: unknown;
};

export function cleanText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value.trim();

  if (!cleaned || cleaned === "$undefined") {
    return null;
  }

  return cleaned;
}

export function validIso(value: unknown): string | null {
  const cleaned = cleanText(value);

  if (!cleaned) {
    return null;
  }

  const parsed = new Date(cleaned);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function decodeRscScriptString(value: string): string {
  /*
   * Next.js Flight/RSC data is emitted inside JavaScript string
   * literals. JSON.parse safely handles the escaping used by the
   * payload: \", \\, \n, and \uXXXX.
   */
  return JSON.parse(`"${value}"`) as string;
}

function extractRscPayloads(html: string): string[] {
  const payloads: string[] = [];

  /*
   * Capture each Next.js Flight push payload independently. This
   * avoids parsing visual HTML and keeps extraction tied to the
   * structured server data.
   */
  const pattern =
    /self\.__next_f\.push\(\[1,"((?:\\.|[^"\\])*)"\]\)<\/script>/g;

  for (const match of html.matchAll(pattern)) {
    try {
      payloads.push(decodeRscScriptString(match[1]));
    } catch {
      // Ignore malformed/unrelated Flight chunks.
    }
  }

  return payloads;
}

function extractJsonObjects(payload: string): RscEvent[] {
  const events: RscEvent[] = [];
  const seenIds = new Set<string>();

  /*
   * Anchor on the stable first-party identity fields exposed by this
   * event schema, then use balanced-brace scanning so nested arrays
   * and objects remain safe.
   */
  const startPattern = /\{"id":"[^"]+","slug":/g;

  for (const match of payload.matchAll(startPattern)) {
    const start = match.index;

    if (start === undefined) {
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let i = start; i < payload.length; i += 1) {
      const char = payload[i];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }

        if (char === "\\") {
          escaped = true;
          continue;
        }

        if (char === '"') {
          inString = false;
        }

        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === "{") {
        depth += 1;
        continue;
      }

      if (char === "}") {
        depth -= 1;

        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }

    if (end === -1) {
      continue;
    }

    try {
      const parsed = JSON.parse(
        payload.slice(start, end)
      ) as RscEvent;

      const id = cleanText(parsed.id);

      if (
        !id ||
        seenIds.has(id) ||
        !cleanText(parsed.slug) ||
        !cleanText(parsed.title) ||
        !validIso(parsed.startsAtIso)
      ) {
        continue;
      }

      seenIds.add(id);
      events.push(parsed);
    } catch {
      // Ignore objects that do not represent valid event data.
    }
  }

  return events;
}


export function extractNextRscEventRecords(html: string): RscEvent[] {
  const byId = new Map<string, RscEvent>();
  for (const payload of extractRscPayloads(html)) {
    for (const event of extractJsonObjects(payload)) {
      const id = cleanText(event.id);
      if (id) byId.set(id, event);
    }
  }
  return [...byId.values()];
}

export function isNextRscInventoryPage(
  html: string, pageUrl: string,
): boolean {
  const events = extractNextRscEventRecords(html);
  if (events.length < 2) return false;

  try {
    const slug = decodeURIComponent(
      new URL(pageUrl).pathname.split("/").filter(Boolean).at(-1) ?? ""
    ).toLowerCase();

    return !events.some(event =>
      cleanText(event.slug)?.toLowerCase() === slug
    );
  } catch {
    return false;
  }
}
