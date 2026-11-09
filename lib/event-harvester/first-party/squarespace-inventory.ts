export function decodeHtmlText(
  value: string
): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&#38;", "&")
    .replaceAll("&#x26;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function decodeHtmlAttribute(
  value: string
): string {
  return decodeHtmlText(value);
}

export function discoverIcalUrls(
  html: string,
  pageUrl: string
): string[] {
  const urls = new Set<string>();

  const pattern =
    /href=["']([^"']+\?format=ical(?:&[^"']*)?)["']/gi;

  for (const match of html.matchAll(pattern)) {
    const href = decodeHtmlAttribute(match[1]);

    try {
      urls.add(new URL(href, pageUrl).href);
    } catch {
      // Ignore malformed links from source markup.
    }
  }

  return [...urls];
}


export function isSquarespaceInventoryPage(
  html: string,
  pageUrl: string,
): boolean {
  const page = new URL(pageUrl);
  const key = (u: URL) =>
    u.origin + (u.pathname.replace(/\/+$/, "") || "/");

  const links = new Set(
    discoverIcalUrls(html, pageUrl).map(url => key(new URL(url)))
  );

  if (links.has(key(page))) return false;

  return links.size >= 2 ||
    (links.size === 1 && /\beventlist-event\b/i.test(html));
}
