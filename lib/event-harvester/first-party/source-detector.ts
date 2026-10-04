import { fetchBrowserEvidence } from "./browser-transport";

export type DetectedSourceType =
  | "eventbrite_organizer"
  | "godaddy_menu_recurring"
  | "cp_multi_view_calendar"
  | "uvtix_events"
  | "schema_org_events"
  | "pwpc_events_calendar"
  | "shopify_events"
  | "calendar_image"
  | "eventscalendar_events"
  | "sociablekit_facebook_events"
  | "browser_required"
  | "spothopper_events"
  | "shared_event_calendar"
  | "squarespace_events"
  | "tribe_rest"
  | "next_rsc_events"
  | "google_calendar"
  | "beatgig_events"
  | "bandzoogle_events"
  | "ics"
  | "wordpress_ajax_events"
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

export type SiteDetectionResult = {
  websiteUrl: string;
  fetchedUrl: string | null;
  status:
    | "detected"
    | "transport_blocked"
    | "transport_failed"
    | "external_redirect"
    | "no_event_source";
  pagesInspected: number;
  discoveredEventPages: DiscoveredEventPage[];
  detections: SourceDetection[];
  error: string | null;
};

const USER_AGENT = "TenderFans Event Harvester/1.0";

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
      /(?:eventbrite\.com|uvtix\.com|urvenue\.com)/i.test(url);

    if (EVENT_HINT.test(text) || EVENT_HINT.test(url) || knownEventProvider) {
      links.set(url, { url, text });
    }
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
    path.startsWith("/help")
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
    (item) => item.sourceType === detection.sourceType,
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

function inspectPage(
  html: string,
  pageUrl: string,
  detections: SourceDetection[],
) {
  const lower = html.toLowerCase();

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
    /https?:\\?\/\\?\/(?:www\\?\.)?google\\?\.com\\?\/calendar\\?\/embed\?[^"'<>\\\s]*\bsrc=[^"'<>\\\s&]+[^"'<>\\\s]*/i,
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

  if (
    bandzoogleCalendarMatch &&
    hasBandzoogleOccurrence
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
   * Some event platforms embed Eventbrite as their ticket/calendar
   * provider without exposing a literal eventbrite.com URL in the
   * server-rendered page. Require multiple Eventbrite integration
   * signals so ordinary mentions of Eventbrite do not qualify.
   */
  if (
    !eventbriteOrganizerMatch &&
    !eventbriteEventMatch &&
    !eventsCalendarRuntimeMatch &&
    /\beventbrite\b/i.test(html) &&
    (/directed to your Eventbrite page/i.test(html) ||
      /Eventbrite calendars?/i.test(html)) &&
    (/purchase tickets?/i.test(html) ||
      /sync with external calendars?/i.test(html) ||
      /display multiple events?/i.test(html))
  ) {
    pushDetection(detections, {
      sourceType: "eventbrite_organizer",
      url: pageUrl,
      confidence: "medium",
      adapterAvailable: true,
      supported: true,
      evidence: [
        "Embedded Eventbrite event/ticket integration",
        "Multiple Eventbrite integration signals found",
      ],
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

  if (
    /Go Daddy Website Builder/i.test(html) &&
    /data-aid=["']MENU_CATEGORY_/i.test(html)
  ) {
    pushDetection(detections, {
      sourceType: "godaddy_menu_recurring",
      url: pageUrl,
      confidence: "high",
      adapterAvailable: true,
      supported: true,
      evidence: [
        "GoDaddy Website Builder signature",
        "Recurring menu category markup",
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

  if (/\?format=ical\b/i.test(html) || /text\/calendar/i.test(html)) {
    pushDetection(detections, {
      sourceType: "squarespace_events",
      url: pageUrl,
      confidence: "high",
      adapterAvailable: true,
      supported: true,
      evidence: ["Per-event iCal links found"],
    });
  }

  if (
    /tribe-events/i.test(html) ||
    /the events calendar/i.test(html) ||
    /wp-json\/tribe\/events/i.test(html)
  ) {
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

  const calendarImageMatches = [
    ...html.matchAll(
      /(?:src|data-src|data-srclazy)=["']([^"']*(?:(?:wp-content\/uploads|\/uploads\/)|img1\.wsimg\.com\/isteam\/)[^"']*(?:calendar|entertainment|live(?:%20|[-_ ])?music|events?|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[-_ ]?[0-9]{2,4}|(?:^|[-_\/])(?:0?[1-9]|1[0-2])[-_](?:20[0-9]{2}))[^"']*\.(?:jpe?g|png|webp)(?:(?:\/:\/)[^"']*|\?[^"']*)?)["']/gi,
    ),
  ];

  if (calendarImageMatches.length > 0) {
    pushDetection(detections, {
      sourceType: "calendar_image",
      url: pageUrl,
      confidence: "medium",
      adapterAvailable: false,
      supported: false,
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
    /(?:uvtix\.com|urvenue\.com)/i.test(link.url),
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

      inspectPage(providerPage.html, providerPage.url, detections);
    } catch {
      // Provider handoff discovery is best-effort.
    }
  }

  return inspected;
}

async function fetchHtml(url: string): Promise<{
  ok: boolean;
  status: number;
  url: string;
  html: string;
}> {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "User-Agent": USER_AGENT,
    },
    redirect: "follow",
    cache: "no-store",
  });

  return {
    ok: response.ok,
    status: response.status,
    url: response.url || url,
    html: await response.text(),
  };
}

export async function detectFirstPartySources(
  websiteUrl: string,
): Promise<SiteDetectionResult> {
  const detections: SourceDetection[] = [];
  let homepage;

  try {
    homepage = await fetchHtml(websiteUrl);
  } catch (error) {
    return {
      websiteUrl,
      fetchedUrl: null,
      status: "transport_failed",
      pagesInspected: 0,
      discoveredEventPages: [],
      detections: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!homepage.ok) {
    return {
      websiteUrl,
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
      error: `Homepage returned HTTP ${homepage.status}`,
    };
  }

  const requestedHost = hostname(websiteUrl);
  const fetchedHost = hostname(homepage.url);

  if (requestedHost && fetchedHost && !sameSite(websiteUrl, homepage.url)) {
    return {
      websiteUrl,
      fetchedUrl: homepage.url,
      status: "external_redirect",
      pagesInspected: 1,
      discoveredEventPages: [],
      detections: [],
      error: `Website redirected from ${requestedHost} to unrelated host ${fetchedHost}`,
    };
  }

  inspectPage(homepage.html, homepage.url, detections);

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

  for (const link of candidateLinks) {
    const discovered = discoveredEventPages.find(
      (page) => page.url === link.url,
    );
    if (link.url === homepage.url) {
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

      if (!page.ok) {
        continue;
      }

      inspectPage(page.html, page.url, detections);

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
   * Stop as soon as the browser exposes a harvestable EventsCalendar
   * source. This keeps the first browser integration intentionally
   * bounded while preserving the existing HTTP discovery path.
   */
  const needsBrowserResolution = detections.some(
    (detection) => detection.sourceType === "browser_required",
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

    for (const candidate of browserCandidates) {
      try {
        const evidence = await fetchBrowserEvidence(
          candidate.finalUrl ?? candidate.url,
        );

        pagesInspected += 1;

        inspectPage(
          evidence.html,
          evidence.finalUrl,
          detections,
        );

        for (const observedUrl of [
          ...evidence.iframeUrls,
          ...evidence.observedUrls,
        ]) {
          inspectObservedBrowserUrl(
            observedUrl,
            detections,
          );
        }

        if (
          detections.some(
            (detection) =>
              detection.sourceType ===
                "eventscalendar_events" ||
              detection.sourceType ===
                "sociablekit_facebook_events",
          )
        ) {
          break;
        }
      } catch {
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
            "sociablekit_facebook_events",
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
    detections.length === 0
      ? discoverFacebookUrl(homepage.html, homepage.url)
      : null;

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

  return {
    websiteUrl,
    fetchedUrl: homepage.url,
    status: detections.length > 0 ? "detected" : "no_event_source",
    pagesInspected,
    discoveredEventPages,
    detections,
    error: null,
  };
}
