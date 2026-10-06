import type { SupabaseClient } from "@supabase/supabase-js";

import {
  loadFirstPartySource,
  previewFirstPartySource,
  type FirstPartyEventPreview,
} from "./preview";

import { eventFingerprint } from "../identity";
import { resolveFirstPartyAttribution } from "./attribution";

export type FirstPartyIngestResult = {
  sourceId: string;
  sourceName: string;
  dryRun: boolean;
  discovered: number;
  processed: number;
  linkedExisting: number;
  graduated: number;
  synced: number;
  needsReview: number;
  events: Array<{
    externalEventId: string;
    title: string;
    startsAt: string;
    candidateId: string | null;
    canonicalEventId: string | null;
    action: "preview" | "linked_existing" | "graduated" | "needs_review";
  }>;
};

function rpcValue<T>(data: unknown): T {
  return data as T;
}

async function ingestEvent(
  supabase: SupabaseClient,
  event: FirstPartyEventPreview,
  bootstrap: boolean,
): Promise<{
  candidateId: string | null;
  canonicalEventId: string | null;
  action: "linked_existing" | "graduated" | "needs_review";
}> {
  const attribution = await resolveFirstPartyAttribution(supabase, event);

  if (attribution.status === "unresolved") {
    const evidence = attribution.publisherEvidence;

    const unresolvedPayload = {
      ...event.rawPayload,
      isAllDay: event.allDay,
      publisherVenueName: attribution.rawVenueName,
      publisherVenueAddress: attribution.rawAddress,
      attributionMethod: "needs_review",
    };

    const { error: unresolvedError } = await supabase.rpc(
      "upsert_event_harvest_unresolved_venue",
      {
        p_source_id: event.sourceId,
        p_external_event_id: event.externalEventId,
        p_source_url: event.sourceUrl,
        p_raw_title: event.title,
        p_raw_starts_at: event.startsAt,
        p_raw_ends_at: event.endsAt,
        p_publisher_venue_name: attribution.rawVenueName,
        p_publisher_address: evidence?.streetAddress ?? attribution.rawAddress,
        p_publisher_city: evidence?.city ?? null,
        p_publisher_state_region: evidence?.stateRegion ?? null,
        p_publisher_postal_code: evidence?.postalCode ?? null,
        p_suggested_venue_id: attribution.suggestedVenueId,
        p_confidence_score: attribution.confidenceScore,
        p_evidence: attribution.evidence,
        p_raw_payload: unresolvedPayload,
      },
    );

    if (unresolvedError) {
      throw new Error(
        `Unresolved venue preservation failed for "${event.title}": ${unresolvedError.message}`,
      );
    }

    return {
      candidateId: null,
      canonicalEventId: null,
      action: "needs_review",
    };
  }

  const resolvedFingerprint = eventFingerprint({
    venueId: attribution.venueId,
    title: event.title,
    startsAt: event.startsAt,
  });

  const harvestPayload = {
    ...event.rawPayload,
    isAllDay: event.allDay,
    publisherVenueName: attribution.rawVenueName,
    publisherVenueAddress: attribution.rawAddress,
    attributionMethod: attribution.method,
  };

  /*
   * Preserve malformed publisher end times as raw provenance, but do
   * not let an equal/earlier end invalidate an otherwise usable event.
   *
   * The start remains authoritative. A later harvest with a corrected
   * publisher end time will flow through normally and replace the null
   * normalized end during first-party synchronization.
   */
  const normalizedEndsAt =
    event.endsAt &&
    new Date(event.endsAt).getTime() > new Date(event.startsAt).getTime()
      ? event.endsAt
      : null;

  const { data: candidateData, error: candidateError } = await supabase.rpc(
    "upsert_event_harvest_candidate",
    {
      p_source_id: event.sourceId,
      p_external_event_id: event.externalEventId,
      p_source_url: event.sourceUrl,
      p_raw_title: event.title,
      p_raw_venue_name: attribution.rawVenueName,
      p_raw_address: attribution.rawAddress,
      p_raw_description: event.description,
      p_raw_starts_at: event.startsAt,
      p_raw_ends_at: event.endsAt,
      p_normalized_title: event.normalizedTitle,
      p_starts_at: event.startsAt,
      p_ends_at: normalizedEndsAt,
      p_venue_id: attribution.venueId,
      p_confidence_score: attribution.confidenceScore,
      p_event_fingerprint: resolvedFingerprint,
      p_raw_payload: harvestPayload,
    },
  );

  if (candidateError) {
    throw new Error(
      `Candidate upsert failed for "${event.title}": ${candidateError.message}`,
    );
  }

  const candidateId = rpcValue<string>(candidateData);

  if (!candidateId) {
    throw new Error(`Candidate upsert returned no ID for "${event.title}".`);
  }

  /*
   * Cross-source dedupe MUST happen before graduation.
   *
   * If Ticketmaster or another source already owns the exact
   * Spot/title/start occurrence, attach this first-party provenance
   * to that canonical event instead of creating a duplicate.
   */
  const { data: linkedData, error: linkedError } = await supabase.rpc(
    "link_harvest_candidate_to_existing_event",
    {
      p_candidate_id: candidateId,
    },
  );

  if (linkedError) {
    throw new Error(
      `Cross-source link failed for "${event.title}": ${linkedError.message}`,
    );
  }

  let canonicalEventId = rpcValue<string | null>(linkedData);
  let action: "linked_existing" | "graduated";

  if (canonicalEventId) {
    action = "linked_existing";
  } else {
    /*
     * Calendar-image extraction may establish the event itself while
     * leaving a critical occurrence fact, such as its calendar date,
     * deterministically inferred from explicit image evidence.
     *
     * Preserve the candidate and route it to the existing event-review
     * lifecycle rather than publishing a new canonical occurrence.
     *
     * Exact cross-source matches above remain authoritative enough to
     * link without creating a new event from the inferred occurrence.
     */
    const eventEvidence =
      event.rawPayload?.eventEvidence;

    const requiresEventReview =
      event.rawPayload?.adapter ===
        "calendar_image" &&
      eventEvidence &&
      typeof eventEvidence ===
        "object" &&
      (
        eventEvidence as {
          requiresReview?: unknown;
        }
      ).requiresReview === true;

    if (requiresEventReview) {
      const {
        error: reviewError,
      } = await supabase.rpc(
        "mark_harvest_candidate_for_review",
        {
          p_candidate_id:
            candidateId,
        },
      );

      if (reviewError) {
        throw new Error(
          `Candidate review routing failed for "${event.title}": ${reviewError.message}`,
        );
      }

      return {
        candidateId,
        canonicalEventId: null,
        action: "needs_review",
      };
    }

    const graduationRpc = bootstrap
      ? "bootstrap_first_party_harvest_candidate"
      : "graduate_harvest_candidate";

    const graduationArgs = bootstrap
      ? {
          p_candidate_id: candidateId,
        }
      : {
          p_candidate_id: candidateId,
          p_reviewed_by: null,
        };

    const { data: graduatedData, error: graduatedError } = await supabase.rpc(
      graduationRpc,
      graduationArgs,
    );

    if (graduatedError) {
      throw new Error(
        `Candidate graduation failed for "${event.title}": ${graduatedError.message}`,
      );
    }

    canonicalEventId = rpcValue<string>(graduatedData);
    action = "graduated";

    if (!canonicalEventId) {
      throw new Error(
        `Candidate graduation returned no event ID for "${event.title}".`,
      );
    }
  }

  /*
   * Refresh first-party provenance and factual lifecycle fields.
   *
   * 053 protects Ticketmaster-linked canonical events here:
   * first-party provenance refreshes, but Ticketmaster's canonical
   * title/time/artwork/lifecycle remains authoritative.
   */
  const { data: syncedData, error: syncedError } = await supabase.rpc(
    "sync_first_party_event",
    {
      p_candidate_id: candidateId,
      p_source_url: event.sourceUrl,
      p_raw_title: event.title,
      p_raw_description: event.description,
      p_raw_starts_at: event.startsAt,
      p_raw_ends_at: event.endsAt,
      p_normalized_title: event.normalizedTitle,
      p_starts_at: event.startsAt,
      p_ends_at: normalizedEndsAt,
      p_event_fingerprint: resolvedFingerprint,
      p_flyer_url: event.flyerUrl,
      p_raw_payload: harvestPayload,
    },
  );

  if (syncedError) {
    throw new Error(
      `First-party sync failed for "${event.title}": ${syncedError.message}`,
    );
  }

  const syncedEventId = rpcValue<string>(syncedData);

  if (syncedEventId !== canonicalEventId) {
    throw new Error(`Canonical event mismatch for "${event.title}".`);
  }

  return {
    candidateId,
    canonicalEventId,
    action,
  };
}

export async function ingestFirstPartySource(
  supabase: SupabaseClient,
  sourceId: string,
  options: {
    dryRun?: boolean;
    limit?: number;
    title?: string;
  } = {},
): Promise<FirstPartyIngestResult> {
  const dryRun = options.dryRun ?? true;

  const source = await loadFirstPartySource(supabase, sourceId);

  /*
   * Source bootstrap state lives in the database.
   *
   * NULL means the source is still loading its initial inventory.
   * Once bootstrapped_at is stamped, all future discoveries use
   * normal publication and notification behavior.
   */
  const bootstrap = source.bootstrapped_at === null;

  /*
   * Absence reconciliation compares candidate last_seen_at against
   * the instant this complete source scan began. Capture this before
   * fetching/parsing so every event observed by this run is newer.
   */
  const scanStartedAt = new Date().toISOString();

  const allPreview = await previewFirstPartySource(source);

  const selectedPreview = options.title
    ? allPreview.filter(
        (event) =>
          event.title.toLowerCase() === options.title!.trim().toLowerCase(),
      )
    : allPreview;

  const preview =
    options.limit === undefined
      ? selectedPreview
      : selectedPreview.slice(0, Math.max(0, options.limit));

  if (dryRun) {
    return {
      sourceId: source.id,
      sourceName: source.name,
      dryRun: true,
      discovered: allPreview.length,
      processed: 0,
      linkedExisting: 0,
      graduated: 0,
      synced: 0,
      needsReview: 0,
      events: preview.map((event) => ({
        externalEventId: event.externalEventId,
        title: event.title,
        startsAt: event.startsAt,
        candidateId: null,
        canonicalEventId: null,
        action: "preview" as const,
      })),
    };
  }

  const result: FirstPartyIngestResult = {
    sourceId: source.id,
    sourceName: source.name,
    dryRun: false,
    discovered: allPreview.length,
    processed: 0,
    linkedExisting: 0,
    graduated: 0,
    synced: 0,
    needsReview: 0,
    events: [],
  };

  for (const event of preview) {
    const ingested = await ingestEvent(supabase, event, bootstrap);

    result.processed += 1;

    if (ingested.action === "needs_review") {
      result.needsReview += 1;
    } else {
      result.synced += 1;

      if (ingested.action === "linked_existing") {
        result.linkedExisting += 1;
      } else {
        result.graduated += 1;
      }
    }

    result.events.push({
      externalEventId: event.externalEventId,
      title: event.title,
      startsAt: event.startsAt,
      candidateId: ingested.candidateId,
      canonicalEventId: ingested.canonicalEventId,
      action: ingested.action,
    });
  }

  /*
   * Only a complete, unfiltered initial run may declare the
   * source bootstrapped. Targeted title/limit runs intentionally
   * leave bootstrapped_at NULL.
   *
   * Reaching this point means every selected event completed
   * candidate upsert, dedupe/graduation and lifecycle sync.
   */
  const completeInitialRun =
    bootstrap &&
    allPreview.length > 0 &&
    options.title === undefined &&
    options.limit === undefined &&
    preview.length === allPreview.length &&
    result.needsReview === 0;

  if (completeInitialRun) {
    const { error: bootstrapError } = await supabase.rpc(
      "mark_first_party_source_bootstrapped",
      {
        p_source_id: source.id,
      },
    );

    if (bootstrapError) {
      throw new Error(
        `Could not mark first-party source bootstrapped: ${bootstrapError.message}`,
      );
    }
  }

  /*
   * Only an unfiltered, unlimited, successfully completed source run
   * is evidence that an existing candidate was absent.
   *
   * Bootstrap runs establish initial inventory and do not reconcile
   * disappearance. Normal complete runs do.
   */
  const completeNormalRun =
    !bootstrap &&
    allPreview.length > 0 &&
    options.title === undefined &&
    options.limit === undefined &&
    result.needsReview === 0;

  if (completeNormalRun) {
    const { error: reconcileError } = await supabase.rpc(
      "reconcile_first_party_source_absences",
      {
        p_source_id: source.id,
        p_scan_started_at: scanStartedAt,
      },
    );

    if (reconcileError) {
      throw new Error(
        `Could not reconcile first-party source absences: ${reconcileError.message}`,
      );
    }
  }

  return result;
}
