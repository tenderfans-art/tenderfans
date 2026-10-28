import {
  fetchSupabasePostgrestEvents,
  type PostgrestReadResult,
} from "./supabase-postgrest-events";

export type PublicPostgrestDiscovery = {
  apiUrl: string;
  anonKey: string;
  table: "events";
  inventory: PostgrestReadResult;
  bundleUrl: string;
};

const API_PATTERN =
  /https:\/\/[a-z0-9-]+\.supabase\.co/gi;

const JWT_PATTERN =
  /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

function sameOrigin(a: URL, b: URL): boolean {
  return a.origin === b.origin;
}

function scriptsFromHtml(
  html: string,
  pageUrl: URL,
): URL[] {
  const scripts: URL[] = [];

  for (
    const match of html.matchAll(
      /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi,
    )
  ) {
    try {
      const url = new URL(match[1], pageUrl);

      if (
        url.protocol === "https:" &&
        sameOrigin(url, pageUrl) &&
        !scripts.some(item => item.href === url.href)
      ) {
        scripts.push(url);
      }
    } catch {
      // Ignore invalid script URLs.
    }
  }

  return scripts.slice(0, 12);
}

async function readText(
  url: URL,
  maxBytes: number,
): Promise<string | null> {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/javascript,*/*;q=0.8",
    },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) return null;

  const declaredLength = Number(
    response.headers.get("content-length"),
  );

  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maxBytes
  ) {
    return null;
  }

  const text = await response.text();

  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return null;
  }

  return text;
}

/**
 * Read-only discovery of public Supabase PostgREST
 * event inventories exposed by a first-party website.
 *
 * Only same-origin JavaScript assets are inspected.
 * API candidates must return parseable event records.
 * The anon key is never logged by this module.
 */
export async function discoverPublicPostgrestEvents(
  websiteUrl: string,
): Promise<PublicPostgrestDiscovery | null> {
  const website = new URL(websiteUrl);

  if (website.protocol !== "https:") {
    return null;
  }

  const html = await readText(website, 1024 * 1024);

  if (!html) return null;

  const scripts = scriptsFromHtml(html, website);

  for (const script of scripts) {
    let javascript: string | null;

    try {
      javascript = await readText(
        script,
        2 * 1024 * 1024,
      );
    } catch {
      continue;
    }

    if (!javascript) continue;

    // Require evidence that the application actually
    // queries an events inventory.
    if (
      !/\.from\(["']events["']\)/.test(javascript)
    ) {
      continue;
    }

    const apiUrls = [
      ...new Set(javascript.match(API_PATTERN) ?? []),
    ];

    const anonKeys = [
      ...new Set(javascript.match(JWT_PATTERN) ?? []),
    ];

    for (const apiUrl of apiUrls) {
      for (const anonKey of anonKeys) {
        try {
          const inventory =
            await fetchSupabasePostgrestEvents({
              apiUrl,
              anonKey,
              table: "events",
            });

          // Empty arrays are not sufficient evidence
          // of a usable event source.
          if (
            inventory.totalRows === 0 ||
            inventory.events.length === 0
          ) {
            continue;
          }

          return {
            apiUrl,
            anonKey,
            table: "events",
            inventory,
            bundleUrl: script.href,
          };
        } catch {
          // Candidate is inaccessible or incompatible.
        }
      }
    }
  }

  return null;
}
