import type { MetadataRoute } from "next";
import { supabase } from "@/lib/supabase";

const BASE_URL = "https://tenderfans.com";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const [
    bartenderResult,
    venueResult,
  ] = await Promise.all([
    supabase
      .from("bartenders")
      .select("slug, created_at")
      .eq("status", "active")
      .order("created_at", { ascending: false }),

    supabase
      .from("venues")
      .select("slug, created_at")
      .eq("status", "active")
      .order("created_at", { ascending: false }),
  ]);

  if (bartenderResult.error) {
    console.error(
      "Sitemap Tender load failed:",
      bartenderResult.error
    );
  }

  if (venueResult.error) {
    console.error(
      "Sitemap Spot load failed:",
      venueResult.error
    );
  }

  const staticPages: MetadataRoute.Sitemap = [
    {
      url: BASE_URL,
      lastModified: now,
      changeFrequency: "daily",
      priority: 1,
    },
    {
      url: `${BASE_URL}/discover`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.9,
    },
    {
      url: `${BASE_URL}/how-it-works`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/events`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/contest`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/partners`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.6,
    },
  ];

  const tenderPages: MetadataRoute.Sitemap =
    (bartenderResult.data ?? [])
      .filter((tender) => tender.slug)
      .map((tender) => ({
        url: `${BASE_URL}/t/${tender.slug}`,
        lastModified: tender.created_at
          ? new Date(tender.created_at)
          : now,
        changeFrequency: "weekly" as const,
        priority: 0.8,
      }));

  const spotPages: MetadataRoute.Sitemap =
    (venueResult.data ?? [])
      .filter((spot) => spot.slug)
      .map((spot) => ({
        url: `${BASE_URL}/s/${spot.slug}`,
        lastModified: spot.created_at
          ? new Date(spot.created_at)
          : now,
        changeFrequency: "weekly" as const,
        priority: 0.8,
      }));

  return [
    ...staticPages,
    ...tenderPages,
    ...spotPages,
  ];
}
