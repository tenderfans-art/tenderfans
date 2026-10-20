import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchHtml } from "./source-detector";

import {
  searchGoogleVenue,
  recordGoogleSpotDiscovery,
} from "../google-places";

type Identity = {
  name: string;
  streetAddress: string;
  city: string;
  stateRegion: string;
  postalCode: string | null;
};

function record(
  value: unknown,
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function field(value: unknown): string {
  return typeof value === "string"
    ? value.trim()
    : "";
}

/*
 * Discover explicitly structured business identities.
 *
 * A business appearing on an event page is NOT automatically
 * the publishing Spot. These identities are suggestions
 * for Spot Review only.
 *
 * Do not use Event.location, navigation text, page titles,
 * corporate hostnames, or Website/Organization branding
 * as proof of source ownership.
 */
function businessIdentities(html: string): Identity[] {
  const identities: Identity[] = [];
  const seen = new Set<string>();

  const businessTypes = new Set([
    "localbusiness",
    "restaurant",
    "barorpub",
    "nightclub",
    "foodestablishment",
    "cafeorcoffeeshop",
    "bakery",
    "brewery",
    "winery",
    "hotel",
    "lodgingbusiness",
    "eventvenue",
    "entertainmentbusiness",
    "sportsbar",
    "fastfoodrestaurant",
    "distillery",
    "musicvenue",
  ]);

  function collect(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }

    if (!record(value)) return;

    const rawTypes = Array.isArray(value["@type"])
      ? value["@type"]
      : [value["@type"]];

    const types = rawTypes
      .filter((item): item is string =>
        typeof item === "string"
      )
      .map((item) =>
        item.split(/[\/#]/).pop()?.toLowerCase() ?? ""
      );

    if (types.some((type) => businessTypes.has(type))) {
      const rawAddress = value.address;

      const address = record(rawAddress)
        ? rawAddress
        : Array.isArray(rawAddress)
          ? rawAddress.find(record)
          : null;

      if (address) {
        const identity: Identity = {
          name: field(value.name),
          streetAddress: field(address.streetAddress),
          city: field(address.addressLocality),
          stateRegion: field(address.addressRegion),
          postalCode:
            field(address.postalCode) || null,
        };

        /*
         * Require both an actual business name and
         * a complete street/city/state identity.
         * Google must still independently qualify it.
         */
        if (
          identity.name &&
          identity.streetAddress &&
          identity.city &&
          identity.stateRegion
        ) {
          const key = JSON.stringify(
            Object.values(identity).map((part) =>
              String(part ?? "").toLowerCase()
            )
          );

          if (!seen.has(key)) {
            seen.add(key);
            identities.push(identity);
          }
        }
      }
    }

    for (const key of [
      "@graph",
      "mainEntity",
      "mainEntityOfPage",
    ]) {
      if (value[key] !== undefined) {
        collect(value[key]);
      }
    }
  }

  const scripts = html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json(?:\s*;\s*charset=[^"']+)?["'][^>]*>([\s\S]*?)<\/script>/gi
  );

  for (const match of scripts) {
    try {
      collect(JSON.parse(match[1]));
    } catch {
      // Malformed structured data is not identity evidence.
    }
  }


  /*
   * Event-specific business references in ordinary HTML or
   * FAQ JSON-LD. These are candidate Spot identities only.
   *
   * A physical event location does not establish ownership
   * of the publishing event source.
   *
   * Deliberately exclude navigation/footer content. The
   * corporate directory must not create unrelated Spots.
   */
  const mainMatch = html.match(
    /<main\b[^>]*>([\s\S]*?)<\/main>/i
  );

  const content = mainMatch?.[1] ?? "";

  const faqAnswers: string[] = [];

  const scriptsForFaq = html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi
  );

  function collectFaq(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(collectFaq);
      return;
    }

    if (!record(value)) return;

    if (
      value["@type"] === "Answer" &&
      typeof value.text === "string"
    ) {
      faqAnswers.push(value.text);
    }

    for (const child of Object.values(value)) {
      if (
        child !== null &&
        typeof child === "object"
      ) {
        collectFaq(child);
      }
    }
  }

  for (const script of scriptsForFaq) {
    try {
      collectFaq(JSON.parse(script[1]));
    } catch {
      // Invalid FAQ data cannot contribute evidence.
    }
  }

  function plainText(markup: string): string {
    return markup
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&#0*39;|&apos;/gi, "'")
      .replace(/&rsquo;|&#8217;/gi, "’")
      .replace(/&quot;/gi, '"')
      .replace(/\s+/g, " ")
      .trim();
  }

  /*
   * Keep event-content statements separate. Flattening all of
   * <main> into one string lets unrelated FAQ answers merge.
   *
   * Only explicit business-at-address references qualify.
   * Navigation and corporate location directories remain excluded.
   */
  const blockMarkup = content
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(?:p|div|section|article|li|h[1-6]|br|tr|td|dd|dt)>/gi, "\n")
    .replace(/<br\b[^>]*\/?>/gi, "\n");

  const statements = [
    ...blockMarkup.split(/\n+/).map(plainText),
    ...faqAnswers.flatMap((answer) =>
      answer
        .replace(/<br\b[^>]*\/?>/gi, "\n")
        .replace(/<\/(?:p|div|li)>/gi, "\n")
        .split(/\n+/)
        .map(plainText)
    ),
  ].filter(Boolean);

  /*
   * Anchor extraction to an explicit spatial reference.
   * A name cannot contain another address, FAQ marker,
   * or sentence boundary.
   */
  const referencePattern =
    /\b(?:in front of|behind|inside|outside|next to|adjacent to|at)\s+((?:(?!\b\d{1,6}\s+[\p{L}.'’-]+\s+(?:St\.?|Street|Ave\.?|Avenue|Blvd\.?|Boulevard|Rd\.?|Road|Dr\.?|Drive)\b)[^.!?:\n]){3,100}?)\s+at\s+(\d{1,6}\s+[\p{L}\p{N}.'’ -]{2,75}?\s+(?:Street|St\.?|Avenue|Ave\.?|Boulevard|Blvd\.?|Road|Rd\.?|Drive|Dr\.?|Lane|Ln\.?|Parkway|Pkwy\.?|Way))\s*,\s*([A-Za-z][A-Za-z .'-]{1,50}?)(?=\s*(?:,?\s+[A-Z]{2}\b|[.;!?]|$))/giu;

  for (const statement of statements) {
    for (const match of statement.matchAll(referencePattern)) {
      const name = match[1]
        .trim()
        .replace(/^(?:the|a|an)\s+/i, "");

      const streetAddress = match[2].trim();
      const city = match[3].trim();

      if (
        !name ||
        !streetAddress ||
        !city ||
        /\d/.test(name) ||
        /(?:^|\s)(?:Q\d+|A\d+)\b/i.test(name) ||
        /(?:\bQ\d+\b|\bA\d+\b)/i.test(city) ||
        /[?:]/.test(name) ||
        name.length > 90 ||
        city.length > 45
      ) {
        continue;
      }

      const remainingText =
        statement.slice(match.index + match[0].length);

      const stateMatch = remainingText.match(
        /^\s*,?\s*([A-Z]{2})(?:\s+(\d{5}(?:-\d{4})?))?\b/
      );

      const identity: Identity = {
        name,
        streetAddress,
        city,
        stateRegion: stateMatch?.[1] ?? "",
        postalCode: stateMatch?.[2] ?? null,
      };

      const key = [
        name,
        streetAddress,
        city,
      ].join("|").toLowerCase();

      if (!seen.has(key)) {
        seen.add(key);
        identities.push(identity);
      }
    }
  }

  return identities;
}

export async function discoverCorporateHtmlSpots(
  supabase: SupabaseClient,
  sourceUrl: string,
): Promise<void> {
  const page = await fetchHtml(sourceUrl);

  if (!page.ok) {
    console.warn(
      "[corporate-spot-discovery] fetch failed",
      { sourceUrl, status: page.status },
    );
    return;
  }

  const identities = businessIdentities(page.html);

  console.info(
    "[corporate-spot-discovery] extracted",
    {
      sourceUrl,
      count: identities.length,
      identities,
    },
  );

  /*
   * Cap independent Google searches per source.
   * Excessive identities are ambiguous; don't pick
   * an arbitrary subset and imply completeness.
   */
  if (identities.length > 8) {
    console.warn(
      "Corporate HTML Spot discovery skipped: " +
      "too many structured business identities",
      sourceUrl,
      identities.length,
    );
    return;
  }

  for (const identity of identities) {
    try {
      const google = await searchGoogleVenue(
        identity,
        { allowReviewCandidate: true },
      );

      if (!google) {
        console.info(
          "[corporate-spot-discovery] Google did not qualify",
          { sourceUrl, identity },
        );
        continue;
      }

      /*
       * Always enter the existing Spot Review lifecycle.
       * Do not auto-register or attach source ownership.
       */
      const reviewStatus = await recordGoogleSpotDiscovery(supabase, {
        ...google,
        evidence: {
          ...google.evidence,
          discoveryType: "corporate_html_business",
          discoverySourceUrl: sourceUrl,
          publishedBusinessIdentity: identity,
          requiresSpotReview: true,
          sourceOwnershipVerified: false,
          eventLocationIsNotPublisher: true,
        },
      });

      console.info(
        "[corporate-spot-discovery] Spot Review result",
        {
          sourceUrl,
          business: identity.name,
          placeId: google.place.id,
          reviewStatus,
        },
      );
    } catch (error) {
      console.error(
        "Corporate HTML business discovery failed:",
        sourceUrl,
        identity.name,
        error,
      );
    }
  }
}
