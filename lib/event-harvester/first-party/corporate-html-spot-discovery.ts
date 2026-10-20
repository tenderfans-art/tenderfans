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

  return identities;
}

export async function discoverCorporateHtmlSpots(
  supabase: SupabaseClient,
  sourceUrl: string,
): Promise<void> {
  const page = await fetchHtml(sourceUrl);

  if (!page.ok) return;

  const identities = businessIdentities(page.html);

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

      if (!google) continue;

      /*
       * Always enter the existing Spot Review lifecycle.
       * Do not auto-register or attach source ownership.
       */
      await recordGoogleSpotDiscovery(supabase, {
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
