import type { FirstPartyHarvestEvent } from "./types";

/**
 * TanStack Start / Seroval calendar adapter.
 *
 * Phase 1: discover a calendar's server-function descriptor.
 * No POST requests, browser execution, ingestion, or DB operations.
 *
 * Phase 2 will implement response decoding and event extraction
 * after the descriptor has passed live read-only verification.
 */

export type TanStackCalendarDescriptor = {
  pageUrl: string;
  routeModuleUrl: string;
  functionModuleUrl: string;
  functionHash: string;
  method: "POST";
  queryKey: "weekly-events";
};

const MAX_HTML_BYTES = 1_000_000;
const MAX_MODULE_BYTES = 900_000;
const MAX_MODULES = 30;
const HASH_PATTERN = "[a-f0-9]{64}";

function sameOriginAsset(
  raw: string,
  base: string,
): string | null {
  try {
    const url = new URL(raw, base);
    const origin = new URL(base);

    if (
      url.origin !== origin.origin ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !url.pathname.endsWith(".js")
    ) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

async function readText(
  url: string,
  maxBytes: number,
): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept:
        "text/html,application/javascript,text/javascript,*/*",
      "User-Agent": "TenderFans-Event-Harvester/1.0",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      `TanStack discovery returned HTTP ${response.status}`,
    );
  }

  const declared = Number(
    response.headers.get("content-length") ?? 0,
  );

  if (declared > maxBytes) {
    throw new Error("TanStack discovery resource too large");
  }

  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error("TanStack discovery response has no body");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;

      if (total > maxBytes) {
        throw new Error("TanStack discovery resource too large");
      }

      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const combined = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(combined);
}

function moduleReferences(
  html: string,
  base: string,
): string[] {
  const results = new Set<string>();

  // Includes both modulepreload links and SSR route manifests.
  for (const match of html.matchAll(
    /(?:\/assets\/|\.\/)[A-Za-z0-9._/-]+\.js(?:\?[A-Za-z0-9._=&-]+)?/g,
  )) {
    const url = sameOriginAsset(match[0], base);
    if (url) results.add(url);
  }

  return [...results].slice(0, MAX_MODULES);
}

type ImportBinding = {
  imported: string;
  local: string;
};

function importBindings(
  routeJs: string,
  moduleName: string,
): ImportBinding[] {
  const results: ImportBinding[] = [];

  for (const match of routeJs.matchAll(
    /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g,
  )) {
    const importedPath = match[2].split("/").pop();

    if (importedPath !== moduleName) continue;

    for (const entry of match[1].split(",")) {
      const parts = entry.trim().split(/\s+as\s+/);

      if (!parts[0]) continue;

      results.push({
        imported: parts[0],
        local: parts[1] ?? parts[0],
      });
    }
  }

  return results;
}

function resolvePostHash(
  functionJs: string,
  exportedName: string,
): string | null {
  // Match a server-function registration and its local variable.
  const registrations = new Map<string, string>();

  const registrationPattern = new RegExp(
    String.raw`(?:^|[,;]|\b(?:var|let|const)\s+)\s*(\w+)\s*=\s*` +
    String.raw`\w+\(\{\s*method\s*:\s*` +
    String.raw`[\x27"\x60]POST[\x27"\x60]\s*\}\)` +
    String.raw`\.handler\(\w+\([\x27"\x60]` +
    `(${HASH_PATTERN})` +
    String.raw`[\x27"\x60]\)\)`,
    "g",
  );

  for (const match of functionJs.matchAll(registrationPattern)) {
    registrations.set(match[1], match[2]);
  }

  for (const match of functionJs.matchAll(
    /export\s*\{([^}]+)\}/g,
  )) {
    for (const entry of match[1].split(",")) {
      const parts = entry.trim().split(/\s+as\s+/);
      const local = parts[0];
      const exported = parts[1] ?? parts[0];

      if (exported === exportedName) {
        return registrations.get(local) ?? null;
      }
    }
  }

  return null;
}


/*
 * Decode the verified subset of Seroval's JSON wire format.
 *
 * Unsupported types, malformed records, and excessive nesting
 * fail closed. No executable code is evaluated.
 */
export function decodeTanStackSeroval(
  input: unknown,
): unknown {
  let visited = 0;

  function decode(node: unknown, depth: number): unknown {
    visited += 1;

    if (visited > 20000 || depth > 32) {
      throw new Error("Seroval response exceeds safety limits");
    }

    if (
      !node ||
      typeof node !== "object" ||
      Array.isArray(node)
    ) {
      throw new Error("Invalid Seroval node");
    }

    const record = node as Record<string, unknown>;

    switch (record.t) {
      case 0:
        if (
          typeof record.s !== "number" ||
          !Number.isFinite(record.s)
        ) {
          throw new Error("Invalid Seroval number");
        }
        return record.s;

      case 1:
        if (typeof record.s !== "string") {
          throw new Error("Invalid Seroval string");
        }
        return record.s;

      case 2:
        return null;

      case 3:
        return true;

      case 4:
        return false;

      case 9:
        if (!Array.isArray(record.a)) {
          throw new Error("Invalid Seroval array");
        }

        return record.a.map((value) =>
          decode(value, depth + 1),
        );

      case 10:
      case 11: {
        const properties = record.p;

        if (
          !properties ||
          typeof properties !== "object" ||
          Array.isArray(properties)
        ) {
          throw new Error("Invalid Seroval object");
        }

        const p = properties as Record<string, unknown>;

        if (
          !Array.isArray(p.k) ||
          !Array.isArray(p.v) ||
          p.k.length !== p.v.length
        ) {
          throw new Error("Invalid Seroval properties");
        }

        const output: Record<string, unknown> =
          Object.create(null);

        for (let i = 0; i < p.k.length; i += 1) {
          const key = p.k[i];

          if (
            typeof key !== "string" ||
            key === "__proto__" ||
            key === "prototype" ||
            key === "constructor" ||
            Object.hasOwn(output, key)
          ) {
            throw new Error("Unsafe Seroval property");
          }

          output[key] = decode(p.v[i], depth + 1);
        }

        return output;
      }

      default:
        throw new Error(
          `Unsupported Seroval type: ${String(record.t)}`,
        );
    }
  }

  return decode(input, 0);
}

export type TanStackCalendarEvent = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  start: string;
  end: string | null;
  allDay: boolean;
  category: string | null;
};

export function normalizeTanStackCalendarEvents(
  decoded: unknown,
): TanStackCalendarEvent[] {
  if (
    !decoded ||
    typeof decoded !== "object" ||
    Array.isArray(decoded)
  ) {
    throw new Error("Invalid calendar response");
  }

  const envelope = decoded as Record<string, unknown>;

  if (envelope.error != null) {
    throw new Error("Calendar server returned an error");
  }

  const result = envelope.result;

  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result)
  ) {
    throw new Error("Calendar result missing");
  }

  const data = result as Record<string, unknown>;

  if (data.error != null) {
    throw new Error("Calendar query returned an error");
  }

  if (
    !Array.isArray(data.events) ||
    data.events.length > 10000
  ) {
    throw new Error("Invalid calendar event collection");
  }

  return data.events.map((value, index) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      throw new Error(`Invalid calendar event ${index}`);
    }

    const event = value as Record<string, unknown>;

    if (
      typeof event.id !== "string" ||
      !event.id.trim() ||
      typeof event.title !== "string" ||
      !event.title.trim() ||
      typeof event.start !== "string" ||
      !Number.isFinite(Date.parse(event.start))
    ) {
      throw new Error(
        `Calendar event ${index} missing required fields`,
      );
    }

    if (
      event.end != null &&
      (
        typeof event.end !== "string" ||
        !Number.isFinite(Date.parse(event.end))
      )
    ) {
      throw new Error(`Invalid end date at event ${index}`);
    }

    if (
      event.description != null &&
      typeof event.description !== "string"
    ) {
      throw new Error(`Invalid description at event ${index}`);
    }

    if (
      event.location != null &&
      typeof event.location !== "string"
    ) {
      throw new Error(`Invalid location at event ${index}`);
    }

    if (
      event.allDay != null &&
      typeof event.allDay !== "boolean"
    ) {
      throw new Error(`Invalid allDay at event ${index}`);
    }

    if (
      event.category != null &&
      typeof event.category !== "string"
    ) {
      throw new Error(`Invalid category at event ${index}`);
    }

    return {
      id: event.id,
      title: event.title.trim(),
      description:
        typeof event.description === "string"
          ? event.description
          : null,
      location:
        typeof event.location === "string"
          ? event.location
          : null,
      start: event.start,
      end:
        typeof event.end === "string"
          ? event.end
          : null,
      allDay: event.allDay === true,
      category:
        typeof event.category === "string"
          ? event.category
          : null,
    };
  });
}

export async function discoverTanStackCalendar(
  pageUrl: string,
): Promise<TanStackCalendarDescriptor | null> {
  const parsed = new URL(pageUrl);

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      "TanStack discovery requires a public HTTPS page",
    );
  }

  const html = await readText(pageUrl, MAX_HTML_BYTES);
  const modules = moduleReferences(html, pageUrl);

  const loaded = new Map<string, string>();

  for (const url of modules) {
    try {
      loaded.set(
        url,
        await readText(url, MAX_MODULE_BYTES),
      );
    } catch {
      // Missing optional modules do not establish support.
    }
  }

  const matches: TanStackCalendarDescriptor[] = [];

  for (const [routeUrl, routeJs] of loaded) {
    /*
     * Match the wrapper declaration and the calendar query
     * together. This prevents unrelated reused minified
     * identifiers from being selected.
     */
    const query = routeJs.match(
      /(?:let|const|var)\s+(\w+)\s*=\s*(\w+)\s*\(\s*(\w+)\s*\)\s*,[\s\S]{0,250}?queryKey\s*:\s*\[\s*["'`]weekly-events["'`][\s\S]{0,180}?queryFn\s*:\s*\(\s*\)\s*=>\s*(\w+)\s*\(\s*\{\s*data\s*:/,
    );

    if (!query || query[1] !== query[4]) {
      continue;
    }

    const wrapperLocal = query[2];
    const serverFunctionLocal = query[3];

    for (const importMatch of routeJs.matchAll(
      /import\s*\{[^}]+\}\s*from\s*["']([^"']+\.js)["']/g,
    )) {
      const functionUrl = sameOriginAsset(
        importMatch[1],
        routeUrl,
      );

      if (!functionUrl) continue;

      const functionJs = loaded.get(functionUrl);

      if (!functionJs) continue;

      const moduleName =
        new URL(functionUrl).pathname.split("/").pop() ?? "";

      const bindings = importBindings(
        routeJs,
        moduleName,
      );

      const wrapperImported = bindings.some(
        (item) => item.local === wrapperLocal,
      );

      if (!wrapperImported) continue;

      const binding = bindings.find(
        (item) => item.local === serverFunctionLocal,
      );

      if (!binding) continue;

      const hash = resolvePostHash(
        functionJs,
        binding.imported,
      );

      if (!hash) continue;

      matches.push({
        pageUrl,
        routeModuleUrl: routeUrl,
        functionModuleUrl: functionUrl,
        functionHash: hash,
        method: "POST",
        queryKey: "weekly-events",
      });
    }
  }

  /*
   * Do not select an arbitrary handler if discovery is
   * ambiguous or incomplete.
   */
  if (matches.length !== 1) {
    return null;
  }

  return matches[0];
}

/**
 * Read-only TanStack calendar extraction.
 *
 * Discovery and Seroval decoding are verified separately.
 * This function does not persist, publish, or attribute events.
 */
export async function fetchTanStackSerovalEvents(
  sourceUrl: string,
): Promise<FirstPartyHarvestEvent[]> {
  const descriptor = await discoverTanStackCalendar(sourceUrl);

  if (!descriptor) {
    throw new Error(
      "No uniquely verified TanStack calendar function found",
    );
  }

  const now = new Date();
  const months = [0, 1].map((offset) => {
    const date = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1),
    );

    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth(),
    };
  });

  const byId = new Map<string, FirstPartyHarvestEvent>();

  for (const { year, month } of months) {
    /*
     * Seroval serialized request:
     * { data: { year, month } }
     *
     * The calendar uses JavaScript's zero-based month numbering.
     */
    const payload = {
      t: {
        t: 10,
        i: 0,
        p: {
          k: ["data"],
          v: [
            {
              t: 10,
              i: 1,
              p: {
                k: ["year", "month"],
                v: [
                  { t: 0, s: year },
                  { t: 0, s: month },
                ],
              },
              o: 0,
            },
          ],
        },
        o: 0,
      },
      f: 63,
      m: [],
    };

    const endpoint = new URL(
      `/_serverFn/${descriptor.functionHash}`,
      descriptor.pageUrl,
    );

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-tsr-serverFn": "true",
        "User-Agent": "TenderFans-Event-Harvester/1.0",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(
        `TanStack calendar query returned HTTP ${response.status}`,
      );
    }

    const declared = Number(
      response.headers.get("content-length") ?? 0,
    );

    if (declared > 1_000_000) {
      throw new Error("TanStack calendar response too large");
    }

    const reader = response.body?.getReader();

    if (!reader) {
      throw new Error("TanStack calendar response has no body");
    }

    const chunks: Uint8Array[] = [];
    let total = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        total += value.byteLength;

        if (total > 1_000_000) {
          throw new Error("TanStack calendar response too large");
        }

        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    const combined = new Uint8Array(total);
    let position = 0;

    for (const chunk of chunks) {
      combined.set(chunk, position);
      position += chunk.byteLength;
    }

    const raw = new TextDecoder().decode(combined);

    const decoded = decodeTanStackSeroval(JSON.parse(raw));

    const events = normalizeTanStackCalendarEvents(decoded);

    for (const event of events) {
      const key = event.id;

      if (byId.has(key)) continue;

      byId.set(key, {
        externalEventId: event.id,
        title: event.title,
        description: event.description,
        startsAt: event.start,
        endsAt: event.end,
        allDay: event.allDay,
        sourceUrl: descriptor.pageUrl,
        flyerUrl: null,
        location: event.location,
        venueName: null,
        venueAddress: null,
        rawPayload: {
          adapter: "tanstack_seroval_events",
          category: event.category,
          originalEvent: event,
        },
      });
    }
  }

  return [...byId.values()].sort(
    (a, b) => a.startsAt.localeCompare(b.startsAt),
  );
}
