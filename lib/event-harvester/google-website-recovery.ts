import type { SupabaseClient } from "@supabase/supabase-js";

const DAILY_LIMIT = 10;
const RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000;

type RecoveryMetadata = Record<string, unknown>;

function validWebsite(value: unknown): string | null {
  if (typeof value !== "string") return null;

  try {
    const url = new URL(value.trim());
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname.includes(".")
    )
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export async function recoverMissingGoogleWebsites(
  supabase: SupabaseClient,
) {
  const result = {
    attempted: 0,
    recovered: 0,
    errors: [] as string[],
  };

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  if (!apiKey) {
    result.errors.push("GOOGLE_PLACES_API_KEY is not configured.");
    return result;
  }

  const { data: missing, error: missingError } = await supabase
    .from("venues")
    .select("id")
    .eq("status", "active")
    .is("website_url", null)
    .order("created_at", { ascending: true })
    .limit(1000);

  if (missingError) {
    result.errors.push(missingError.message);
    return result;
  }

  const ids = (missing ?? []).map((venue) => venue.id);
  if (!ids.length) return result;

  const { data: refs, error: refsError } = await supabase
    .from("venue_external_refs")
    .select("venue_id,provider_place_id,metadata")
    .eq("provider", "google_places")
    .in("venue_id", ids);

  if (refsError) {
    result.errors.push(refsError.message);
    return result;
  }

  const now = Date.now();

  const eligible = (refs ?? [])
    .filter((ref) => {
      const metadata = (
        ref.metadata &&
        typeof ref.metadata === "object" &&
        !Array.isArray(ref.metadata)
      )
        ? ref.metadata as RecoveryMetadata
        : {};

      const last = metadata.website_recovery_checked_at;
      const timestamp = typeof last === "string"
        ? Date.parse(last)
        : NaN;

      return !Number.isFinite(timestamp) ||
        now - timestamp >= RETRY_INTERVAL_MS;
    })
    .sort((a, b) => {
      const checked = (ref: typeof a) => {
        const metadata = ref.metadata as RecoveryMetadata | null;
        const value = metadata?.website_recovery_checked_at;
        const timestamp = typeof value === "string"
          ? Date.parse(value)
          : NaN;
        return Number.isFinite(timestamp) ? timestamp : 0;
      };

      return checked(a) - checked(b);
    })
    .slice(0, DAILY_LIMIT);

  for (const ref of eligible) {
    result.attempted += 1;

    const metadata: RecoveryMetadata = (
      ref.metadata &&
      typeof ref.metadata === "object" &&
      !Array.isArray(ref.metadata)
    )
      ? { ...(ref.metadata as RecoveryMetadata) }
      : {};

    metadata.website_recovery_checked_at = new Date().toISOString();

    try {
      const response = await fetch(
        `https://places.googleapis.com/v1/places/${encodeURIComponent(ref.provider_place_id)}`,
        {
          headers: {
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": "websiteUri",
          },
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
        },
      );

      if (!response.ok) {
        throw new Error(`Google Places HTTP ${response.status}`);
      }

      const place = await response.json();
      const website = validWebsite(place.websiteUri);

      if (website) {
        const { data: updated, error: updateError } = await supabase
          .from("venues")
          .update({ website_url: website })
          .eq("id", ref.venue_id)
          .eq("status", "active")
          .is("website_url", null)
          .select("id");

        if (updateError) throw updateError;

        if ((updated?.length ?? 0) > 0) {
          result.recovered += 1;
          metadata.website_recovery_pending_detection = true;
        }
      }
    } catch (error) {
      result.errors.push(
        `${ref.venue_id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const { error: trackingError } = await supabase.rpc(
      "record_google_website_recovery",
      {
        p_venue_id: ref.venue_id,
        p_checked_at: metadata.website_recovery_checked_at,
        p_pending_detection:
          metadata.website_recovery_pending_detection === true,
      },
    );

    if (trackingError) {
      result.errors.push(
        `${ref.venue_id}: ${trackingError.message}`,
      );
    }
  }

  return result;
}

export async function getRecoveredWebsitePriorityIds(
  supabase: SupabaseClient,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("venue_external_refs")
    .select("venue_id")
    .eq("provider", "google_places")
    .contains("metadata", {
      website_recovery_pending_detection: true,
    })
    .limit(30);

  if (error) throw new Error(error.message);

  return (data ?? []).map((ref) => ref.venue_id);
}

export async function clearRecoveredWebsitePriority(
  supabase: SupabaseClient,
  venueId: string,
) {
  const { error } = await supabase.rpc(
    "clear_google_website_recovery",
    { p_venue_id: venueId },
  );

  if (error) throw new Error(error.message);
}
