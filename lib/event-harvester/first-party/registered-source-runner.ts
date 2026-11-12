import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestFirstPartySource } from "./ingest";
import { getSpotExecutionSignal } from "../transport-capacity-context";
import { runWithTransportRecovery } from
  "../transport-recovery-context";

export type RegisteredFirstPartySource = {
  id: string;
  name: string;
  venue_id: string | null;
  source_type: string;
  source_url: string | null;
};

type MarketWork = {
  workId: string;
  leaseToken: string;
};

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Unknown first-party harvester error.";
}

/*
 * Reuse the existing enabled/registered source gate.
 * No alternative source discovery or source ownership logic.
 */
export async function loadRegisteredFirstPartySource(
  supabase: SupabaseClient,
  sourceId: string,
): Promise<RegisteredFirstPartySource> {
  const { data, error } = await supabase
    .from("event_harvest_sources")
    .select("id,name,venue_id,source_type,source_url")
    .eq("id", sourceId)
    .eq("provider", "first_party")
    .eq("is_enabled", true)
    .maybeSingle();

  if (error || !data) {
    throw new Error(
      "Could not load enabled first-party source: " +
      (error?.message ?? sourceId),
    );
  }

  return data as RegisteredFirstPartySource;
}

/*
 * One shared execution wrapper for:
 *   - legacy scheduled first-party harvesting
 *   - Market Workflow first-party harvesting
 *
 * The existing ingestion engine owns source execution locks,
 * candidate writes, event attribution and reconciliation.
 *
 * Market Workflows additionally pass their existing work and
 * lease tokens into that engine. No new ingestion mechanism.
 */
export async function runRegisteredFirstPartySource(
  supabase: SupabaseClient,
  source: RegisteredFirstPartySource,
  options: { marketWork?: MarketWork } = {},
): Promise<Awaited<ReturnType<typeof ingestFirstPartySource>>> {
  const checkedAt = new Date().toISOString();
  getSpotExecutionSignal()?.throwIfAborted();

  const { error: checkedError } = await supabase
    .from("event_harvest_sources")
    .update({
      last_checked_at: checkedAt,
      updated_at: checkedAt,
    })
    .eq("id", source.id);

  if (checkedError) {
    throw new Error(
      `Could not record source check: ${checkedError.message}`,
    );
  }

  let result: Awaited<ReturnType<typeof ingestFirstPartySource>>;

  try {
    const ingest = () => ingestFirstPartySource(
      supabase,
      source.id,
      {
        dryRun: false,
        ...(options.marketWork
          ? { marketWork: options.marketWork }
          : {}),
      },
    );

    const proxyUrl =
      process.env.TENDERFANS_TRANSPORT_PROXY_URL;

    result = proxyUrl
      ? await runWithTransportRecovery(proxyUrl, ingest)
      : await ingest();
  } catch (ingestError) {
    const message = safeError(ingestError);

    /*
     * Preserve the established calendar-image technical
     * Adapter Error classification. Content qualification
     * remains in its existing review path.
     */
    const technicalCalendarFailure =
      /calendar.image page returned HTTP \d+/i.test(message) ||
      /calendar image asset could not be fetched as a supported image/i
        .test(message);

    if (
      source.source_type === "calendar_image" &&
      source.venue_id &&
      source.source_url &&
      technicalCalendarFailure
    ) {
      const { error: findingError } = await supabase.rpc(
        "upsert_event_harvest_detector_finding",
        {
          p_venue_id: source.venue_id,
          p_category: "adapter_error",
          p_finding_key:
            `adapter_error:${JSON.stringify([
              "calendar_image",
              source.source_url,
            ])}`,
          p_detector_status: "adapter_failed",
          p_source_type: "calendar_image",
          p_website_url: source.source_url,
          p_source_url: source.source_url,
          p_fetched_url: null,
          p_confidence: null,
          p_evidence: [
            "Registered calendar-image source failed during ingestion",
          ],
          p_error: message,
        },
      );

      if (findingError) {
        throw new Error(
          "Calendar-image Adapter Error persistence failed: " +
          findingError.message +
          "; original failure: " + message,
        );
      }
    }

    throw ingestError;
  }

  if (
    source.source_type === "calendar_image" &&
    source.venue_id &&
    source.source_url
  ) {
    const { error: resolutionError } = await supabase.rpc(
      "resolve_event_harvest_adapter_error",
      {
        p_venue_id: source.venue_id,
        p_finding_key:
          `adapter_error:${JSON.stringify([
            "calendar_image",
            source.source_url,
          ])}`,
      },
    );

    if (resolutionError) {
      throw new Error(
        "Calendar-image Adapter Error resolution failed: " +
        resolutionError.message,
      );
    }
  }

  getSpotExecutionSignal()?.throwIfAborted();
  const succeededAt = new Date().toISOString();

  const { error: successError } = await supabase
    .from("event_harvest_sources")
    .update({
      last_success_at: succeededAt,
      last_error: null,
      updated_at: succeededAt,
    })
    .eq("id", source.id);

  if (successError) {
    throw new Error(
      `Could not record source success: ${successError.message}`,
    );
  }

  return result;
}

/*
 * Callers retain their existing error handling:
 * - Legacy route reports individual source outcomes.
 * - Market executor records a leased work failure.
 * - Source-lock contention / lost lease remains deferred.
 */
export async function recordFirstPartySourceFailure(
  supabase: SupabaseClient,
  sourceId: string,
  error: unknown,
): Promise<string> {
  const message = safeError(error);
  const failedAt = new Date().toISOString();

  const { error: failureRecordError } = await supabase
    .from("event_harvest_sources")
    .update({
      last_error: message,
      updated_at: failedAt,
    })
    .eq("id", sourceId);

  return failureRecordError
    ? `${message} (Could not record source failure: ${failureRecordError.message})`
    : message;
}
