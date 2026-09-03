"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import BartenderCard from "@/components/BartenderCard";
import type { Bartender } from "@/lib/mock-data";
import { supabase } from "@/lib/supabase";

export default function TrendingTenders() {
  const [bartenders, setBartenders] = useState<Bartender[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadTrendingTenders() {
      const { data: bartenderRows, error: bartenderError } = await supabase
        .from("bartenders")
        .select("id, slug, display_name")
        .eq("status", "active");

      if (bartenderError) {
        console.error("Trending tenders:", bartenderError);
        setLoading(false);
        return;
      }

      const { data: venueRows, error: venueError } = await supabase
        .from("bartender_venues")
        .select(`
          bartender_id,
          venue_id,
          is_primary,
          venues(
            slug,
            name,
            city
          )
        `)
        .eq("is_current", true);

      if (venueError) {
        console.error("Trending tender venues:", venueError);
      }

      const { data: photoRows, error: photoError } = await supabase
        .from("media_assets")
        .select("bartender_id, storage_path, created_at")
        .eq("entity_kind", "bartender")
        .eq("media_type", "photo")
        .eq("is_hero", true)
        .eq("status", "published")
        .order("created_at", { ascending: false });

      if (photoError) {
        console.error("Trending tender photos:", photoError);
      }

      const { data: shoutRows, error: shoutError } = await supabase
        .from("shoutouts")
        .select("id, bartender_id")
        .eq("status", "published");

      if (shoutError) {
        console.error("Trending tender shouts:", shoutError);
      }

      const { data: shoutTraitRows, error: shoutTraitError } = await supabase
        .from("shoutout_traits")
        .select("shoutout_id, trait_id");

      if (shoutTraitError) {
        console.error("Trending tender traits:", shoutTraitError);
      }
 
      const { data: traitRows, error: traitError } = await supabase
        .from("traits")
        .select("id, label")
        .eq("active", true);

      if (traitError) {
        console.error("Trending tender trait labels:", traitError);
      }

      const shoutCounts = new Map<string, number>();

      for (const shout of shoutRows ?? []) {
        shoutCounts.set(
          shout.bartender_id,
          (shoutCounts.get(shout.bartender_id) ?? 0) + 1
        );
      }

      const shoutToBartender = new Map<string, string>();

        for (const shout of shoutRows ?? []) {
          shoutToBartender.set(shout.id, shout.bartender_id);
        }

        const traitLabelMap = new Map<number, string>();

        for (const trait of traitRows ?? []) {
          traitLabelMap.set(trait.id, trait.label);
        }

        const bartenderTraitCounts = new Map<string, Map<number, number>>();

        for (const row of shoutTraitRows ?? []) {
          const bartenderId = shoutToBartender.get(row.shoutout_id);

          if (!bartenderId) continue;

          if (!bartenderTraitCounts.has(bartenderId)) {
            bartenderTraitCounts.set(bartenderId, new Map());
          }

          const counts = bartenderTraitCounts.get(bartenderId)!;

          counts.set(
            row.trait_id,
            (counts.get(row.trait_id) ?? 0) + 1
          );
        }

      const photoMap = new Map<string, string>();

      for (const photo of photoRows ?? []) {
        if (
          photo.bartender_id &&
          photo.storage_path &&
          !photoMap.has(photo.bartender_id)
        ) {
          const { data } = supabase.storage
            .from("spot-media")
            .getPublicUrl(photo.storage_path);

          photoMap.set(
            photo.bartender_id,
            data.publicUrl
          );
        }
      }

      const venueMap = new Map<
        string,
        {
          slug: string;
          name: string;
          city: string;
          isPrimary: boolean;
        }[]
      >();

      for (const row of venueRows ?? []) {
        const venueData = (row as any).venues;
        const venue = Array.isArray(venueData) ? venueData[0] : venueData;

        if (!venue) continue;

        const current = venueMap.get(row.bartender_id) ?? [];

        current.push({
          slug: venue.slug,
          name: venue.name,
          city: venue.city ?? "",
          isPrimary: Boolean((row as any).is_primary),
        });

        venueMap.set(row.bartender_id, current);
      }

      for (const [, tenderVenues] of venueMap) {
        tenderVenues.sort(
          (a, b) => Number(b.isPrimary) - Number(a.isPrimary)
        );
      }

      const liveBartenders: Bartender[] = (bartenderRows ?? [])
        .map((bartender: any) => {
          const tenderVenues = venueMap.get(bartender.id) ?? [];
          const primaryVenue =
            tenderVenues.find((venue) => venue.isPrimary) ??
            tenderVenues[0];

          return {
            id: bartender.id,
            slug: bartender.slug,
            name: bartender.display_name,
            venueSlug: primaryVenue?.slug ?? "",
            venueName: primaryVenue?.name ?? "TenderFans",
            city: primaryVenue?.city ?? "",
            venues: tenderVenues,
            cheers: shoutCounts.get(bartender.id) ?? 0,
            claimed: false,
            photo: photoMap.get(bartender.id),
            tags: [...(bartenderTraitCounts.get(bartender.id)?.entries() ?? [])].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([traitId]) => traitLabelMap.get(traitId)).filter((label): label is string => Boolean(label)),
          };
        })
        .sort((a, b) => b.cheers - a.cheers)
        .slice(0, 3);

      setBartenders(liveBartenders);
      setLoading(false);
    }

    loadTrendingTenders();
  }, []);

  return (
    <section className="section home-trending">
      <div className="shell">
        <div className="section-title">
          <div>
            <span className="eyebrow">Trending Tenders</span>
            <h2>People worth knowing behind the bar.</h2>
          </div>

          <Link href="/shout" className="text-link">
            Shout someone out →
          </Link>
        </div>

        {loading ? (
          <p className="muted">Loading Tenders...</p>
        ) : bartenders.length ? (
          <div className="person-grid">
            {bartenders.map((bartender) => (
              <BartenderCard bartender={bartender} key={bartender.id} />
            ))}
          </div>
        ) : (
          <p className="muted">No Tenders to show yet.</p>
        )}
      </div>
    </section>
  );
}
