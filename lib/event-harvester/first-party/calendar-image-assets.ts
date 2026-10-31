import { getTransportRecoveryProxy } from "@/lib/event-harvester/transport-recovery-context";
import { signedHarvesterFetch } from "@/lib/event-harvester/signed-fetch";

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function normalizeAssetUrl(
  raw: string,
  pageUrl: string,
): string | null {
  try {
    const decoded = decodeHtml(raw.trim());

    if (!decoded) {
      return null;
    }

    const url = new URL(decoded, pageUrl);

    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Discover uploaded images whose asset identity strongly suggests
 * that they are event/calendar inventory.
 *
 * Keep this deterministic and transport-agnostic. The detector uses
 * it to classify a page; the calendar-image adapter can use the same
 * discovery rule when harvesting the page later.
 */
export function discoverCalendarImageAssets(
  html: string,
  pageUrl: string,
): string[] {
  const urls = new Set<string>();

  /*
   * Calendar identity is based on the uploaded asset,
   * not its website builder, CDN, or hosting provider.
   *
   * Keep ordinary event flyers and promotional photos
   * out of the calendar-image review pipeline.
   */
  const calendarIdentity =
    /(?:calendar|schedule|lineup)/i;

  const supportedImage =
    /\.(?:jpe?g|png|webp)(?:$|[?#])/i;

  const candidates: string[] = [];

  // Standard and lazy-loaded image attributes.
  for (const match of html.matchAll(
    /\b(?:src|data-src|data-srclazy|data-lazy-src|data-original|poster)=["']([^"']+)["']/gi,
  )) {
    candidates.push(match[1]);
  }

  // Responsive image renditions.
  for (const match of html.matchAll(
    /\b(?:srcset|data-srcset)=["']([^"']+)["']/gi,
  )) {
    for (const item of match[1].split(",")) {
      const candidate = item.trim().split(/\s+/)[0];
      if (candidate) candidates.push(candidate);
    }
  }

  // Images referenced by inline CSS.
  for (const match of html.matchAll(
    /url\(\s*["']?([^"')]+)["']?\s*\)/gi,
  )) {
    candidates.push(match[1]);
  }

  for (const raw of candidates) {
    const normalized = normalizeAssetUrl(raw, pageUrl);
    if (!normalized) continue;

    const url = new URL(normalized);

    let filename: string;
    try {
      filename = decodeURIComponent(
        url.pathname.split("/").pop() ?? "",
      );
    } catch {
      continue;
    }

    if (
      !supportedImage.test(url.pathname) ||
      !calendarIdentity.test(filename)
    ) {
      continue;
    }

    urls.add(normalized);
  }

  return [...urls];
}

export type CalendarImageAsset = {
  detectedUrl: string;
  resolvedUrl: string;
  contentType: string;
  bytes: Uint8Array;
  usedOriginalCandidate: boolean;
};

function deriveOriginalAssetCandidate(
  detectedUrl: string,
): string | null {
  try {
    const url = new URL(detectedUrl);

    /*
     * GoDaddy / Website Builder image transformations are appended
     * after "/:/". The path before that marker is the durable
     * uploaded asset.
     */
    if (
      /img1\.wsimg\.com$/i.test(url.hostname) &&
      url.pathname.includes("/:/")
    ) {
      const [originalPath] =
        url.pathname.split("/:/");

      if (originalPath) {
        url.pathname = originalPath;
        url.search = "";
        url.hash = "";
        return url.toString();
      }
    }

    /*
     * WordPress commonly inserts WIDTHxHEIGHT immediately before
     * the extension for generated image renditions.
     */
    if (
      /\/wp-content\/uploads\//i.test(url.pathname)
    ) {
      const originalPath =
        url.pathname.replace(
          /-\d{2,5}x\d{2,5}(?=\.(?:jpe?g|png|webp)$)/i,
          "",
        );

      if (originalPath !== url.pathname) {
        url.pathname = originalPath;
        url.search = "";
        url.hash = "";
        return url.toString();
      }
    }

    return null;
  } catch {
    return null;
  }
}

function isImageContentType(
  value: string | null,
): value is string {
  return Boolean(
    value &&
      /^image\/(?:jpeg|png|webp)(?:;|$)/i.test(value),
  );
}

const RECOVERY_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";

export async function fetchCalendarImageResource(
  url: string,
  accept: string,
): Promise<Response> {
  const proxy =
    (getTransportRecoveryProxy() !== undefined)
      ? getTransportRecoveryProxy()
      : undefined;

  async function request(proxyUrl?: string): Promise<Response> {
    return signedHarvesterFetch(
      url,
      {
        headers: {
          Accept: accept,
          "User-Agent": proxyUrl
            ? RECOVERY_USER_AGENT
            : "TenderFans Event Harvester/1.0",
          ...(proxyUrl
            ? { "Accept-Language": "en-US,en;q=0.9" }
            : {}),
        },
        cache: "no-store",
      },
      proxyUrl,
    );
  }

  let response: Response;

  try {
    response = await request();

    if (
      proxy &&
      [403, 429, 503].includes(response.status)
    ) {
      try {
        const recovered = await request(proxy);

        if (recovered.ok) {
          response = recovered;
        }
      } catch {
        // Preserve the original response.
      }
    }
  } catch (error) {
    if (!proxy) {
      throw error;
    }

    response = await request(proxy);
  }

  return response;
}

async function fetchImageAsset(
  url: string,
): Promise<{
  url: string;
  contentType: string;
  bytes: Uint8Array;
} | null> {
  try {
    const response = await fetchCalendarImageResource(
      url,
      "image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8",
    );

    const contentType =
      response.headers.get("content-type");

    if (
      !response.ok ||
      !isImageContentType(contentType)
    ) {
      return null;
    }

    const buffer =
      await response.arrayBuffer();

    if (buffer.byteLength === 0) {
      return null;
    }

    return {
      url: response.url || url,
      contentType:
        contentType.split(";")[0].trim(),
      bytes: new Uint8Array(buffer),
    };
  } catch {
    return null;
  }
}

/**
 * Acquire the best deterministic rendition available for a detected
 * calendar image. Prefer a recoverable original upload when it
 * validates as an image; otherwise safely fall back to the exact
 * rendition discovered on the page.
 */
export async function acquireCalendarImageAsset(
  detectedUrl: string,
): Promise<CalendarImageAsset> {
  const originalCandidate =
    deriveOriginalAssetCandidate(
      detectedUrl,
    );

  if (
    originalCandidate &&
    originalCandidate !== detectedUrl
  ) {
    const original =
      await fetchImageAsset(
        originalCandidate,
      );

    if (original) {
      return {
        detectedUrl,
        resolvedUrl: original.url,
        contentType: original.contentType,
        bytes: original.bytes,
        usedOriginalCandidate: true,
      };
    }
  }

  const detected =
    await fetchImageAsset(detectedUrl);

  if (!detected) {
    throw new Error(
      `Calendar image asset could not be fetched as a supported image: ${detectedUrl}`,
    );
  }

  return {
    detectedUrl,
    resolvedUrl: detected.url,
    contentType: detected.contentType,
    bytes: detected.bytes,
    usedOriginalCandidate: false,
  };
}
