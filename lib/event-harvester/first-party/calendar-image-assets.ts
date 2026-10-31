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
  const matches = [
    ...html.matchAll(
      /(?:src|data-src|data-srclazy)=["']([^"']*(?:(?:wp-content\/uploads|\/uploads\/)|img1\.wsimg\.com\/isteam\/)[^"']*(?:calendar|entertainment|live(?:%20|[-_ ])?music|events?|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[-_ ]?[0-9]{2,4}|(?:^|[-_\/])(?:0?[1-9]|1[0-2])[-_](?:20[0-9]{2}))[^"']*\.(?:jpe?g|png|webp)(?:(?:\/:\/)[^"']*|\?[^"']*)?)["']/gi,
    ),
  ];

  const urls = new Set<string>();

  for (const match of matches) {
    const normalized = normalizeAssetUrl(
      match[1],
      pageUrl,
    );

    if (normalized) {
      urls.add(normalized);
    }
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
