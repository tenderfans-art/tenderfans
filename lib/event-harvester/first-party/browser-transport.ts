import { chromium as playwright } from "playwright-core";
import Chromium from "@sparticuz/chromium";

const USER_AGENT = "TenderFans Event Harvester/1.0";

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
): Promise<BrowserPageEvidence> {
  const browser = await playwright.launch({
    args: Chromium.args,
    executablePath: await Chromium.executablePath(),
    headless: true,
  });

  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1600 },
      userAgent: USER_AGENT,
    });

    const observedUrls = new Set<string>();

    page.on("request", (request) => {
      const requestUrl = request.url();

      if (keepObservedUrl(requestUrl)) {
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
