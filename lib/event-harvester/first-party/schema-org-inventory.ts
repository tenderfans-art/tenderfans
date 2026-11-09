type StructuredEvent = Record<string, unknown>;

function normalizedUrl(
  value: unknown,
  base: string,
): URL | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const url = new URL(value, base);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }

    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url;
  } catch {
    return null;
  }
}

function eventIdentifiesPage(
  event: StructuredEvent,
  pageUrl: string,
): boolean {
  const page = normalizedUrl(pageUrl, pageUrl);
  if (!page) return false;

  const mainEntity = event.mainEntityOfPage;
  const mainEntityUrl =
    typeof mainEntity === "string"
      ? mainEntity
      : mainEntity &&
          typeof mainEntity === "object" &&
          !Array.isArray(mainEntity)
        ? (mainEntity as Record<string, unknown>)["@id"] ??
          (mainEntity as Record<string, unknown>).url
        : null;

  for (const identity of [
    event["@id"],
    event.url,
    mainEntityUrl,
  ]) {
    const target = normalizedUrl(identity, pageUrl);

    if (
      target &&
      target.origin === page.origin &&
      target.pathname === page.pathname
    ) {
      return true;
    }
  }

  return false;
}

function distinctEventKey(
  event: StructuredEvent,
  pageUrl: string,
): string {
  const identity =
    normalizedUrl(event["@id"], pageUrl) ??
    normalizedUrl(event.url, pageUrl);

  if (identity) return `url:${identity.href}`;

  return JSON.stringify([
    event.name ?? null,
    event.startDate ?? null,
    event.endDate ?? null,
  ]);
}

/*
 * A structured Event is not automatically a harvest Source.
 *
 * Source identity requires evidence of a publishing inventory,
 * not simply the presence of one event's detail document.
 *
 * This is generic Schema.org classification. No website paths,
 * Spot identities, domain names, or provider-specific exceptions.
 */
export function isSchemaOrgInventoryPage(
  events: readonly StructuredEvent[],
  html: string,
  pageUrl: string,
): boolean {
  if (events.length === 0) return false;

  const identities = new Set(
    events.map(event =>
      distinctEventKey(event, pageUrl)
    ),
  );

  if (identities.size > 1) {
    return true;
  }

  /*
   * A single event cannot establish a source by itself.
   * Require explicit collection metadata.
   */
  const collectionMetadata =
    /"@type"\s*:\s*(?:"(?:CollectionPage|ItemList)"|\[[^\]]*"(?:CollectionPage|ItemList)"[^\]]*\])/i
      .test(html);

  if (!collectionMetadata) return false;

  /*
   * Even collection metadata must not promote a page whose
   * Event explicitly identifies the page as its own detail URL.
   */
  return !events.some(event =>
    eventIdentifiesPage(event, pageUrl)
  );
}
