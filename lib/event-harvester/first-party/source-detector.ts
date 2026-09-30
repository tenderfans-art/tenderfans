export type DetectedSourceType =
  | "eventbrite_organizer"
  | "godaddy_menu_recurring"
  | "cp_multi_view_calendar"
  | "squarespace_events"
  | "tribe_rest"
  | "next_rsc_events"
  | "ics"
  | "wordpress_ajax_events"
  | "timely"
  | "facebook"
  | "linktree"
  | "unknown";

export type SourceDetection = {
  sourceType: DetectedSourceType;
  url: string;
  confidence: "high" | "medium" | "low";
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
    | "fetch_failed"
    | "no_event_source";
  pagesInspected: number;
  discoveredEventPages: DiscoveredEventPage[];
  detections: SourceDetection[];
  error: string | null;
};

const USER_AGENT =
  "TenderFans Event Harvester/1.0";

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
  return decodeHtml(
    value.replace(/<[^>]*>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(
  raw: string,
  base: string
): string | null {
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
    return new URL(value).hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return "";
  }
}

function sameSite(a: string, b: string): boolean {
  const ah = hostname(a);
  const bh = hostname(b);

  return (
    ah === bh ||
    ah.endsWith(`.${bh}`) ||
    bh.endsWith(`.${ah}`)
  );
}

function discoverLinks(
  html: string,
  pageUrl: string
): Array<{
  url: string;
  text: string;
}> {
  const links = new Map<
    string,
    { url: string; text: string }
  >();

  const anchorPattern =
    /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;

  while ((match = anchorPattern.exec(html))) {
    const url = normalizeUrl(match[2], pageUrl);

    if (!url) {
      continue;
    }

    const text = stripTags(match[3]);

    if (
      EVENT_HINT.test(text) ||
      EVENT_HINT.test(url)
    ) {
      links.set(url, { url, text });
    }
  }

  return [...links.values()];
}

function pushDetection(
  detections: SourceDetection[],
  detection: SourceDetection
) {
  const existing = detections.find(
    (item) =>
      item.sourceType === detection.sourceType &&
      item.url === detection.url
  );

  if (!existing) {
    detections.push(detection);
  }
}

function inspectPage(
  html: string,
  pageUrl: string,
  detections: SourceDetection[]
) {
  const lower = html.toLowerCase();

  if (
    /eventbrite\.com\/(?:o|e)\//i.test(html) ||
    /eventbrite/i.test(html)
  ) {
    pushDetection(detections, {
      sourceType: "eventbrite_organizer",
      url: pageUrl,
      confidence: "medium",
      supported: true,
      evidence: ["Eventbrite reference found in page HTML"],
    });
  }

  if (
    /Go Daddy Website Builder/i.test(html) &&
    /data-aid=["']MENU_CATEGORY_/i.test(html)
  ) {
    pushDetection(detections, {
      sourceType: "godaddy_menu_recurring",
      url: pageUrl,
      confidence: "high",
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
      supported: true,
      evidence: [
        "CP Multi View Calendar plugin signature",
        "CP Multi View Calendar runtime configuration",
      ],
    });
  }

  if (
    /\?format=ical\b/i.test(html) ||
    /text\/calendar/i.test(html)
  ) {
    pushDetection(detections, {
      sourceType: "squarespace_events",
      url: pageUrl,
      confidence: "high",
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
      tribeUrl = new URL(
        "/wp-json/tribe/events/v1/events",
        pageUrl
      ).toString();
    } catch {
      // Keep page URL as evidence if URL construction fails.
    }

    pushDetection(detections, {
      sourceType: "tribe_rest",
      url: tribeUrl,
      confidence: "high",
      supported: true,
      evidence: ["The Events Calendar / Tribe signature"],
    });
  }

  if (
    /self\.__next_f\.push/i.test(html) &&
    (
      /"startDate"/i.test(html) ||
      /"startTime"/i.test(html) ||
      /"isDraft"/i.test(html)
    )
  ) {
    pushDetection(detections, {
      sourceType: "next_rsc_events",
      url: pageUrl,
      confidence: "medium",
      supported: true,
      evidence: [
        "Next.js RSC payload with event-like fields",
      ],
    });
  }

  if (
    /wp-admin\/admin-ajax\.php/i.test(html) &&
    /get_events/i.test(html)
  ) {
    pushDetection(detections, {
      sourceType: "wordpress_ajax_events",
      url: pageUrl,
      confidence: "high",
      supported: false,
      evidence: [
        "WordPress AJAX event endpoint signature",
      ],
    });
  }

  if (
    /timely/i.test(html) &&
    (
      /calendar/i.test(lower) ||
      /events/i.test(lower)
    )
  ) {
    pushDetection(detections, {
      sourceType: "timely",
      url: pageUrl,
      confidence: "medium",
      supported: false,
      evidence: ["Timely calendar signature"],
    });
  }
}

async function fetchHtml(url: string): Promise<{
  ok: boolean;
  status: number;
  url: string;
  html: string;
}> {
  const response = await fetch(url, {
    headers: {
      Accept:
        "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
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
  websiteUrl: string
): Promise<SiteDetectionResult> {
  const detections: SourceDetection[] = [];
  let homepage;

  try {
    homepage = await fetchHtml(websiteUrl);
  } catch (error) {
    return {
      websiteUrl,
      fetchedUrl: null,
      status: "fetch_failed",
      pagesInspected: 0,
      discoveredEventPages: [],
      detections: [],
      error:
        error instanceof Error
          ? error.message
          : String(error),
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
          : "fetch_failed",
      pagesInspected: 1,
      discoveredEventPages: [],
      detections: [],
      error: `Homepage returned HTTP ${homepage.status}`,
    };
  }

  inspectPage(
    homepage.html,
    homepage.url,
    detections
  );

  const homeHost = hostname(homepage.url);

  if (
    homeHost === "facebook.com" ||
    homeHost.endsWith(".facebook.com")
  ) {
    pushDetection(detections, {
      sourceType: "facebook",
      url: homepage.url,
      confidence: "high",
      supported: false,
      evidence: ["Spot website points to Facebook"],
    });
  }

  if (
    homeHost === "linktr.ee" ||
    homeHost.endsWith(".linktr.ee")
  ) {
    pushDetection(detections, {
      sourceType: "linktree",
      url: homepage.url,
      confidence: "high",
      supported: false,
      evidence: ["Spot website points to Linktree"],
    });
  }

  const candidateLinks = discoverLinks(
    homepage.html,
    homepage.url
  )
    .filter((link) =>
      sameSite(link.url, homepage.url) ||
      /eventbrite\.com/i.test(link.url)
    )
    .slice(0, 6);

  const discoveredEventPages: DiscoveredEventPage[] =
    candidateLinks.map((link) => ({
      url: link.url,
      linkText: link.text,
      sameSite: sameSite(link.url, homepage.url),
      fetched: false,
      httpStatus: null,
      finalUrl: null,
      htmlBytes: null,
    }));

  let pagesInspected = 1;

  for (const link of candidateLinks) {
    const discovered = discoveredEventPages.find(
      (page) => page.url === link.url
    );
    if (link.url === homepage.url) {
      continue;
    }

    if (/eventbrite\.com\/o\//i.test(link.url)) {
      pushDetection(detections, {
        sourceType: "eventbrite_organizer",
        url: link.url,
        confidence: "high",
        supported: true,
        evidence: [
          "Direct Eventbrite organizer link discovered",
        ],
      });
      continue;
    }

    if (/eventbrite\.com\/e\//i.test(link.url)) {
      pushDetection(detections, {
        sourceType: "eventbrite_organizer",
        url: link.url,
        confidence: "medium",
        supported: true,
        evidence: [
          "Direct Eventbrite event link discovered",
        ],
      });
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

      inspectPage(
        page.html,
        page.url,
        detections
      );
    } catch {
      // Individual discovery-page failures do not fail the site scan.
    }
  }

  return {
    websiteUrl,
    fetchedUrl: homepage.url,
    status:
      detections.length > 0
        ? "detected"
        : "no_event_source",
    pagesInspected,
    discoveredEventPages,
    detections,
    error: null,
  };
}
