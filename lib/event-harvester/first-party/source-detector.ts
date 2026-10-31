import { isGoTonightProfileUrl } from "./gotonight-events";
import { inspectToastDigitalStorefront } from "./toast-digital-storefront";
import { inspectSquareOnline } from "./square-online-events";
import { parseMetadataRecurringSchedule } from "./html-metadata-recurring";
import { isVerificationInterstitial } from "../access-challenge";
import { hasParseableGoDaddyRecurringItems } from "./godaddy-menu-recurring";
import { hasParseableWordPressCategoryEvents } from "./wordpress-category-events";
import { getTransportRecoveryProxy } from "@/lib/event-harvester/transport-recovery-context";
import { AsyncLocalStorage } from "node:async_hooks";

const preferredProxyContext = new AsyncLocalStorage<boolean>();

export function runWithPreferredFirstPartyProxy<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return preferredProxyContext.run(true, operation);
}
import { signedHarvesterFetch } from "@/lib/event-harvester/signed-fetch";
import { fetchBrowserEvidence } from "./browser-transport";
import { discoverCalendarImageAssets } from "./calendar-image-assets";
import { extractHtmlEventsWithDiagnostics } from "./html-events";
import { discoverTanStackCalendar } from "./tanstack-seroval-events";
import { discoverPublicPostgrestEvents } from "./supabase-postgrest-discovery";

export type DetectedSourceType =
  | "supabase_postgrest_events"
  | "gotonight_events"
  | "eventbrite_organizer"
  | "html_metadata_recurring"
  | "godaddy_menu_recurring"
  | "cp_multi_view_calendar"
  | "uvtix_events"
  | "schema_org_events"
  | "html_events"
  | "html_error"
  | "pwpc_events_calendar"
  | "toast_digital_storefront"
  | "square_online_events"
  | "shopify_events"
  | "woocommerce_events"
  | "calendar_image"
  | "eventscalendar_events"
  | "sociablekit_facebook_events"
  | "browser_required"
  | "spothopper_events"
  | "shared_event_calendar"
  | "squarespace_events"
  | "tribe_rest"
  | "next_rsc_events"
  | "tanstack_seroval_events"
  | "google_calendar"
  | "simcal_events"
  | "google_apps_script_events"
  | "beatgig_events"
  | "bandzoogle_events"
  | "ics"
  | "wordpress_ajax_events"
  | "eventer_events"
  | "ticket_spot_events"
  | "wordpress_category_events"
  | "wordpress_event_feed"
  | "timely"
  | "facebook"
  | "linktree"
  | "unknown";

export type SourceDetection = {
  sourceType: DetectedSourceType;
  url: string;
  confidence: "high" | "medium" | "low";
  /**
   * True when TenderFans has an implemented adapter capable of
   * attempting this source type. This does NOT prove that the
   * particular detected source has been validated for the Spot,
   * nor that it currently contains publishable inventory.
   */
  adapterAvailable: boolean;

  /**
   * Legacy compatibility field. For now this mirrors
   * adapterAvailable so existing scanner/reporting code keeps
   * working while source validation is introduced separately.
   */
  supported: boolean;
  evidence: string[];
};

export type DiscoveredEventPage = {
  url: string;
  linkText: string;
  sameSite: boolean;
  fetched: boolean;
  httpStatus: number | null;
  finalUrl: string | null;
  htmlBytes: number | null;
};

export type RedirectDestinationIdentity = {
  name: string;
  streetAddress: string | null;
  city: string | null;
  stateRegion: string | null;
  postalCode: string | null;
  source: "json_ld" | "website_json_ld";
};

export type BrowserExecutionOutcome = {
  url: string;
  ok: boolean;
  error: string | null;
};

export type SiteDetectionResult = {
  browserOutcomes?: BrowserExecutionOutcome[];
  challengeEvidence?: string[];
  redirectIdentities?: RedirectDestinationIdentity[];
  websiteUrl: string;
  fetchedUrl: string | null;
  status:
    | "detected"
    | "challenge_encountered"
    | "transport_blocked"
    | "transport_failed"
    | "external_redirect"
    | "no_event_source";
  pagesInspected: number;
  discoveredEventPages: DiscoveredEventPage[];
  detections: SourceDetection[];
  error: string | null;
};

/** Positive access-challenge signatures only; HTTP 403 alone is insufficient. */
function identifyAccessChallenge(
  finalUrl: string,
  html: string,
  status: number | null,
): string[] {
  const evidence: string[] = [];
  let path = "";
  let host = "";

  try {
    const parsed = new URL(finalUrl);
    path = parsed.pathname.toLowerCase();
    host = parsed.hostname.toLowerCase();
  } catch {
    // HTML evidence can still identify a challenge.
  }

  if (
    path.includes("/.well-known/sgcaptcha/") ||
    (/<title[^>]*>\s*robot challenge screen\s*<\/title>/i.test(html) &&
      /sgcaptcha|siteground/i.test(html))
  ) {
    evidence.push("Provider: SiteGround; robot challenge / sgcaptcha");
  }

  if (
    path.startsWith("/cdn-cgi/challenge-platform/") ||
    /<script[^>]+cdn-cgi\/challenge-platform\//i.test(html) ||
    (/cf-chl-(?:opt|widget|token)/i.test(html) &&
      /cloudflare|challenge-platform/i.test(html)) ||
    isVerificationInterstitial(html)
  ) {
    evidence.push("Provider: Cloudflare; challenge-platform signature");
  }

  if (
    host === "geo.captcha-delivery.com" ||
    host === "captcha-delivery.com" ||
    (/datadome/i.test(html) &&
      /captcha-delivery\.com|datadome\.co\/captcha|dd\.captcha/i.test(html))
  ) {
    evidence.push("Provider: DataDome; challenge delivery signature");
  }

  if (evidence.length > 0) {
    evidence.push(`HTTP status: ${status ?? "unknown"}`);
    evidence.push(`Final URL: ${finalUrl}`);
  }

  return evidence;
}

const USER_AGENT = "TenderFans Event Harvester/1.0";
const RECOVERY_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";

const EVENT_HINT =
  /\b(events?|calendar|live[-\s]?music|music|entertainment|shows?|what'?s[-\s]?on|things[-\s]?to[-\s]?do)\b/i;

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(raw: string, base: string): string | null {
  try {
    const decoded = decodeHtml(raw.trim());

    if (
      !decoded ||
      decoded.startsWith("#") ||
      decoded.startsWith("mailto:") ||
      decoded.startsWith("tel:") ||
      decoded.startsWith("javascript:")
    ) {
      return null;
    }

    const url = new URL(decoded, base);

    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }

    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function hostname(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function sameSite(a: string, b: string): boolean {
  const ah = hostname(a);
  const bh = hostname(b);

  return ah === bh || ah.endsWith(`.${bh}`) || bh.endsWith(`.${ah}`);
}

function discoverLinks(
  html: string,
  pageUrl: string,
): Array<{
  url: string;
  text: string;
}> {
  const links = new Map<string, { url: string; text: string }>();

  const anchorPattern =
    /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;

  while ((match = anchorPattern.exec(html))) {
    const url = normalizeUrl(match[2], pageUrl);

    if (!url) {
      continue;
    }

    const text = stripTags(match[3]);

    const knownEventProvider =
      (/(?:eventbrite\.com|uvtix\.com|urvenue\.com)/i.test(url) || isGoTonightProfileUrl(url));

    if (EVENT_HINT.test(text) || EVENT_HINT.test(url) || knownEventProvider) {
      links.set(url, { url, text });
    }
  }

  /*
   * Event titles may lack generic keywords. Include direct children
   * of navigation items labeled Events, but not deeper descendants.
   * Track HTML nesting instead of matching nested lists with regex.
   */
  const tags = /<\/?(?:li|ul|a)\b[^>]*>/gi;
  const stack: Array<{
    tag: string;
    start: number;
    eventMenu: boolean;
    eventList: boolean;
    directItem: boolean;
    href: string | null;
  }> = [];

  let tagMatch: RegExpExecArray | null;

  while ((tagMatch = tags.exec(html))) {
    const token = tagMatch[0];
    const tag = /^<\/?([a-z]+)/i.exec(token)?.[1]?.toLowerCase();

    if (!tag) continue;

    const closing = /^<\//.test(token);

    if (closing) {
      const node = stack.pop();
      if (!node || node.tag !== tag) continue;

      if (tag === "a" && node.href) {
        const label = stripTags(
          html.slice(node.start, tagMatch.index),
        ).trim();

        const parent = stack[stack.length - 1];

        if (parent?.tag === "li" && EVENT_HINT.test(label) &&
            /^events?$/i.test(label)) {
          parent.eventMenu = true;
        }

        if (parent?.directItem) {
          const url = normalizeUrl(node.href, pageUrl);
          if (url && !links.has(url)) {
            links.set(url, { url, text: label });
          }
        }
      }

      continue;
    }

    const parent = stack[stack.length - 1];

    const href =
      tag === "a"
        ? /\bhref\s*=\s*(["'])(.*?)\1/i.exec(token)?.[2] ?? null
        : null;

    stack.push({
      tag,
      start: tags.lastIndex,
      eventMenu: false,
      eventList:
        tag === "ul" && parent?.tag === "li" &&
        parent.eventMenu === true,
      directItem:
        tag === "li" && parent?.tag === "ul" &&
        parent.eventList === true,
      href,
    });
  }

  return [...links.values()];
}

function normalizeFacebookPageUrl(
  candidateUrl: string,
): string | null {
  let parsed: URL;

  try {
    parsed = new URL(candidateUrl);
  } catch {
    return null;
  }

  let host = parsed.hostname.toLowerCase();

  if (host !== "facebook.com" && !host.endsWith(".facebook.com")) {
    return null;
  }

  // Facebook outbound-link redirectors identify the destination,
  // not the Spot's Facebook Page.
  if (host === "l.facebook.com" || host === "lm.facebook.com") {
    return null;
  }

  // Some Facebook links force authentication before redirecting to
  // the actual Page. Recover that Page identity from `next`.
  if (parsed.pathname.toLowerCase().startsWith("/login")) {
    const next = parsed.searchParams.get("next");

    if (!next) {
      return null;
    }

    try {
      parsed = new URL(next);
    } catch {
      return null;
    }

    host = parsed.hostname.toLowerCase();

    if (host !== "facebook.com" && !host.endsWith(".facebook.com")) {
      return null;
    }

    if (host === "l.facebook.com" || host === "lm.facebook.com") {
      return null;
    }
  }

  const path = parsed.pathname.toLowerCase();

  // Facebook utilities are not venue/Page identities.
  if (
    path === "/" ||
    path === "" ||
    path.startsWith("/sharer") ||
    path.startsWith("/share") ||
    path.startsWith("/dialog/") ||
    path.startsWith("/plugins/") ||
    path.startsWith("/login") ||
    path.startsWith("/help") ||
    path === "/docs" ||
    path.startsWith("/docs/")
  ) {
    return null;
  }

  // Canonicalize Facebook host/protocol while retaining Page identity.
  parsed.protocol = "https:";
  parsed.hostname = "www.facebook.com";
  parsed.port = "";
  parsed.hash = "";

  // profile.php uses `id` as part of the Page identity. Everything
  // else we've observed here is tracking/referral metadata.
  if (path === "/profile.php") {
    const id = parsed.searchParams.get("id");

    if (!id) {
      return null;
    }

    parsed.search = "";
    parsed.searchParams.set("id", id);
  } else {
    parsed.search = "";
  }

  return parsed.toString();
}

function discoverFacebookUrl(
  html: string,
  pageUrl: string,
): string | null {
  const anchorPattern =
    /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>/gi;

  let match: RegExpExecArray | null;

  while ((match = anchorPattern.exec(html))) {
    const url = normalizeUrl(match[2], pageUrl);

    if (!url) {
      continue;
    }

    const facebookUrl = normalizeFacebookPageUrl(url);

    if (facebookUrl) {
      return facebookUrl;
    }
  }

  return null;
}
function extractSitemapLocations(xml: string, baseUrl: string): string[] {
  const urls = new Set<string>();

  for (const match of xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)) {
    const raw = stripTags(match[1]);
    const url = normalizeUrl(raw, baseUrl);

    if (url) {
      urls.add(url);
    }
  }

  return [...urls];
}

function extractRobotsSitemaps(robots: string, baseUrl: string): string[] {
  const urls = new Set<string>();

  for (const line of robots.split(/\r?\n/)) {
    const match = line.match(/^\s*sitemap\s*:\s*(.+?)\s*$/i);

    if (!match) {
      continue;
    }

    const url = normalizeUrl(match[1], baseUrl);

    if (url) {
      urls.add(url);
    }
  }

  return [...urls];
}

function withinHomepagePathScope(
  candidateUrl: string,
  homepageUrl: string,
): boolean {
  try {
    const homepage = new URL(homepageUrl);
    const candidate = new URL(candidateUrl);

    const homeSegments = homepage.pathname.split("/").filter(Boolean);

    /*
     * A root-hosted website owns the host and therefore has
     * no narrower path scope to enforce.
     */
    if (homeSegments.length === 0) {
      return true;
    }

    const candidateSegments = candidate.pathname.split("/").filter(Boolean);

    return (
      candidateSegments.length > 0 &&
      candidateSegments[0].toLowerCase() === homeSegments[0].toLowerCase()
    );
  } catch {
    return false;
  }
}

async function discoverSecondaryEventLinks(homepageUrl: string): Promise<
  Array<{
    url: string;
    text: string;
  }>
> {
  const discovered = new Map<string, { url: string; text: string }>();

  const sitemapUrls = new Set<string>();

  /*
   * First use the site's declared sitemap locations.
   * If robots.txt is unavailable or declares none, also
   * try the conventional sitemap.xml location.
   */
  try {
    const robotsUrl = new URL("/robots.txt", homepageUrl).toString();

    const robots = await fetchHtml(robotsUrl);

    if (robots.ok) {
      for (const url of extractRobotsSitemaps(robots.html, robots.url)) {
        sitemapUrls.add(url);
      }
    }
  } catch {
    // Secondary discovery is best-effort.
  }

  try {
    sitemapUrls.add(new URL("/sitemap.xml", homepageUrl).toString());
  } catch {
    // Invalid homepage URL is already handled upstream.
  }

  /*
   * A sitemap may itself be a sitemap index. Follow a
   * small number of same-site child sitemaps, then look
   * for URLs whose paths provide event-surface evidence.
   */
  const sitemapQueue = [...sitemapUrls];
  const visitedSitemaps = new Set<string>();

  while (
    sitemapQueue.length > 0 &&
    visitedSitemaps.size < 8 &&
    discovered.size < 8
  ) {
    const sitemapUrl = sitemapQueue.shift()!;

    if (visitedSitemaps.has(sitemapUrl) || !sameSite(sitemapUrl, homepageUrl)) {
      continue;
    }

    visitedSitemaps.add(sitemapUrl);

    try {
      const sitemap = await fetchHtml(sitemapUrl);

      if (!sitemap.ok) {
        continue;
      }

      for (const url of extractSitemapLocations(sitemap.html, sitemap.url)) {
        if (!sameSite(url, homepageUrl)) {
          continue;
        }

        if (
          /\.xml(?:$|\?)/i.test(url) &&
          visitedSitemaps.size + sitemapQueue.length < 8
        ) {
          sitemapQueue.push(url);
          continue;
        }

        if (
          EVENT_HINT.test(url) &&
          withinHomepagePathScope(url, homepageUrl) &&
          discovered.size < 8
        ) {
          discovered.set(url, {
            url,
            text: "Discovered from sitemap",
          });
        }
      }
    } catch {
      // One inaccessible sitemap does not fail the site.
    }
  }

  return [...discovered.values()];
}

function pushDetection(
  detections: SourceDetection[],
  detection: SourceDetection,
) {
  const existing = detections.find(
    (item) =>
      item.sourceType === detection.sourceType &&
      item.url === detection.url,
  );

  if (!existing) {
    detections.push(detection);
    return;
  }

  const confidenceRank = {
    low: 1,
    medium: 2,
    high: 3,
  } as const;

  if (
    confidenceRank[detection.confidence] > confidenceRank[existing.confidence]
  ) {
    existing.confidence = detection.confidence;
  }

  existing.adapterAvailable =
    existing.adapterAvailable || detection.adapterAvailable;

  // Legacy compatibility: supported currently mirrors adapterAvailable.
  existing.supported = existing.adapterAvailable;

  for (const evidence of detection.evidence) {
    if (!existing.evidence.includes(evidence)) {
      existing.evidence.push(evidence);
    }
  }
}

function inspectObservedBrowserUrl(
  value: string,
  detections: SourceDetection[],
): void {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return;
  }

  if (
    url.hostname.toLowerCase() === "inffuse.eventscalendar.co" &&
    /^\/api\/v0\.1\/projects\/[^/]+\/data\/public\/events\/?$/i.test(
      url.pathname,
    ) &&
    url.searchParams.get("app") === "calendar"
  ) {
    pushDetection(detections, {
      sourceType: "eventscalendar_events",
      url: url.toString(),
      confidence: "high",
      adapterAvailable: true,
      supported: true,
      evidence: [
        "EventsCalendar.co public events API observed during browser execution",
      ],
    });
  }

  /*
   * Some first-party event surfaces only expose their Google Calendar
   * embed after browser execution. Preserve the embed URL here, just as
   * inspectPage() does for a statically visible embed; the existing
   * Google Calendar adapter owns conversion to the public ICS endpoint.
   */
  if (
    url.hostname.toLowerCase() === "calendar.google.com" &&
    /^\/calendar\/embed\/?$/i.test(url.pathname) &&
    url.searchParams.get("src")
  ) {
    pushDetection(detections, {
      sourceType: "google_calendar",
      url: url.toString(),
      confidence: "high",
      adapterAvailable: true,
      supported: true,
      evidence: [
        "Google Calendar embed observed during browser execution",
      ],
    });
  }

  if (
    url.hostname.toLowerCase() ===
      "data.accentapi.com" &&
    /^\/feed\/\d+\.json$/i.test(
      url.pathname,
    )
  ) {
    /*
     * SociableKIT appends a nocache value while loading the widget.
     * Store the durable public feed URL rather than a transient request.
     */
    url.searchParams.delete("nocache");

    pushDetection(detections, {
      sourceType:
        "sociablekit_facebook_events",
      url: url.toString(),
      confidence: "high",
      adapterAvailable: true,
      supported: true,
      evidence: [
        "SociableKIT Facebook Page Events public feed observed during browser execution",
      ],
    });
  }
}

/*
 * Popmenu renders an explicit empty inventory inside its calendar.
 * The sitewide Apollo state alone is not calendar evidence.
 * A static shell, challenge page, or unrelated "no events" text
 * must never qualify as a validated source.
 */
function isConfirmedEmptyPopmenuCalendar(html: string): boolean {
  return (
    /pm-calendar-event-section-wrapper/i.test(html) &&
    /NO\s+UPCOMING\s+EVENTS/i.test(
      html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ")
    ) &&
    !/pm-calendar-event-card-wrapper/i.test(html)
  );
}

function inspectPage(
  html: string,
  pageUrl: string,
  detections: SourceDetection[],
) {
  const lower = html.toLowerCase();

  /*
   * Popmenu's static calendar shell does not contain the
   * client-rendered event cards. Use the existing browser
   * resolution path; do not register an unverified source.
   */
  if (
    /pm-calendar-event-section-wrapper/i.test(html) &&
    !/pm-calendar-event-card-wrapper/i.test(html) &&
    !isConfirmedEmptyPopmenuCalendar(html)
  ) {
    pushDetection(detections, {
      sourceType: "browser_required",
      url: pageUrl,
      confidence: "high",
      adapterAvailable: false,
      supported: false,
      evidence: ["Popmenu calendar requires client-side rendering"],
    });
  }

  /*
   * Ticket Spot embeds its Wix event viewer on first-party pages.
   * The widget loads event inventory through its authenticated
   * runtime API. Preserve the first-party page as the source URL;
   * the adapter obtains the session through browser execution.
   */
  const ticketSpotIframe =
    /<iframe\b[^>]*\b(?:title|aria-label)\s*=\s*["']Ticket Spot["'][^>]*>/i.test(
      html,
    );

  if (ticketSpotIframe) {
    pushDetection(detections, {
      sourceType: "ticket_spot_events",
      url: pageUrl,
      confidence: "high",
      adapterAvailable: true,
      supported: true,
      evidence: [
        "Ticket Spot event viewer embedded on first-party website",
        "Ticket Spot browser-backed events adapter available",
      ],
    });
  }

  /*
   * EventsCalendar.co can be installed as a Wix runtime widget whose
   * project configuration is supplied client-side. The server HTML
   * exposes the widget registration but not a harvestable source.
   * Browser execution is therefore required for source discovery.
   */
  const eventsCalendarRuntimeMatch =
    /plugin\.eventscalendar\.co\/widget\.html/i.test(
      html.replace(/\\\//g, "/"),
    );

  if (eventsCalendarRuntimeMatch) {
    pushDetection(detections, {
      sourceType: "browser_required",
      url: pageUrl,
      confidence: "high",
      adapterAvailable: false,
      supported: false,
      evidence: [
        "EventsCalendar.co runtime widget detected",
        "Browser execution required to obtain runtime event-source configuration",
      ],
    });
  }

  /*
   * Google Calendar is commonly embedded as an iframe rather
   * than exposed through an ordinary anchor. discoverLinks()
   * intentionally handles anchors only, so recognize the
   * provider directly from the page HTML here.
   *
   * Preserve the discovered embed URL. The Google Calendar
   * adapter owns conversion from that URL to the public ICS
   * endpoint.
   */
  const googleCalendarEmbedMatch = html.match(
    /https?:\\?\/\\?\/(?:(?:www|calendar)\\?\.)?google\\?\.com\\?\/calendar\\?\/embed\?[^"'<>\\\s]*\bsrc=[^"'<>\\\s&]+[^"'<>\\\s]*/i,
  );

  if (googleCalendarEmbedMatch) {
    const googleCalendarUrl = decodeHtml(
      googleCalendarEmbedMatch[0]
        .replace(/\\\//g, "/")
        .replace(/\\u0026/gi, "&"),
    );

    pushDetection(detections, {
      sourceType: "google_calendar",
      url: googleCalendarUrl,
      confidence: "high",
      adapterAvailable: true,
      supported: true,
      evidence: [
        "Google Calendar embed found on first-party event surface",
      ],
    });
  }


  /*
   * Google Apps Script web apps may be embedded directly or inside
   * an iframe srcDoc attribute. Keep the actual /exec endpoint as
   * the source identity, not the containing first-party page.
   *
   * Only recognize URLs associated with iframe src attributes.
   */
  const appsScriptEndpoints = new Set<string>();

  const appsScriptUrlPattern =
    /https?:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec\/?(?:\?[^"'<>\s\\]*)?/gi;

  for (const match of html.matchAll(appsScriptUrlPattern)) {
    const rawUrl = match[0];
    const before = html.slice(
      Math.max(0, match.index! - 1500),
      match.index!,
    );

    const iframeStart = Math.max(
      before.toLowerCase().lastIndexOf("<iframe"),
      before.toLowerCase().lastIndexOf("&lt;iframe"),
    );

    if (iframeStart < 0) continue;

    const iframeContext = before.slice(iframeStart);

    // The endpoint must be the iframe src, not an unrelated link
    // or JavaScript URL inside the same surrounding markup.
    if (!/\bsrc\s*=\s*(?:\\?["']|&quot;|&#34;)?\s*$/i.test(
      iframeContext,
    )) {
      continue;
    }

    try {
      const parsed = new URL(decodeHtml(rawUrl));
      if (
        parsed.hostname === "script.google.com" &&
        /^\/macros\/s\/[^/]+\/exec\/?$/.test(parsed.pathname)
      ) {
        appsScriptEndpoints.add(parsed.toString());
      }
    } catch {
      // Ignore malformed iframe URLs.
    }
  }

  for (const endpoint of appsScriptEndpoints) {
    pushDetection(detections, {
      sourceType: "google_apps_script_events",
      url: endpoint,
      confidence: "high",
      adapterAvailable: true,
      supported: true,
      evidence: [
        "Google Apps Script web app embedded in first-party iframe",
      ],
    });
  }

  /*
   * Bandzoogle exposes its native calendar directly in first-party
   * HTML. The calendar feature ID identifies the server-rendered
   * Turbo inventory surface, while event/occurrence IDs identify
   * individual scheduled occurrences.
   */
  const bandzoogleCalendarMatch =
    html.match(
      /\bclass=["'][^"']*\bcalendar_feature\b[^"']*["'][^>]*\bdata-feature-id=["'](\d+)["']/i,
    ) ??
    html.match(
      /\bdata-feature-id=["'](\d+)["'][^>]*\bclass=["'][^"']*\bcalendar_feature\b/i,
    ) ??
    html.match(
      /\bid=["']calendar_feature_(\d+)["']/i,
    );

  const hasBandzoogleOccurrence =
    /\bdata-event-id=["']\d+["'][^>]*\bdata-occurrence-id=["']\d+["']/i.test(
      html,
    );

  /*
   * Bandzoogle event detail routes can embed the same calendar
   * feature markup as the inventory page. They are event records,
   * not independent calendar inventory sources.
   *
   * Continue inspecting these pages for every other source type.
   */
  const isBandzoogleEventDetailPage =
    /\/event\/\d+\/\d+(?:\/|$)/i.test(
      new URL(pageUrl).pathname
    );

  if (
    bandzoogleCalendarMatch &&
    hasBandzoogleOccurrence &&
    !isBandzoogleEventDetailPage
  ) {
    pushDetection(detections, {
      sourceType: "bandzoogle_events",
      url: pageUrl,
      confidence: "high",
      adapterAvailable: true,
      supported: true,
      evidence: [
        "Bandzoogle native calendar feature found on first-party event surface",
        "Bandzoogle event and occurrence IDs exposed by calendar inventory",
      ],
    });
  }

  /*
   * Dusk is BeatGig's public venue-calendar embed. BeatGig currently
   * exposes the venue slug through data-beatgig-venue-slug; retain the
   * older data-venue-slug form for compatibility with existing embeds.
   */
  const hasDuskVenueCalendar =
    /https?:\\?\/\\?\/(?:www\\?\.)?dusk\\?\.fm\\?\/iframe\\?\/venue-calendar/i.test(
      html,
    ) ||
    /https?:\\?\/\\?\/(?:www\\?\.)?dusk\\?\.fm\\?\/embed\\?\/venue-calendar/i.test(
      html,
    );

  const beatGigVenueSlugMatch =
    html.match(
      /\bdata-beatgig-venue-slug\s*=\s*(["'])([^"']+)\1/i,
    ) ??
    html.match(
      /\bdata-venue-slug\s*=\s*(["'])([^"']+)\1/i,
    ) ??
    html.match(
      /["']data-beatgig-venue-slug["']\s*:\s*["']([^"']+)["']/i,
    ) ??
    html.match(
      /["']data-venue-slug["']\s*:\s*["']([^"']+)["']/i,
    );

  const beatGigVenueSlug =
    beatGigVenueSlugMatch?.[2] ??
    beatGigVenueSlugMatch?.[1] ??
    null;

  if (hasDuskVenueCalendar && beatGigVenueSlug) {
    const beatGigSourceUrl =
      `https://dusk.fm/embed/venue-calendar/${encodeURIComponent(
        decodeHtml(beatGigVenueSlug),
      )}`;

    pushDetection(detections, {
      sourceType: "beatgig_events",
      url: beatGigSourceUrl,
      confidence: "high",
      adapterAvailable: true,
      supported: true,
      evidence: [
        "Dusk / BeatGig venue calendar embed found on first-party event surface",
        "BeatGig venue slug exposed by first-party embed configuration",
      ],
    });
  }

  const eventbriteOrganizerMatch = html.match(
    /https?:\\?\/\\?\/(?:www\\?\.)?eventbrite\\?\.com\\?\/o\\?\/[^"'<>\\\\\s]+/i,
  );

  if (eventbriteOrganizerMatch) {
    pushDetection(detections, {
      sourceType: "eventbrite_organizer",
      url: decodeHtml(
        eventbriteOrganizerMatch[0]
          .replace(/\\\\\//g, "/")
          .replace(/\\u0026/gi, "&"),
      ),
      confidence: "high",
      adapterAvailable: true,
      supported: true,
      evidence: ["Direct Eventbrite organizer URL found in page HTML"],
    });
  }

  const eventbriteEventMatch = html.match(
    /https?:\\?\/\\?\/(?:www\\?\.)?eventbrite\\?\.com\\?\/e\\?\/[^"'<>\\\s]+/i,
  );

  if (eventbriteEventMatch) {
    pushDetection(detections, {
      sourceType: "eventbrite_organizer",
      url: decodeHtml(
        eventbriteEventMatch[0].replace(/\\\//g, "/").replace(/\\u0026/gi, "&"),
      ),
      confidence: "medium",
      adapterAvailable: true,
      supported: true,
      evidence: ["Direct Eventbrite event URL found in page HTML"],
    });
  }

  /*
   * Shopify event collections expose a stable public JSON
   * product feed. Require both Shopify storefront evidence
   * and an event-oriented collection path so an ordinary
   * Shopify store is not classified as an event source.
   */
  if (
    (/cdn\.shopify\.com/i.test(html) ||
      /Shopify\.(?:theme|routes|shop)/i.test(html) ||
      /shopify-section/i.test(html)) &&
    /\/collections\/[^"'<>?\s]*(?:event|calendar)[^"'<>?\s]*/i.test(pageUrl)
  ) {
    try {
      const collectionUrl = new URL(pageUrl);
      const match = collectionUrl.pathname.match(
        /^(\/collections\/[^/]+)\/?$/i,
      );

      if (match) {
        const feedUrl = new URL(
          `${match[1]}/products.json`,
          collectionUrl.origin,
        );

        feedUrl.searchParams.set("limit", "250");

        pushDetection(detections, {
          sourceType: "shopify_events",
          url: feedUrl.toString(),
          confidence: "high",
          adapterAvailable: true,
          supported: true,
          evidence: [
            "Shopify storefront signature",
            "Event-oriented Shopify collection",
            "Shopify collection product feed",
          ],
        });
      }
    } catch {
      // Preserve other detector evidence if URL parsing fails.
    }
  }

  /*
   * WooCommerce event publishers expose products through the
   * public Store API. Require both a WooCommerce signature and
   * an event-oriented product/category surface.
   *
   * A generic WooCommerce shop is not an event source.
   */
  if (
    /woocommerce|wc-block-|wp-json\/wc\/store/i.test(html) &&
    (
      /\/product-category\/[^"'<>?\s]*(?:event|dinner|comedy|music|show|concert|ticket)/i.test(pageUrl) ||
      /\/product\/[^/?#]*(?:event|reservation|ticket)[^/?#]*\/?$/i.test(pageUrl)
    )
  ) {
    try {
      const page = new URL(pageUrl);
      const feed = new URL(
        "/wp-json/wc/store/v1/products",
        page.origin,
      );

      pushDetection(detections, {
        sourceType: "woocommerce_events",
        url: feed.toString(),
        confidence: "high",
        adapterAvailable: true,
        supported: true,
        evidence: [
          "WooCommerce storefront signature",
          "Event-oriented product surface",
          "Public WooCommerce Store API",
        ],
      });
    } catch {
      // Preserve other detection evidence.
    }
  }

  const metadataRecurring =
    parseMetadataRecurringSchedule(html);

  if (metadataRecurring.length > 0) {
    pushDetection(detections, {
      sourceType: "html_metadata_recurring",
      url: pageUrl,
      confidence: "high",
      adapterAvailable: true,
      supported: true,
      evidence: [
        "Explicit recurring weekday and time ranges in HTML metadata",
        `${metadataRecurring.length} recurring schedule item(s)`,
      ],
    });
  }

  if (hasParseableGoDaddyRecurringItems(html, pageUrl)) {
    pushDetection(detections, {
      sourceType: "godaddy_menu_recurring",
      url: pageUrl,
      confidence: "high",
      adapterAvailable: true,
      supported: true,
      evidence: [
        "GoDaddy Website Builder signature",
        "Parseable recurring-event markup",
      ],
    });
  }

  if (
    /cp-multi-view-calendar/i.test(html) &&
    /cpmvc_ajax_object/i.test(html) &&
    /cpmvc_configmultiview/i.test(html)
  ) {
    pushDetection(detections, {
      sourceType: "cp_multi_view_calendar",
      url: pageUrl,
      confidence: "high",
      adapterAvailable: true,
      supported: true,
      evidence: [
        "CP Multi View Calendar plugin signature",
        "CP Multi View Calendar runtime configuration",
      ],
    });
  }

  if (
    /uvtix\.com/i.test(html) &&
    (/urvenue\.com/i.test(html) || /application\/ld\+json/i.test(html)) &&
    /"@type"\s*:\s*"Event"/i.test(html)
  ) {
    pushDetection(detections, {
      sourceType: "uvtix_events",
      url: pageUrl,
      confidence: "high",
      adapterAvailable: true,
      supported: true,
      evidence: [
        "UVTix / UrVenue platform signature",
        "Schema.org Event inventory",
      ],
    });
  }

  /*
   * Generic first-party Schema.org Event inventory.
   *
   * Provider-specific adapters remain authoritative when their
   * stronger signatures are present. This generic source catches
   * first-party event pages that publish structured Event JSON-LD
   * without belonging to one of those provider families.
   */
  const hasPwpcEventsCalendar =
    /\/assets\/pwpc\/pwpc-[^"'<>]+\.(?:css|js)/i.test(html) &&
    /id=["']events-container["']/i.test(html) &&
    /class=["'][^"']*\bevent-card\b/i.test(html) &&
    /action=["']\/events\/?["']/i.test(html);

  if (hasPwpcEventsCalendar) {
    pushDetection(detections, {
      sourceType: "pwpc_events_calendar",
      url: pageUrl,
      confidence: "high",
      adapterAvailable: true,
      supported: true,
      evidence: [
        "PWPC server-rendered events calendar found on first-party event surface",
      ],
    });
  }

  const hasSchemaOrgEventInventory =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json(?:\s*;\s*charset=[^"']+)?["'][^>]*>[\s\S]*?"@type"\s*:\s*(?:"Event"|\[[^\]]*"Event"[^\]]*\])/i.test(
      html,
    );

  if (
    hasSchemaOrgEventInventory &&
    !hasPwpcEventsCalendar &&
    !/uvtix\.com/i.test(html)
  ) {
    pushDetection(detections, {
      sourceType: "schema_org_events",
      url: pageUrl,
      confidence: "high",
      adapterAvailable: true,
      supported: true,
      evidence: [
        "Schema.org Event JSON-LD inventory found on first-party event surface",
      ],
    });
  }

  if (/href=["'][^"']+\?format=ical(?:&[^"']*)?["']/i.test(html)) {
    pushDetection(detections, {
      sourceType: "squarespace_events",
      url: pageUrl,
      confidence: "high",
      adapterAvailable: true,
      supported: true,
      evidence: ["Per-event iCal links found"],
    });
  }

  /*
   * Avada and other WordPress themes may bundle Tribe-related CSS
   * without an installed or usable Events Calendar source.
   *
   * Require actual calendar markup, plugin assets, or an explicit
   * Tribe REST reference rather than a generic CSS selector.
   * Source validation still determines whether the API is usable.
   */
  /*
   * Calendar markup and plugin assets establish that The Events
   * Calendar is installed, but do not establish that its optional
   * REST API is exposed. Require an explicit REST endpoint reference
   * before proposing the Tribe REST adapter.
   */
  /*
   * WordPress event detail pages may advertise a REST URL for one
   * event (/events/12345). That is not evidence that the collection
   * endpoint (/events) is available for harvesting.
   *
   * Only an explicit collection URL qualifies as Tribe REST evidence.
   */
  const hasTribeRestEvidence =
    /wp-json\/tribe\/events\/v1\/events(?=[?#"'<>\s]|$)/i.test(html);
  if (hasTribeRestEvidence) {
    let tribeUrl = pageUrl;

    try {
      tribeUrl = new URL("/wp-json/tribe/events/v1/events", pageUrl).toString();
    } catch {
      // Keep page URL as evidence if URL construction fails.
    }

    pushDetection(detections, {
      sourceType: "tribe_rest",
      url: tribeUrl,
      confidence: "high",
      adapterAvailable: true,
      supported: true,
      evidence: ["The Events Calendar / Tribe signature"],
    });
  }

  if (
    /self\.__next_f\.push/i.test(html) &&
    (/"startDate"/i.test(html) ||
      /"startTime"/i.test(html) ||
      /"isDraft"/i.test(html))
  ) {
    pushDetection(detections, {
      sourceType: "next_rsc_events",
      url: pageUrl,
      confidence: "medium",
      adapterAvailable: true,
      supported: true,
      evidence: ["Next.js RSC payload with event-like fields"],
    });
  }

  if (/wp-admin\/admin-ajax\.php/i.test(html) && /get_events/i.test(html)) {
    pushDetection(detections, {
      sourceType: "wordpress_ajax_events",
      url: pageUrl,
      confidence: "high",
      adapterAvailable: false,
      supported: false,
      evidence: ["WordPress AJAX event endpoint signature"],
    });
  }

  if (
    (/(?:calendar|events?)\.time\.ly/i.test(html) ||
      /timely-event/i.test(html) ||
      /timely-calendar/i.test(html) ||
      /data-timely/i.test(html) ||
      /timely\/calendar/i.test(html)) &&
    (/calendar/i.test(lower) || /events/i.test(lower))
  ) {
    pushDetection(detections, {
      sourceType: "timely",
      url: pageUrl,
      confidence: "high",
      adapterAvailable: false,
      supported: false,
      evidence: ["Concrete Timely calendar signature"],
    });
  }

  // WordPress Eventer occurrence inventory, not WordPress post RSS.
  // Derive the archive from a dated occurrence link, including on homepages.
  if (
    /\beventer-event-item\b/i.test(html) &&
    /\beventer-event-title\b/i.test(html)
  ) {
    const occurrenceHref = html.match(
      /<a\b[^>]*href=["']([^"']+\/edate\/\d{4}-\d{2}-\d{2}(?:\/)?(?:\?[^"']*)?)["']/i,
    )?.[1];

    if (occurrenceHref) {
      try {
        const occurrenceUrl = new URL(
          occurrenceHref.replace(/&amp;/gi, "&"),
          pageUrl,
        );

        const archivePath = occurrenceUrl.pathname.replace(
          /\/[^/]+\/edate\/\d{4}-\d{2}-\d{2}\/?$/i,
          "/",
        );

        if (
          archivePath !== occurrenceUrl.pathname &&
          occurrenceUrl.origin === new URL(pageUrl).origin
        ) {
          const archiveUrl = new URL(archivePath, occurrenceUrl.origin);

          pushDetection(detections, {
            sourceType: "eventer_events",
            url: archiveUrl.toString(),
            confidence: "high",
            adapterAvailable: true,
            supported: true,
            evidence: [
              "WordPress Eventer occurrence cards and dated event URLs",
            ],
          });
        }
      } catch {
        // Malformed occurrence URLs must not interrupt source discovery.
      }
    }
  }

  const wordpressEventFeedMatch = html.match(
    /<link\b[^>]*rel=["']alternate["'][^>]*type=["']application\/rss\+xml["'][^>]*title=["'][^"']*\bEvents Feed\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/i,
  ) ?? html.match(
    /<link\b[^>]*href=["']([^"']+\/events\/feed\/?)["'][^>]*type=["']application\/rss\+xml["'][^>]*>/i,
  );

  if (
    wordpressEventFeedMatch?.[1] &&
    /\bjs-event-entry\b|\bc-events__body\b/i.test(html)
  ) {
    const feedUrl = normalizeUrl(
      wordpressEventFeedMatch[1],
      pageUrl,
    );

    if (feedUrl) {
      pushDetection(detections, {
        sourceType: "wordpress_event_feed",
        url: pageUrl,
        confidence: "high",
        adapterAvailable: true,
        supported: true,
        evidence: [
          "WordPress Events RSS feed with structured event entries",
        ],
      });
    }
  }

  if (
    /(?:static|cdn)\.spotapps\.co/i.test(html) ||
    /spothopper(?:app)?\.com/i.test(html) ||
    /\bspothopper\b/i.test(html)
  ) {
    pushDetection(detections, {
      sourceType: "spothopper_events",
      url: pageUrl,
      confidence: "high",
      adapterAvailable: true,
      supported: true,
      evidence: ["SpotHopper / SpotApps platform signature"],
    });
  }

  const {
    events: htmlEvents,
    diagnostics: htmlDiagnostics,
  } = extractHtmlEventsWithDiagnostics(html, pageUrl);

  /*
   * Report HTML extraction failures only when the extractor
   * recognizes a schedule and identifies missing performances.
   * Unrelated page-wide text is insufficient evidence.
   */
  if (
    htmlDiagnostics.recognizedSchedule &&
    htmlDiagnostics.extractedPerformances <
      htmlDiagnostics.expectedPerformances
  ) {
    pushDetection(detections, {
      sourceType: "html_error",
      url: pageUrl,
      confidence: "medium",
      adapterAvailable: false,
      supported: false,
      evidence: [
        "Recognizable dated HTML performance schedule",
        `Expected performances: ${htmlDiagnostics.expectedPerformances}`,
        `Extracted performances: ${htmlDiagnostics.extractedPerformances}`,
        ...htmlDiagnostics.errors.slice(0, 12),
      ],
    });
  }

  if (htmlEvents.length > 0) {
    pushDetection(detections, {
      sourceType: "html_events",
      url: pageUrl,
      confidence: "high",
      adapterAvailable: true,
      supported: true,
      evidence: [
        "Dated event inventory extracted from first-party HTML",
        `${htmlEvents.length} normalized HTML event record(s)`,
      ],
    });
  }

  if (
    isConfirmedEmptyPopmenuCalendar(html) &&
    !htmlEvents.length
  ) {
    pushDetection(detections, {
      sourceType: "html_events",
      url: pageUrl,
      confidence: "high",
      adapterAvailable: true,
      supported: true,
      evidence: [
        "Rendered Popmenu calendar with explicit empty inventory",
        "0 upcoming events",
      ],
    });
  }

  /*
   * Individual product pages can contain promotional artwork with
   * event-like filenames. These are not independent
   * calendar-image sources.
   *
   * Preserve calendar-image discovery on genuine calendar pages.
   */
  /*
   * Simple Calendar renders Google Calendar events as structured
   * Simcal HTML. Detect actual event records, not plugin assets.
   */
  if (
    /class=["'][^"']*\bsimcal-calendar\b/i.test(html) &&
    /class=["'][^"']*\bsimcal-event\b/i.test(html) &&
    /data-calendar-id=["']\d+["']/i.test(html)
  ) {
    pushDetection(detections, {
      sourceType: "simcal_events",
      url: pageUrl,
      confidence: "high",
      adapterAvailable: true,
      supported: true,
      evidence: ["Simple Calendar structured event records found"],
    });
  }

  const isIndividualProductPage =
    /\/product\/[^/?#]+\/?(?:[?#]|$)/i.test(pageUrl);

  const calendarImageAssets = isIndividualProductPage
    ? []
    : discoverCalendarImageAssets(html, pageUrl);

  if (calendarImageAssets.length > 0) {
    pushDetection(detections, {
      sourceType: "calendar_image",
      url: pageUrl,
      confidence: "medium",
      adapterAvailable: true,
      supported: true,
      evidence: ["Event/calendar-like uploaded image found"],
    });
  }

  if (
    /eventlist-event/i.test(html) &&
    /(?:hotel|rooftop|restaurant|bar)/i.test(html) &&
    (/\/events\/[^"'<>\s]+/i.test(html) || /\?format=ical\b/i.test(html))
  ) {
    const eventTitles = [
      ...html.matchAll(
        /eventlist-title[^>]*>[\s\S]{0,250}?>([^<]{2,160})<\/a>/gi,
      ),
    ]
      .map((match) => stripTags(match[1]))
      .filter(Boolean);

    const namedVenueTitles = eventTitles.filter((title) =>
      /\b(?:at|@)\s+[A-Z][\w'’& -]{2,}/.test(title),
    );

    if (namedVenueTitles.length > 0) {
      pushDetection(detections, {
        sourceType: "shared_event_calendar",
        url: pageUrl,
        confidence: "medium",
        adapterAvailable: false,
        supported: false,
        evidence: [
          "Event collection contains explicitly named venue events",
          "Shared-calendar venue attribution may be required",
        ],
      });
    }
  }
}

async function inspectProviderHandoffs(
  html: string,
  pageUrl: string,
  detections: SourceDetection[],
): Promise<number> {
  const providerLinks = discoverLinks(html, pageUrl).filter((link) =>
    /(?:uvtix\.com|urvenue\.com)/i.test(link.url) ||
    isGoTonightProfileUrl(link.url),
  );

  const seen = new Set<string>();
  let inspected = 0;

  for (const link of providerLinks) {
    if (seen.has(link.url)) {
      continue;
    }

    seen.add(link.url);

    try {
      const providerPage = await fetchHtml(link.url);
      inspected += 1;

      if (!providerPage.ok) {
        continue;
      }

      if (isGoTonightProfileUrl(link.url)) {
        const providerHtml = providerPage.html;

        const profileVerified =
          /id=["']profileId["']/i.test(providerHtml) &&
          /id=["']eventViews["']/i.test(providerHtml) &&
          /Venue Profile/i.test(providerHtml);

        if (profileVerified) {
          pushDetection(detections, {
            sourceType: "gotonight_events",
            url: link.url,
            confidence: "high",
            adapterAvailable: true,
            supported: true,
            evidence: [
              "GoTonight venue profile linked from official event page",
              "GoTonight venue profile identity and event surface verified",
            ],
          });
        }
      } else {
        inspectPage(providerPage.html, providerPage.url, detections);
      }
    } catch {
      // Provider handoff discovery is best-effort.
    }
  }

  return inspected;
}

export async function fetchHtml(
  url: string,
): Promise<{
  ok: boolean;
  status: number;
  url: string;
  html: string;
  recoveryDetail?: string;
  challengeEvidence?: string[];
}> {
  const recoveryProxy = getTransportRecoveryProxy();
  const preferProxy =
    preferredProxyContext.getStore() === true && Boolean(recoveryProxy);

  async function request(
    targetUrl: string,
    proxy?: string,
    browserHeaders = false,
  ) {
    const normalizedUrl = new URL(targetUrl);

    if (normalizedUrl.protocol === "http:") {
      normalizedUrl.protocol = "https:";
    }

    const response = await signedHarvesterFetch(
      normalizedUrl.toString(),
      {
        headers: browserHeaders || Boolean(proxy)
          ? {
              Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.9",
              "User-Agent": RECOVERY_USER_AGENT,
            }
          : {
              Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
              "User-Agent": USER_AGENT,
            },
        cache: "no-store",
      },
      proxy,
    );

    const html = await response.text();
    const finalUrl = response.url || normalizedUrl.toString();
    const challengeEvidence = identifyAccessChallenge(
      finalUrl, html, response.status,
    );

    if (
      response.headers.get("cf-mitigated")?.toLowerCase() === "challenge" &&
      !challengeEvidence.some(e => e.startsWith("Provider: Cloudflare"))
    ) {
      challengeEvidence.push("Provider: Cloudflare; cf-mitigated challenge header");
      challengeEvidence.push(`HTTP status: ${response.status}`);
      challengeEvidence.push(`Final URL: ${finalUrl}`);
    }

    return {
      ok: response.ok,
      status: response.status,
      url: finalUrl,
      html,
      challengeEvidence,
    };
  }

  /*
   * Source-validation fallback explicitly prefers Vultr.
   * Ordinary detector calls retain the original direct-first path.
   */
  if (preferProxy && recoveryProxy) {
    try {
      const proxied = await request(url, recoveryProxy);

      if (
        proxied.ok &&
        !(
          proxied.status === 202 &&
          (
            proxied.html.length < 2048 ||
            /captcha|sgcaptcha|verify you are human|checking your browser/i
              .test(proxied.html)
          )
        )
      ) {
        return proxied;
      }

      // Keep the proxy response when direct transport cannot improve it.
      try {
        const directFallback = await request(url);
        return directFallback.ok ? directFallback : {
          ...proxied,
          recoveryDetail:
            `Direct fallback returned HTTP ${directFallback.status}`,
        };
      } catch {
        return proxied;
      }
    } catch {
      // An unavailable proxy must not discard usable direct HTML.
      return request(url);
    }
  }

  let direct:
    | (Awaited<ReturnType<typeof request>> & {
        recoveryDetail?: string;
      })
    | undefined;
  let directError: unknown;

  try {
    direct = await request(url);
  } catch (error) {
    directError = error;
  }

  /*
   * Some sites reject the harvester request identity even though
   * ordinary browser-compatible HTTP requests are accepted.
   *
   * This stage is independent of the Vultr recovery context.
   * Never retry a response with identified challenge evidence.
   * Preserve the existing proxy recovery stage if compatibility
   * does not resolve the failure.
   */
  if (
    direct &&
    [400, 403].includes(direct.status) &&
    (direct.challengeEvidence?.length ?? 0) === 0
  ) {
    try {
      const compatible = await request(url, undefined, true);

      if (
        compatible.ok &&
        (compatible.challengeEvidence?.length ?? 0) === 0
      ) {
        return compatible;
      }

      direct = {
        ...direct,
        challengeEvidence: [
          ...new Set([
            ...(direct.challengeEvidence ?? []),
            ...(compatible.challengeEvidence ?? []),
          ]),
        ],
        recoveryDetail:
          `Browser-header retry returned HTTP ${compatible.status}`,
      };
    } catch (error) {
      direct = {
        ...direct,
        recoveryDetail:
          error instanceof Error
            ? `Browser-header retry failed: ${error.message}`
            : "Browser-header retry failed",
      };
    }
  }

  /*
   * Some protected sites return HTTP 202 with a short holding
   * response rather than the requested HTML document.
   * Treat that as a recoverable transport condition only when
   * no HTML document is present.
   */
  function isChallengeResponse(
    response: Awaited<ReturnType<typeof request>>,
  ): boolean {
    return (
      response.status === 202 &&
      (
        response.html.length < 2048 ||
        /captcha|sgcaptcha|verify you are human|checking your browser/i.test(
          response.html,
        )
      )
    );
  }

  const incompleteAcceptedResponse =
    direct?.status === 202 &&
    (
      !/<html\b|<!doctype\s+html\b/i.test(direct.html) ||
      isChallengeResponse(direct)
    );

  const verificationInterstitial =
    direct !== null &&
    direct !== undefined &&
    isVerificationInterstitial(direct.html);

  if (
    !recoveryProxy ||
    (direct &&
      ![403, 429, 503].includes(direct.status) &&
      !incompleteAcceptedResponse &&
      !verificationInterstitial)
  ) {
    if (direct) return direct;
    throw directError;
  }

  try {
    const recovered = await request(url, recoveryProxy);

    if (
      recovered.ok &&
      !isChallengeResponse(recovered) &&
      !isVerificationInterstitial(recovered.html)
    ) {
      return {
        ...recovered,
        challengeEvidence: [
          ...new Set([
            ...(direct?.challengeEvidence ?? []),
            ...(recovered.challengeEvidence ?? []),
          ]),
        ],
      };
    }

    if (direct) {
      return {
        ...direct,
        recoveryDetail:
          `Vultr recovery returned HTTP ${recovered.status}`,
      };
    }

    throw new Error(
      `Direct fetch failed: ${String(directError)}; ` +
      `Vultr recovery returned HTTP ${recovered.status}`,
    );
  } catch (error) {
    if (!direct) throw error;

    return {
      ...direct,
      recoveryDetail:
        error instanceof Error
          ? `Vultr recovery failed: ${error.message}`
          : "Vultr recovery failed",
    };
  }
}



function normalizeIdentityText(value: string): string {
  return decodeHtml(value)
    .toLowerCase()
    .replace(/\bsaint\b/g, "st")
    .replace(/\bst[.\s-]*pete\b/g, "st petersburg")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function identityTokens(value: string): string[] {
  const generic = new Set([
    "the", "and", "of", "at", "in", "a", "an",
    "bar", "grill", "restaurant", "tavern",
    "pub", "lounge", "club", "cafe", "hotel",
    "st", "saint",
  ]);

  return normalizeIdentityText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !generic.has(token));
}

function extractIdentityMetadata(html: string): string[] {
  const values: string[] = [];

  const title =
    html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];

  if (title) values.push(stripTags(title));

  for (const match of html.matchAll(
    /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi,
  )) {
    values.push(stripTags(match[1]));
  }

  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];

    const property =
      tag.match(/\b(?:property|name)\s*=\s*(["'])(.*?)\1/i)?.[2];

    if (!property || !/^(?:og:title|og:site_name|twitter:title)$/i.test(property)) {
      continue;
    }

    const content =
      tag.match(/\bcontent\s*=\s*(["'])(.*?)\1/i)?.[2];

    if (content) values.push(stripTags(content));
  }

  return values;
}

function extractRedirectDestinationIdentities(
  html: string,
): RedirectDestinationIdentity[] {
  const identities: RedirectDestinationIdentity[] = [];
  const seen = new Set<string>();

  const stringField = (value: unknown): string | null =>
    typeof value === "string" && value.trim()
      ? value.trim()
      : null;

  const isRecord = (
    value: unknown,
  ): value is Record<string, unknown> =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value);

  const businessTypes = new Set([
    "localbusiness", "restaurant", "barorpub", "nightclub",
    "foodestablishment", "cafeorcoffeeshop", "brewery",
    "winery", "hotel", "lodgingbusiness", "eventvenue",
    "entertainmentbusiness", "sportsbar",
    "pub", "fastfoodrestaurant", "bakery", "distillery",
    "danceclub", "musicvenue", "performingartstheater",
    "movie theater", "movietheater", "bowlingalley",
    "amusementpark", "casino", "resort", "motel",
  ]);

  function collect(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }

    if (!isRecord(value)) return;

    const rawTypes = Array.isArray(value["@type"])
      ? value["@type"]
      : [value["@type"]];

    const normalizedTypes = rawTypes
      .filter((raw): raw is string => typeof raw === "string")
      .map((raw) => raw.split(/[\\/#]/).pop()?.toLowerCase() ?? "");

    const matchesBusinessType = normalizedTypes.some(
      (type) => businessTypes.has(type),
    );

    const matchesWebsiteType = normalizedTypes.includes("website");

    if (matchesBusinessType || matchesWebsiteType) {
      const address = value.address;
      const addressObject = isRecord(address)
        ? address
        : Array.isArray(address)
          ? address.find(isRecord)
          : null;

      const identity: RedirectDestinationIdentity = {
        name: stringField(value.name) ?? "",
        streetAddress: addressObject
          ? stringField(addressObject.streetAddress)
          : null,
        city: addressObject
          ? stringField(addressObject.addressLocality)
          : null,
        stateRegion: addressObject
          ? stringField(addressObject.addressRegion)
          : null,
        postalCode: addressObject
          ? stringField(addressObject.postalCode)
          : null,
        source: matchesBusinessType
          ? "json_ld"
          : "website_json_ld",
      };

      if (identity.name) {
        const key = JSON.stringify(identity);
        if (!seen.has(key)) {
          seen.add(key);
          identities.push(identity);
        }
      }
    }

    // JSON-LD commonly nests identities in @graph or mainEntity.
    for (const key of ["@graph", "mainEntity", "mainEntityOfPage"]) {
      if (value[key] !== undefined) collect(value[key]);
    }
  }

  const pattern =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json(?:\s*;\s*charset=[^"']+)?["'][^>]*>([\s\S]*?)<\/script>/gi;

  for (const match of html.matchAll(pattern)) {
    try {
      collect(JSON.parse(match[1]));
    } catch {
      // A malformed JSON-LD block must not invalidate the scan.
    }
  }

  return identities;
}

export type RedirectVenueIdentity = {
  name: string;
  city?: string | null;
  stateRegion?: string | null;
  streetAddress?: string | null;
  postalCode?: string | null;
};


async function discoverWordPressCategoryEvents(
  pageUrl: string,
  html: string,
  detections: SourceDetection[],
): Promise<void> {
  // Require evidence of WordPress before probing its REST API.
  if (!/wp-json|wp-content|wp-includes|wordpress/i.test(html)) {
    return;
  }

  const origin = new URL(pageUrl).origin;

  // Limit category discovery to the same WordPress installation.
  const apiRoot = new URL("/wp-json/wp/v2/", origin);
  const categoryUrl = new URL("categories", apiRoot);
  categoryUrl.searchParams.set("per_page", "100");

  try {
    const response = await signedHarvesterFetch(
      categoryUrl.toString(),
      {
        headers: { Accept: "application/json" },
        cache: "no-store",
      },
    );

    if (!response.ok) return;

    const categories: unknown = await response.json();
    if (!Array.isArray(categories)) return;

    const candidates = categories
      .filter((category): category is {
        id: number;
        name: string;
        slug: string;
        count?: number;
      } =>
        category !== null &&
        typeof category === "object" &&
        Number.isInteger(category.id) &&
        typeof category.name === "string" &&
        typeof category.slug === "string"
      )
      .filter(category =>
        /\b(events?|entertainment|live[-\s]?music|happenings|calendar)\b/i
          .test(`${category.name} ${category.slug}`)
      )
      .slice(0, 3);

    for (const category of candidates) {
      const postsUrl = new URL("posts", apiRoot);
      postsUrl.searchParams.set("categories", String(category.id));
      postsUrl.searchParams.set("per_page", "10");

      try {
        const postsResponse = await signedHarvesterFetch(
          postsUrl.toString(),
          {
            headers: { Accept: "application/json" },
            cache: "no-store",
          },
        );

        if (!postsResponse.ok) continue;

        const posts: unknown = await postsResponse.json();
        if (!Array.isArray(posts)) continue;

        const validPosts = posts.filter(
          (post): post is {
            id: number;
            title: { rendered: string };
            content: { rendered: string };
          } =>
            post !== null &&
            typeof post === "object" &&
            Number.isInteger(post.id) &&
            typeof post.title?.rendered === "string" &&
            typeof post.content?.rendered === "string"
        );

        if (!hasParseableWordPressCategoryEvents(validPosts)) continue;

        pushDetection(detections, {
          sourceType: "wordpress_category_events",
          url: postsUrl.toString(),
          confidence: "high",
          adapterAvailable: true,
          supported: true,
          evidence: [
            `WordPress category "${category.name}" contains dated event announcements`,
            "WordPress posts contain parseable scheduled-event evidence",
            "Timezone configuration required before harvesting",
          ],
        });
      } catch {
        // An inaccessible category does not invalidate other sources.
      }
    }
  } catch {
    // WordPress REST API may be disabled or restricted.
  }
}

/*
 * Preserve the underlying network error for first-party homepage
 * diagnostics. Node fetch often reports only "fetch failed" while
 * the actionable DNS or socket code lives in error.cause.
 *
 * The extracted codes also support definitive DNS classification.
 */
function describeHomepageFetchError(error: unknown): string {
  const outerMessage =
    error instanceof Error ? error.message : String(error);

  const details: string[] = [];
  const visited = new Set<object>();
  let current: unknown = error;

  for (let depth = 0; depth < 5; depth++) {
    if (
      current === null ||
      typeof current !== "object" ||
      visited.has(current)
    ) {
      break;
    }

    visited.add(current);

    const candidate = current as {
      code?: unknown;
      cause?: unknown;
      errors?: unknown;
    };

    if (
      typeof candidate.code === "string" &&
      /^[A-Z][A-Z0-9_]+$/.test(candidate.code)
    ) {
      details.push(candidate.code);
    }

    if (
      Array.isArray(candidate.errors)
    ) {
      for (const nested of candidate.errors) {
        if (
          nested &&
          typeof nested === "object" &&
          "code" in nested &&
          typeof nested.code === "string" &&
          /^[A-Z][A-Z0-9_]+$/.test(nested.code)
        ) {
          details.push(nested.code);
        }
      }
    }

    current = candidate.cause;
  }

  const uniqueDetails = [...new Set(details)];

  return uniqueDetails.length
    ? `${outerMessage} [${uniqueDetails.join(", ")}]`
    : outerMessage;
}

export async function detectFirstPartySources(
  websiteUrl: string,
  venueIdentity?: RedirectVenueIdentity,
  approvedRedirectUrls: readonly string[] = [],
): Promise<SiteDetectionResult> {
  const detections: SourceDetection[] = [];

  let homepage: Awaited<ReturnType<typeof fetchHtml>>;

  let homepageFetchError: unknown = null;

  try {
    homepage = await fetchHtml(websiteUrl);
  } catch (error) {
    homepageFetchError = error;
    homepage = {
      ok: false,
      status: 0,
      url: websiteUrl,
      html: "",
    };
  }

  /*
   * Browser-assisted homepage recovery.
   *
   * This is available only inside the established transport-recovery
   * context. Browser evidence rejoins the existing detector pipeline;
   * no independent source classification or adapter path is introduced.
   */
  const browserOutcomes: BrowserExecutionOutcome[] = [];

  const recoveryProxy = getTransportRecoveryProxy();

  if (
    recoveryProxy &&
    !homepage.ok &&
    !identifyAccessChallenge(
      homepage.url,
      homepage.html,
      homepage.status,
    ).length
  ) {
    try {
      const evidence = await fetchBrowserEvidence(
        websiteUrl,
        recoveryProxy,
      );

      const browserChallenge = identifyAccessChallenge(
        evidence.finalUrl,
        evidence.html,
        evidence.status,
      );

      if (
        browserChallenge.length === 0 &&
        evidence.status !== null &&
        evidence.status >= 200 &&
        evidence.status < 400
      ) {
        browserOutcomes.push({
          url: websiteUrl,
          ok: true,
          error: null,
        });
      }

      if (
        browserChallenge.length > 0 ||
        (
          evidence.status !== null &&
          evidence.status >= 200 &&
          evidence.status < 400
        )
      ) {
        homepage = {
          ok:
            browserChallenge.length === 0 &&
            evidence.status !== null &&
            evidence.status >= 200 &&
            evidence.status < 400,
          status: evidence.status ?? 0,
          url: evidence.finalUrl,
          html: evidence.html,
          recoveryDetail: "Browser-assisted transport recovery",
        };
      }
    } catch (error) {
      browserOutcomes.push({
        url: websiteUrl,
        ok: false,
        error: error instanceof Error
          ? error.message
          : "Browser homepage recovery failed",
      });
      // Preserve the original HTTP result if browser recovery fails.
    }
  }

  if (homepageFetchError && !homepage.ok) {
    return {
      websiteUrl,
      browserOutcomes,
      fetchedUrl: null,
      status: "transport_failed",
      pagesInspected: 0,
      discoveredEventPages: [],
      detections: [],
      error: describeHomepageFetchError(homepageFetchError),
    };
  }

  const homepageChallenge = [
    ...new Set([
      ...(homepage.challengeEvidence ?? []),
      ...identifyAccessChallenge(
        homepage.url, homepage.html, homepage.status,
      ),
    ]),
  ];

  if (homepageChallenge.length > 0) {
    return {
      websiteUrl,
      browserOutcomes,
      fetchedUrl: homepage.url,
      status: "challenge_encountered",
      challengeEvidence: homepageChallenge,
      pagesInspected: 1,
      discoveredEventPages: [],
      detections: [],
      error: homepageChallenge[0],
    };
  }

  if (!homepage.ok) {
    return {
      websiteUrl,
      browserOutcomes,
      fetchedUrl: homepage.url,
      status:
        homepage.status === 403 ||
        homepage.status === 429 ||
        homepage.status === 503
          ? "transport_blocked"
          : "transport_failed",
      pagesInspected: 1,
      discoveredEventPages: [],
      detections: [],
      error:
        `Homepage returned HTTP ${homepage.status}` +
        (homepage.recoveryDetail
          ? `; ${homepage.recoveryDetail}`
          : ""),
    };
  }

  const requestedHost = hostname(websiteUrl);
  const fetchedHost = hostname(homepage.url);

  if (
    requestedHost &&
    fetchedHost &&
    !sameSite(websiteUrl, homepage.url) &&
    !approvedRedirectUrls.some((approvedUrl) => {
      try {
        const approved = new URL(approvedUrl);
        const fetched = new URL(homepage.url);

        approved.hash = "";
        fetched.hash = "";

        return approved.href === fetched.href;
      } catch {
        return false;
      }
    })
  ) {
    return {
      websiteUrl,
      browserOutcomes,
      fetchedUrl: homepage.url,
      status: "external_redirect",
      redirectIdentities: extractRedirectDestinationIdentities(homepage.html),
      pagesInspected: 1,
      discoveredEventPages: [],
      detections: [],
      error: `Website redirected from ${requestedHost} to unverified cross-domain host ${fetchedHost}`,
    };
  }

  inspectPage(homepage.html, homepage.url, detections);

  if (inspectToastDigitalStorefront(homepage.html)) {
    pushDetection(detections, {
      sourceType: "toast_digital_storefront", url: homepage.url,
      confidence: "high", adapterAvailable: true, supported: true,
      evidence: ["Toast Digital Storefront event page with explicit weekly schedule"],
    });
  }

  // Square storefronts must contain actual event products.
  // A generic Square shop is not automatically an event source.
  try {
    if (await inspectSquareOnline(homepage.html)) {
      pushDetection(detections, {
        sourceType: "square_online_events",
        url: homepage.url,
        confidence: "high",
        adapterAvailable: true,
        supported: true,
        evidence: [
          "Square Online storefront identified",
          "Public catalog contains structured event products",
        ],
      });
    }
  } catch {
    // Square catalog failure must not disrupt other adapters.
  }

  /*
   * Discover public event inventories exposed by first-party
   * JavaScript applications. The discovery module verifies
   * the API before returning a candidate.
   *
   * Never put the public API key in detection evidence.
   * Ratification stores only the first-party website URL.
   */
  try {
    const postgrest = await discoverPublicPostgrestEvents(
      homepage.url,
    );

    if (postgrest) {
      pushDetection(detections, {
        sourceType: "supabase_postgrest_events",
        url: homepage.url,
        confidence: "high",
        adapterAvailable: true,
        supported: true,
        evidence: [
          "First-party JavaScript exposes a public Supabase events inventory",
          "Public PostgREST events API returned parseable records",
          "Supported weekly recurrences are expanded; cancellation exceptions remain unverified",
        ],
      });
    }
  } catch {
    // Discovery failure must not disrupt other adapters.
  }


  await discoverWordPressCategoryEvents(
    homepage.url,
    homepage.html,
    detections,
  );

  const homeHost = hostname(homepage.url);

  if (homeHost === "facebook.com" || homeHost.endsWith(".facebook.com")) {
    const facebookUrl = normalizeFacebookPageUrl(homepage.url);

    if (facebookUrl) {
      pushDetection(detections, {
        sourceType: "facebook",
        url: facebookUrl,
        confidence: "high",
        adapterAvailable: true,
        supported: true,
        evidence: ["Spot website points to Facebook"],
      });
    }
  }

  if (homeHost === "linktr.ee" || homeHost.endsWith(".linktr.ee")) {
    pushDetection(detections, {
      sourceType: "linktree",
      url: homepage.url,
      confidence: "high",
      adapterAvailable: false,
      supported: false,
      evidence: ["Spot website points to Linktree"],
    });
  }

  const primaryLinks = discoverLinks(homepage.html, homepage.url).filter(
    (link) =>
      sameSite(link.url, homepage.url) ||
      isGoTonightProfileUrl(link.url) ||
      /eventbrite\.com/i.test(link.url) ||
      /uvtix\.com/i.test(link.url),
  );

  /*
   * Homepage navigation is not authoritative. Some sites
   * expose event inventory through routes that are absent
   * from server-rendered navigation but present in their
   * sitemap/site metadata.
   */
  const secondaryLinks = await discoverSecondaryEventLinks(homepage.url);

  const candidateLinkMap = new Map<string, { url: string; text: string }>();

  for (const link of [...primaryLinks, ...secondaryLinks]) {
    if (!candidateLinkMap.has(link.url)) {
      candidateLinkMap.set(link.url, link);
    }
  }

  const candidateLinks = [...candidateLinkMap.values()].slice(0, 12);

  const discoveredEventPages: DiscoveredEventPage[] = candidateLinks.map(
    (link) => ({
      url: link.url,
      linkText: link.text,
      sameSite: sameSite(link.url, homepage.url),
      fetched: false,
      httpStatus: null,
      finalUrl: null,
      htmlBytes: null,
    }),
  );

  let pagesInspected = 1;
  const encounteredChallenges: string[] = [];

  /*
   * TanStack discovery fetches and inspects compiled JS modules.
   * Only enqueue pages with evidence of TanStack Start hydration
   * and module loading. This is generic platform detection.
   */
  const tanstackEligibleUrls = new Set<string>();

  const recordTanStackEligibility = (html: string, url: string) => {
    const hasHydration = /__TSR__|__TSR|_tsr/i.test(html);
    const hasModulePreload = /modulepreload/i.test(html);

    if (hasHydration && hasModulePreload) {
      tanstackEligibleUrls.add(url);
    }
  };

  recordTanStackEligibility(homepage.html, homepage.url);

  for (const link of candidateLinks) {
    const discovered = discoveredEventPages.find(
      (page) => page.url === link.url,
    );
    if (link.url === homepage.url) {
      continue;
    }

    if (isGoTonightProfileUrl(link.url)) {
      pushDetection(detections, {
        sourceType: "gotonight_events",
        url: link.url,
        confidence: "high",
        adapterAvailable: true,
        supported: true,
        evidence: [
          "Official Spot website links to GoTonight venue profile",
          "GoTonight venue inventory is supported by the shared adapter",
        ],
      });
      continue;
    }

    if (/eventbrite\.com\/o\//i.test(link.url)) {
      pushDetection(detections, {
        sourceType: "eventbrite_organizer",
        url: link.url,
        confidence: "high",
        adapterAvailable: true,
        supported: true,
        evidence: ["Direct Eventbrite organizer link discovered"],
      });
      continue;
    }

    if (/eventbrite\.com\/e\//i.test(link.url)) {
      pushDetection(detections, {
        sourceType: "eventbrite_organizer",
        url: link.url,
        confidence: "medium",
        adapterAvailable: true,
        supported: true,
        evidence: ["Direct Eventbrite event link discovered"],
      });
      continue;
    }

    if (/uvtix\.com/i.test(link.url)) {
      try {
        const page = await fetchHtml(link.url);
        pagesInspected += 1;

        if (discovered) {
          discovered.fetched = true;
          discovered.httpStatus = page.status;
          discovered.finalUrl = page.url;
          discovered.htmlBytes = page.html.length;
        }

        if (page.ok) {
          inspectPage(page.html, page.url, detections);

        }
      } catch {
        // External UVTix discovery failure does not fail the site scan.
      }
      continue;
    }

    if (!sameSite(link.url, homepage.url)) {
      continue;
    }

    try {
      const page = await fetchHtml(link.url);
      pagesInspected += 1;

      if (discovered) {
        discovered.fetched = true;
        discovered.httpStatus = page.status;
        discovered.finalUrl = page.url;
        discovered.htmlBytes = page.html.length;
      }

      const pageChallenge = identifyAccessChallenge(
        page.url, page.html, page.status,
      );

      if (pageChallenge.length > 0) {
        encounteredChallenges.push(...pageChallenge);
        continue;
      }

      if (!page.ok) {
        continue;
      }

      inspectPage(page.html, page.url, detections);
      if (inspectToastDigitalStorefront(page.html)) {
        pushDetection(detections, {
          sourceType: "toast_digital_storefront",
          url: page.url,
          confidence: "high",
          adapterAvailable: true,
          supported: true,
          evidence: ["Toast Digital Storefront event page with explicit weekly schedule"],
        });
      }
      recordTanStackEligibility(
        page.html,
        discovered?.finalUrl ?? page.url,
      );

      pagesInspected += await inspectProviderHandoffs(
        page.html,
        page.url,
        detections,
      );
    } catch {
      // Individual discovery-page failures do not fail the site scan.
    }
  }

  /*
   * Browser escalation is transport enrichment, not a source type.
   *
   * Static detection may prove that a runtime event application exists
   * without exposing its actual provider data source. Revisit the
   * already-discovered same-site event surfaces in the browser and feed
   * the resulting evidence back through the same detector.
   *
   * Stop as soon as the browser exposes a harvestable provider source.
   * This keeps browser resolution bounded while preserving the existing
   * HTTP discovery path and shared provider adapters.
   */
  const needsBrowserResolution =
    detections.some(
      (detection) => detection.sourceType === "browser_required",
    ) ||
    (
      !detections.some(
        (detection) =>
          detection.supported &&
          detection.adapterAvailable &&
          detection.sourceType !== "facebook",
      ) &&
      discoveredEventPages.some(
        (page) =>
          page.sameSite &&
          page.fetched &&
          page.httpStatus !== null &&
          page.httpStatus >= 200 &&
          page.httpStatus < 400,
      )
    );

  if (needsBrowserResolution) {
    const browserCandidates = discoveredEventPages.filter(
      (page) =>
        page.sameSite &&
        page.fetched &&
        page.httpStatus !== null &&
        page.httpStatus >= 200 &&
        page.httpStatus < 400,
    );

    const popmenuUrls = new Set(
      detections
        .filter(d =>
          d.sourceType === "browser_required" &&
          d.evidence.includes(
            "Popmenu calendar requires client-side rendering"
          )
        )
        .map(d => d.url)
    );

    /*
     * Popmenu calendar shells need browser rendering.
     * Include the homepage when it contains a calendar, and
     * prioritize discovered Popmenu calendar pages.
     *
     * Preserve the existing candidate list for other adapters.
     */
    const popmenuHomepageCandidate =
      popmenuUrls.has(homepage.url)
        ? [{
            url: homepage.url,
            finalUrl: homepage.url,
            sameSite: true,
            fetched: true,
            httpStatus: 200,
          }]
        : [];

    const orderedBrowserCandidates = [
      ...popmenuHomepageCandidate,
      ...browserCandidates,
    ];

    orderedBrowserCandidates.sort((a, b) =>
      Number(popmenuUrls.has(b.finalUrl ?? b.url)) -
      Number(popmenuUrls.has(a.finalUrl ?? a.url))
    );

    for (const candidate of orderedBrowserCandidates) {
      try {
        const evidence = await fetchBrowserEvidence(
          candidate.finalUrl ?? candidate.url,
          getTransportRecoveryProxy(),
        );

        pagesInspected += 1;

        const browserChallenge = identifyAccessChallenge(
          evidence.finalUrl,
          evidence.html,
          evidence.status,
        );

        if (browserChallenge.length > 0) {
          encounteredChallenges.push(...browserChallenge);
          continue;
        }

        if (
          evidence.status === null ||
          evidence.status < 200 ||
          evidence.status >= 400 ||
          !sameSite(candidate.url, evidence.finalUrl)
        ) {
          continue;
        }

        browserOutcomes.push({
          url: candidate.finalUrl ?? candidate.url,
          ok: true,
          error: null,
        });

        inspectPage(
          evidence.html,
          evidence.finalUrl,
          detections,
        );

        const confirmedPopmenuHtml = detections.some(
          d =>
            d.sourceType === "html_events" &&
            d.supported &&
            d.url === evidence.finalUrl &&
            (
              /pm-calendar-event-card-wrapper/i.test(evidence.html) ||
              isConfirmedEmptyPopmenuCalendar(evidence.html)
            )
        );

        if (confirmedPopmenuHtml) {
          for (let i = detections.length - 1; i >= 0; i--) {
            if (
              detections[i].sourceType === "browser_required" &&
              detections[i].url === evidence.finalUrl &&
              detections[i].evidence.includes(
                "Popmenu calendar requires client-side rendering"
              )
            ) {
              detections.splice(i, 1);
            }
          }
        }

        for (const observedUrl of [
          ...evidence.iframeUrls,
          ...evidence.observedUrls,
        ]) {
          inspectObservedBrowserUrl(
            observedUrl,
            detections,
          );
        }

        const allPopmenuCalendarsConfirmed =
          popmenuUrls.size > 0 &&
          [...popmenuUrls].every(url =>
            detections.some(d =>
              d.sourceType === "html_events" &&
              d.supported &&
              d.url === url
            )
          );

        const otherProviderConfirmed = detections.some(
          d =>
            d.sourceType === "eventscalendar_events" ||
            d.sourceType === "sociablekit_facebook_events" ||
            d.sourceType === "google_calendar" ||
            d.sourceType === "ticket_spot_events"
        );

        if (
          popmenuUrls.size > 0
            ? allPopmenuCalendarsConfirmed
            : otherProviderConfirmed
        ) {
          break;
        }
      } catch (error) {
        browserOutcomes.push({
          url: candidate.finalUrl ?? candidate.url,
          ok: false,
          error: error instanceof Error
            ? error.message
            : "Browser event-page evaluation failed",
        });
        /*
         * A failed browser attempt on one discovered event surface
         * does not invalidate the HTTP detector result or prevent
         * another candidate page from being tried.
         */
      }
    }

    /*
     * browser_required describes an unresolved transport condition.
     * Once browser execution identifies the real harvestable provider,
     * retain the provider source rather than the superseded condition.
     */
    if (
      detections.some(
        (detection) =>
          detection.sourceType ===
            "eventscalendar_events" ||
          detection.sourceType ===
            "sociablekit_facebook_events" ||
          detection.sourceType ===
            "google_calendar" ||
            detection.sourceType === "ticket_spot_events",
      )
    ) {
      for (
        let index = detections.length - 1;
        index >= 0;
        index -= 1
      ) {
        if (
          detections[index].sourceType === "browser_required"
        ) {
          detections.splice(index, 1);
        }
      }
    }
  }

  /*
   * TanStack Start / Seroval calendar discovery.
   *
   * Inspect only event surfaces already found by the existing
   * discovery pipeline. The adapter verifies the compiled route,
   * server-function module, and unique function hash.
   *
   * A generic TanStack application is not sufficient evidence.
   */

  const tanstackCandidates = [
    ...new Set(
      discoveredEventPages
        .filter(
          (page) =>
            page.sameSite &&
            page.fetched &&
            page.httpStatus !== null &&
            page.httpStatus >= 200 &&
            page.httpStatus < 400,
        )
        .map((page) => page.finalUrl ?? page.url)
        .filter((url) => tanstackEligibleUrls.has(url)),
    ),
  ];

  for (const candidateUrl of tanstackCandidates) {
    try {
      const descriptor =
        await discoverTanStackCalendar(candidateUrl);

      if (!descriptor) {
        continue;
      }

      pushDetection(detections, {
        sourceType: "tanstack_seroval_events",
        url: descriptor.pageUrl,
        confidence: "high",
        adapterAvailable: true,
        supported: true,
        evidence: [
          "TanStack Start calendar route and Seroval server function verified",
        ],
      });
    } catch {
      // Unsupported or inaccessible TanStack candidates are ignored.
    }
  }

  /*
   * A detected PWPC server-rendered calendar is the stronger live
   * inventory for this first-party site. Some sites also expose stale
   * Schema.org Event JSON-LD on a separate event/promotions page.
   * Do not retain that weaker generic candidate when the live calendar
   * adapter is available for the same Spot.
   */
  if (
    detections.some(
      (detection) => detection.sourceType === "pwpc_events_calendar",
    )
  ) {
    for (let index = detections.length - 1; index >= 0; index -= 1) {
      if (detections[index].sourceType === "schema_org_events") {
        detections.splice(index, 1);
      }
    }
  }

  /*
   * Facebook is a non-ratified fallback signal only.
   *
   * If no stronger event source was discovered but the Spot's
   * website links to Facebook, preserve that fact for later
   * Facebook-adapter review. Do not attempt to associate the
   * Facebook page with a specific venue or treat it as supported.
   */
  const facebookUrl =
    discoverFacebookUrl(homepage.html, homepage.url);

  if (facebookUrl) {
    pushDetection(detections, {
      sourceType: "facebook",
      url: facebookUrl,
      confidence: "medium",
      adapterAvailable: true,
      supported: true,
      evidence: ["Facebook is the only potential event source discovered"],
    });
  }

  const challengeOnly =
    encounteredChallenges.length > 0 &&
    !detections.some(
      (candidate) =>
        candidate.sourceType !== "browser_required" &&
        candidate.sourceType !== "facebook",
    );

  return {
    websiteUrl,
    browserOutcomes,
    fetchedUrl: homepage.url,
    status: challengeOnly
      ? "challenge_encountered"
      : detections.length > 0
        ? "detected"
        : "no_event_source",
    challengeEvidence: [
      ...new Set([
        ...(homepage.challengeEvidence ?? []),
        ...encounteredChallenges,
      ]),
    ],
    pagesInspected,
    discoveredEventPages,
    detections: challengeOnly ? [] : detections,
    error: challengeOnly
      ? "Event-source inspection encountered an access challenge"
      : null,
  };
}
