import { getTransportRecoveryProxy } from "@/lib/event-harvester/transport-recovery-context";
import { chromium as playwright } from "playwright-core";
import Chromium from "@sparticuz/chromium";
import { getChromiumExecutablePath } from "./chromium-runtime";
import { withTransportPermit } from "../transport-capacity-permits";

export function isNonessentialBrowserResourceType(
  resourceType: string,
): boolean {
  return ["image", "font", "media"].includes(resourceType);
}

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

  const executeBrowser = (recoverySignal?: AbortSignal) =>
    withTransportPermit("browser", async (permitSignal) => {
      const combinedSignal = recoverySignal
        ? AbortSignal.any([permitSignal, recoverySignal])
        : permitSignal;
    combinedSignal.throwIfAborted();

    const browser = await playwright.launch({
    args: Chromium.args,
    executablePath: await getChromiumExecutablePath(),
    headless: true,
    timeout: 30000,
    ...(proxy ? { proxy } : {}),
  });

  const abortBrowser = () => {
    void browser.close().catch(() => {});
  };

  combinedSignal.addEventListener("abort", abortBrowser, {
    once: true,
  });

  try {
    combinedSignal.throwIfAborted();

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

    combinedSignal.throwIfAborted();

    return {
      requestedUrl: url,
      finalUrl,
      status: response?.status() ?? null,
      html,
      observedUrls: [...observedUrls],
      iframeUrls: [...new Set(iframeUrls)],
    };
  } finally {
    combinedSignal.removeEventListener("abort", abortBrowser);
    await browser.close();
  }
  }, recoverySignal);

  if (!proxyUrl) {
    return executeBrowser();
  }

  // Recovery is held outside browser capacity, avoiding circular wait.
  return withTransportPermit("recovery", async (recoverySignal) => {
    recoverySignal.throwIfAborted();
    return executeBrowser(recoverySignal);
  });
}


/*
 * Shared Tier 1 browser transport for client-rendered JSON endpoints.
 * Platform adapters supply only the endpoint predicate.
 * Browser ownership, resource filtering, and capacity are global.
 */
async function fetchBrowserJsonResponsesOnce(
  url: string,
  matchesEndpoint: (url: string) => boolean,
  proxyUrl?: string,
): Promise<{
  status: number | null;
  observedEndpoint: boolean;
  successfulResponse: boolean;
  payloads: unknown[];
}> {
  if (!isAllowedBrowserUrl(url) || new URL(url).protocol !== "https:") {
    throw new Error("Browser navigation requires a public HTTPS URL");
  }

  const executeBrowser = (recoverySignal?: AbortSignal) =>
    withTransportPermit("browser", async (permitSignal) => {
      const combinedSignal = recoverySignal
        ? AbortSignal.any([permitSignal, recoverySignal])
        : permitSignal;
    combinedSignal.throwIfAborted();

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

    const instance = await playwright.launch({
      args: Chromium.args,
      executablePath: await getChromiumExecutablePath(),
      headless: true,
      timeout: 30000,
      ...(proxy ? { proxy } : {}),
    });

    const abort = () => {
      void instance.close().catch(() => {});
    };

    combinedSignal.addEventListener("abort", abort, { once: true });

    try {
      combinedSignal.throwIfAborted();

      const page = await instance.newPage({
        viewport: { width: 1440, height: 1600 },
        userAgent: USER_AGENT,
      });

      await page.route("**/*", async (route) => {
        const request = route.request();

        if (
          !isAllowedBrowserUrl(request.url()) ||
          isNonessentialBrowserResourceType(request.resourceType())
        ) {
          await route.abort();
        } else {
          await route.continue();
        }
      });

      const payloads: unknown[] = [];
      const pending: Promise<void>[] = [];
      let observedEndpoint = false;
      let successfulResponse = false;

      page.on("response", (response) => {
        if (!matchesEndpoint(response.url())) return;

        observedEndpoint = true;

        const task = (async () => {
          if (!response.ok()) return;

          const value: unknown = await response.json();

          successfulResponse = true;
          payloads.push(value);
        })();

        pending.push(task);
      });

      const navigation = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      await page.waitForTimeout(5000);
      await Promise.all(pending);

      combinedSignal.throwIfAborted();

      return {
        status: navigation?.status() ?? null,
        observedEndpoint,
        successfulResponse,
        payloads,
      };
    } finally {
      combinedSignal.removeEventListener("abort", abort);
      await instance.close();
    }
  }, recoverySignal);

  if (!proxyUrl) {
    return executeBrowser();
  }

  // Acquire recovery capacity before browser capacity.
  // Never hold browser capacity while waiting for recovery.
  return withTransportPermit("recovery", async (recoverySignal) => {
    recoverySignal.throwIfAborted();
    return executeBrowser(recoverySignal);
  });
}

export async function fetchBrowserJsonResponses(
  url: string,
  matchesEndpoint: (url: string) => boolean,
): Promise<{
  status: number | null;
  observedEndpoint: boolean;
  successfulResponse: boolean;
  payloads: unknown[];
}> {
  const recoveryProxy = getTransportRecoveryProxy();

  let direct:
    | Awaited<ReturnType<typeof fetchBrowserJsonResponsesOnce>>
    | undefined;

  try {
    direct = await fetchBrowserJsonResponsesOnce(
      url,
      matchesEndpoint,
    );
  } catch (error) {
    // Capacity ownership and admission failures must never be
    // disguised as ordinary browser transport failures.
    if (
      error instanceof Error &&
      (
        error.name === "TransportCapacityUnavailableError" ||
        error.name === "TransportPermitOwnershipLostError" ||
        error.name === "BrowserOperationTimeoutError" ||
        error.name === "AbortError"
      )
    ) {
      throw error;
    }

    if (!recoveryProxy) throw error;
  }

  if (
    !recoveryProxy ||
    (
      direct &&
      direct.status !== null &&
      direct.status >= 200 &&
      direct.status < 300 &&
      direct.observedEndpoint &&
      direct.successfulResponse
    )
  ) {
    if (!direct) {
      throw new Error("Browser JSON observation returned no result.");
    }
    return direct;
  }

  try {
    const recovered = await fetchBrowserJsonResponsesOnce(
      url,
      matchesEndpoint,
      recoveryProxy,
    );

    if (
      recovered.status !== null &&
      recovered.status >= 200 &&
      recovered.status < 300 &&
      recovered.observedEndpoint &&
      recovered.successfulResponse
    ) {
      return recovered;
    }

    return direct ?? recovered;
  } catch (error) {
    if (
      error instanceof Error &&
      (
        error.name === "TransportCapacityUnavailableError" ||
        error.name === "TransportPermitOwnershipLostError" ||
        error.name === "BrowserOperationTimeoutError" ||
        error.name === "AbortError"
      )
    ) {
      throw error;
    }

    if (direct) return direct;
    throw error;
  }
}
