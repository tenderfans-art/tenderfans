import type { SupabaseClient } from "@supabase/supabase-js";
import tzLookup from "tz-lookup";
import { getSpotExecutionSignal } from "./transport-capacity-context";

/** Shared occurrence context, derived from the attributed Spot rather than an adapter. */
export function createOccurrenceEvidenceLookup(supabase: SupabaseClient) {
  const cache = new Map<string, Promise<{ version: number; timeZone: string } | null>>();
  return (venueId: string) => {
    let pending = cache.get(venueId);
    if (!pending) {
      pending = (async () => {
        const parent = getSpotExecutionSignal();
        try {
          const deadline = AbortSignal.timeout(5000);
          const signal = parent ? AbortSignal.any([parent, deadline]) : deadline;
          const { data, error } = await supabase.from("venues")
            .select("latitude,longitude").eq("id", venueId).abortSignal(signal).maybeSingle();
          parent?.throwIfAborted();
          if (error || !data || typeof data.latitude !== "number" ||
            typeof data.longitude !== "number" || !Number.isFinite(data.latitude) ||
            !Number.isFinite(data.longitude) || Math.abs(data.latitude) > 90 ||
            Math.abs(data.longitude) > 180) return null;
          const timeZone = tzLookup(data.latitude, data.longitude);
          new Intl.DateTimeFormat("en-US", { timeZone });
          return { version: 1, timeZone };
        } catch {
          parent?.throwIfAborted();
          // Missing context disables additional matching; it never changes
          // attribution, source classifications or the existing exact identity.
          return null;
        }
      })();
      cache.set(venueId, pending);
    }
    return pending;
  };
}
