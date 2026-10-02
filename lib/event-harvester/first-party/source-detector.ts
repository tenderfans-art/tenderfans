export type DetectedSourceType =
  | "eventbrite_organizer"
  | "godaddy_menu_recurring"
  | "cp_multi_view_calendar"
  | "uvtix_events"
  | "shopify_events"
  | "calendar_image"
  | "browser_required"
  | "spothopper_events"
  | "shared_event_calendar"
  | "squarespace_events"
  | "tribe_rest"
  | "next_rsc_events"
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
    pushDetection(detections, {
      sourceType: "facebook",
      url: homepage.url,
      confidence: "high",
      adapterAvailable: false,
      supported: false,
      evidence: ["Spot website points to Facebook"],
    });
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
   * Facebook is a non-ratified fallback signal only.
   *
   * If no stronger event source was discovered but the Spot's
   * website links to Facebook, preserve that fact for later
   * Facebook-adapter review. Do not attempt to associate the
   * Facebook page with a specific venue or treat it as supported.
   */
  if (
    detections.length === 0 &&
    /https?:\/\/(?:www\.)?facebook\.com\//i.test(homepage.html)
  ) {
    pushDetection(detections, {
      sourceType: "facebook",
      url: homepage.url,
      confidence: "medium",
      adapterAvailable: false,
      supported: false,
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
