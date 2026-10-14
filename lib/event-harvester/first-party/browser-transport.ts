import { chromium as playwright } from "playwright-core";
import Chromium from "@sparticuz/chromium";

const USER_AGENT = "TenderFans Event Harvester/1.0";

const MAX_BROWSER_HTML_BYTES = 2_000_000;
const MAX_OBSERVED_URLS = 500;

function isAllowedBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\\.$/, "");

    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (url.username || url.password) return false;

    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host.endsWith(".test") ||
      host.endsWith(".invalid")
    ) return false;

    if (
      /^127\\./.test(host) ||
      /^10\\./.test(host) ||
      /^192\\.168\\./.test(host) ||
      /^169\\.254\\./.test(host) ||
      /^172\\.(1[6-9]|2[0-9]|3[01])\\./.test(host) ||
      host === "0.0.0.0" ||
      host === "[::1]"
    ) return false;

    return true;
  } catch {
    return false;
  }
}

export type BrowserPageEvidence = {
  requestedUrl: string;
  finalUrl: string;
  status: number | null;
  html: string;
  observedUrls: string[];
  iframeUrls: string[];
};

function keepObservedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function fetchBrowserEvidence(
  url: string,
  proxyUrl?: string,
): Promise<BrowserPageEvidence> {
  if (!isAllowedBrowserUrl(url) || new URL(url).protocol !== "https:") {
    throw new Error("Browser navigation requires a public HTTPS URL");
  }

  const proxy = proxyUrl
    ? (() => {
        const parsed = new URL(proxyUrl);

        if (!["http:", "https:"].includes(parsed.protocol)) {
          throw new Error("Unsupported browser proxy protocol");
        }

        return {
          server: `${parsed.protocol}//${parsed.host}`,
          username: decodeURIComponent(parsed.username),
          password: decodeURIComponent(parsed.password),
        };
      })()
    : undefined;

  const browser = await playwright.launch({
    args: Chromium.args,
    executablePath: await Chromium.executablePath(),
    headless: true,
    ...(proxy ? { proxy } : {}),
  });

  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1600 },
      userAgent: USER_AGENT,
    });

    await page.route("**/*", async (route) => {
      if (!isAllowedBrowserUrl(route.request().url())) {
        await route.abort();
        return;
      }
      await route.continue();
    });

    const observedUrls = new Set<string>();

    page.on("request", (request) => {
      const requestUrl = request.url();

      if (
        observedUrls.size < MAX_OBSERVED_URLS &&
        keepObservedUrl(requestUrl) &&
        isAllowedBrowserUrl(requestUrl)
      ) {
        observedUrls.add(requestUrl);
      }
    });

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    /*
     * Allow client-side event widgets to initialize without relying on
     * networkidle, since analytics, ads, streams, and other long-lived
     * requests can keep otherwise usable pages perpetually active.
     */
    await page.waitForTimeout(5000);

    const finalUrl = page.url();
    const html = await page.content();

    if (Buffer.byteLength(html, "utf8") > MAX_BROWSER_HTML_BYTES) {
      throw new Error("Browser HTML exceeded size limit");
    }

    const iframeUrls = page
      .frames()
      .map((frame) => frame.url())
      .filter(
        (frameUrl) =>
          frameUrl !== finalUrl &&
          frameUrl !== "about:blank" &&
          keepObservedUrl(frameUrl),
      );

    return {
      requestedUrl: url,
      finalUrl,
      status: response?.status() ?? null,
      html,
      observedUrls: [...observedUrls],
      iframeUrls: [...new Set(iframeUrls)],
    };
  } finally {
    await browser.close();
  }
}
